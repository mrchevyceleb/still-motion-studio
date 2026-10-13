"""Run with Blender, never the application's Python runtime.

Convert a self-contained, single-character GLB to a pair of matching Unreal FBXs.
All pose sampling occurs before the source scene is removed. Bone rest frames and
vertices are baked into centimeters together; skin weights are copied unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import tempfile
import traceback
import zipfile

import bpy
from mathutils import Matrix, Quaternion, Vector
import numpy as np


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def progress(message, value):
    emit("progress", message=message, progress=value)


def safe_name(value, used):
    base = re.sub(r"[^A-Za-z0-9_]", "_", str(value)).strip("_") or "Joint"
    if base[0].isdigit():
        base = "J_" + base
    base = base[:55]
    candidate, i = base, 1
    while candidate.lower() in used:
        candidate = f"{base}_{i:03d}"
        i += 1
    used.add(candidate.lower())
    return candidate


def read_glb(path):
    content = path.read_bytes()
    if len(content) < 20 or content[:4] != b"glTF" or struct.unpack_from("<I", content, 4)[0] != 2:
        raise ValueError("Unreal export requires a self-contained GLB 2.0 file.")
    length, kind = struct.unpack_from("<II", content, 12)
    if kind != 0x4E4F534A:
        raise ValueError("GLB JSON chunk is missing.")
    doc = json.loads(content[20:20 + length])
    for resource in doc.get("buffers", []) + doc.get("images", []):
        if resource.get("uri") and not resource["uri"].startswith("data:"):
            raise ValueError("GLB contains an external resource; embed all textures and buffers before export.")
    return doc, content[20 + length:], hashlib.sha256(content).hexdigest()


def prepare_glb(doc, trailing, path):
    used, aliases = {"armature"}, []
    joints = {index for skin in doc.get("skins", []) for index in skin["joints"]}
    joints.update(i for i, node in enumerate(doc.get("nodes", [])) if node.get("extras", {}).get("stillJoint"))
    names = {}
    # Reserve bone names before mesh names. Three's FBX loader may already have
    # removed the colon, so handle both mixamorig:Hips and mixamorigHips.
    for i in sorted(joints):
        original = doc["nodes"][i].get("name", f"Node_{i}")
        normalized = re.sub(r"^mixamorig\d*[:_]*", "", original, flags=re.IGNORECASE)
        canonical = safe_name(normalized, set())
        if canonical.lower() in used:
            raise ValueError(f"Joint {original} becomes duplicate Unreal bone {canonical}. Rename the conflicting joint before exporting.")
        names[i] = safe_name(normalized, used)
    for i, node in enumerate(doc.get("nodes", [])):
        original = node.get("name", f"Node_{i}")
        node["name"] = names[i] if i in names else safe_name(original, used)
        node.setdefault("extras", {})["stillExportNodeIndex"] = i
        aliases.append({"node": i, "source": original, "exported": node["name"]})
    raw = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    raw += b" " * ((-len(raw)) % 4)
    path.write_bytes(struct.pack("<4sIIII", b"glTF", 2, 20 + len(raw) + len(trailing), len(raw), 0x4E4F534A) + raw + trailing)
    return aliases


def node_world_matrices(doc):
    parents = {child: i for i, n in enumerate(doc["nodes"]) for child in n.get("children", [])}
    result = {}
    def calculate(i):
        if i in result:
            return result[i]
        n = doc["nodes"][i]
        if "matrix" in n:
            local = Matrix(np.array(n["matrix"]).reshape(4, 4).T.tolist())
        else:
            q = n.get("rotation", [0, 0, 0, 1])
            local = Matrix.LocRotScale(Vector(n.get("translation", [0, 0, 0])), Quaternion((q[3], *q[:3])), Vector(n.get("scale", [1, 1, 1])))
        result[i] = calculate(parents[i]) @ local if i in parents else local
        return result[i]
    for i in range(len(doc["nodes"])):
        calculate(i)
    return result


def rigid_matrix(matrix, label):
    location, rotation, scale = matrix.decompose()
    values = np.array(matrix, dtype=float)
    rebuilt = np.array(Matrix.LocRotScale(location, rotation, scale), dtype=float)
    if not np.isfinite(values).all() or min(scale) <= 0:
        raise ValueError(f"{label}: mirrored, zero, or nonfinite transforms cannot be exported safely.")
    if max(scale) - min(scale) > max(scale) * 3e-4 or np.max(np.abs(values - rebuilt)) > max(1.0, np.max(np.abs(values))) * 3e-4:
        raise ValueError(f"{label}: nonuniform scale or shear needs to be applied before Unreal export.")
    return Matrix.LocRotScale(location, rotation, Vector((1, 1, 1))), float(sum(scale) / 3)


def vertices_world(obj, evaluated=False):
    target = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()) if evaluated else obj
    coordinates = np.empty(len(target.data.vertices) * 3, dtype=np.float64)
    target.data.vertices.foreach_get("co", coordinates)
    coordinates = coordinates.reshape(-1, 3)
    world = np.array(target.matrix_world, dtype=float)
    result = coordinates @ world[:3, :3].T + world[:3, 3]
    if not len(result) or not np.isfinite(result).all():
        raise ValueError(f"Mesh {obj.name} has empty or nonfinite vertex coordinates.")
    return result


def set_frame(value):
    floor = math.floor(value)
    bpy.context.scene.frame_set(floor, subframe=value - floor)
    bpy.context.view_layer.update()


def validate_package(path):
    # Reading the central directory and every CRC also detects truncated output.
    with zipfile.ZipFile(path) as archive:
        required = {"character.fbx", "animation.fbx", "manifest.json", "import_unreal.py", "unreal_retarget.py", "IMPORT.txt"}
        if not required.issubset(archive.namelist()):
            raise ValueError("The Unreal archive is missing required files.")
        if any(archive.getinfo(name).file_size == 0 for name in required):
            raise ValueError("The Unreal archive contains an empty required file.")
        damaged = archive.testzip()
        if damaged:
            raise ValueError(f"The Unreal archive failed its integrity check: {damaged}")


def add_ground_trajectory(entries, sampled, expected_vertices, mode):
    """Factor planar travel/yaw into an unweighted root without changing the skin."""
    if mode == "preserve":
        return None
    candidates = [entry for entry in entries if entry["source"] is not None]
    source = next((entry for entry in candidates if re.sub(r"[^a-z]", "", entry["name"].lower()).replace("mixamorig", "") in ("hips", "pelvis")), candidates[0])
    source_name = source["name"]
    root_name = safe_name("RootMotion", {entry["name"].lower() for entry in entries})
    origin = sampled[0][source_name].translation.copy()
    initial_rotation = sampled[0][source_name].to_quaternion()
    trajectory, previous_yaw = [], 0.0
    for index, values in enumerate(sampled):
        delta = values[source_name].to_quaternion() @ initial_rotation.inverted()
        # Swing/twist decomposition retains unwrapped heading through flips.
        # At the exact horizontal half-turn singularity, retain the last heading.
        yaw = 2 * math.atan2(delta.z, delta.w) if math.hypot(delta.z, delta.w) > 1e-7 else previous_yaw
        while yaw - previous_yaw > math.pi:
            yaw -= 2 * math.pi
        while yaw - previous_yaw < -math.pi:
            yaw += 2 * math.pi
        previous_yaw = yaw
        rotation = Matrix.Rotation(yaw, 4, "Z")
        translation = values[source_name].translation - rotation @ origin
        translation.z = 0
        ground = Matrix.Translation(translation) @ rotation
        trajectory.append({"frame": index, "positionCm": [float(translation.x), float(-translation.y), 0.], "yawDegrees": -math.degrees(yaw)})
        if mode == "in-place":
            inverse = ground.inverted()
            for name in list(values):
                values[name] = inverse @ values[name]
            if index in expected_vertices:
                matrix = np.array(inverse, dtype=float)
                expected_vertices[index] = [vertices @ matrix[:3, :3].T + matrix[:3, 3] for vertices in expected_vertices[index]]
            values[root_name] = Matrix.Identity(4)
        else:
            values[root_name] = ground
    for entry in entries:
        if entry["parent"] is None:
            entry["parent"] = root_name
    entries.insert(0, {"name": root_name, "parent": None, "source": None, "kind": "trajectory", "rest": Matrix.Identity(4), "rest_export": Matrix.Identity(4), "rest_scale": 1.})
    return {"bone": root_name, "sourceBone": source_name, "axes": "ground XY translation and unwrapped Z yaw; vertical/body motion stays on the source skeleton", "samples": trajectory}


def write_package(work, output_path, manifest, manual_steps, warnings):
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    importer = Path(__file__).resolve().parents[1] / "scripts" / "unreal_import.py"
    if not importer.is_file():
        raise ValueError("The Unreal import helper is missing from this installation.")
    (work / "import_unreal.py").write_bytes(importer.read_bytes())
    retargeter = importer.with_name("unreal_retarget.py")
    if not retargeter.is_file():
        raise ValueError("The Unreal retarget helper is missing from this installation.")
    (work / "unreal_retarget.py").write_bytes(retargeter.read_bytes())
    manual_steps = ["Extract this whole ZIP first. Keep textures beside the FBX files."] + list(manual_steps)
    (work / "IMPORT.txt").write_text(
        "STILL — UNREAL CHARACTER AND ANIMATION\n\n"
        "AUTOMATIC IMPORT (Unreal 5.8 verified)\n"
        "Extract this ZIP. Enable Python Editor Script Plugin and Editor Scripting Utilities in Unreal.\n"
        "Choose Tools > Execute Python Script and select import_unreal.py in the extracted folder.\n"
        "The helper creates new assets under /Game/Still, uses your existing skeleton when specified,\n"
        "and restores the previous FBX importer setting. Existing assets are never overwritten.\n\n"
        "MANUAL IMPORT\n"
        "These settings refer to Unreal's legacy FBX dialog. For the verified route, use the automatic helper above.\n"
        + "\n".join(f"{i}. {step}" for i, step in enumerate(manual_steps, 1)) + "\n\n"
        + "\n".join("NOTE: " + w for w in warnings) + "\n", encoding="utf-8")
    prepared = work / "source.glb"
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(work.rglob("*")):
            if path.is_file() and path != prepared:
                archive.write(path, path.relative_to(work).as_posix())
    validate_package(output_path)
    output_path.with_suffix(".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    progress("Unreal export package is ready", 1)


def umeyama(source, target):
    """Similarity transform (scale, rotation, offset) that best maps source points onto target points."""
    src, dst = np.asarray(source, dtype=float), np.asarray(target, dtype=float)
    mean_s, mean_d = src.mean(0), dst.mean(0)
    xs, xd = src - mean_s, dst - mean_d
    u, d, vt = np.linalg.svd(xd.T @ xs / len(src))
    sign = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[2, 2] = -1
    rotation = u @ sign @ vt
    scale = float(np.trace(np.diag(d) @ sign) / ((xs ** 2).sum() / len(src)))
    return scale, rotation, mean_d - scale * rotation @ mean_s


def reference_axes(path):
    """Axis strings that make Blender's FBX exporter write the reference file's own GlobalSettings."""
    try:
        from io_scene_fbx import parse_fbx
        from io_scene_fbx.fbx_utils import RIGHT_HAND_AXES
        from io_scene_fbx.import_fbx import elem_find_first, elem_props_get_integer
        root, _ = parse_fbx.parse(str(path))
        props = elem_find_first(elem_find_first(root, b"GlobalSettings"), b"Properties70")
        key = tuple((elem_props_get_integer(props, axis, default), elem_props_get_integer(props, axis + b"Sign", 1))
                    for axis, default in ((b"UpAxis", 2), (b"FrontAxis", 1), (b"CoordAxis", 0)))
        up, forward = {v: k for k, v in RIGHT_HAND_AXES.items()}[key]
        return forward, up
    except Exception:
        return "-Y", "Z"


def bone_key(value):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^mixamorig\d*[:_]*", "", str(value), flags=re.IGNORECASE).lower())


def export_onto_reference(reference, entries, sampled, ground_trajectory, root_motion, scene, work, name, intervals, warnings):
    """Key the reference character's own armature so Unreal plays the clip on the
    Skeleton it already imported from that FBX: same bone names, rest frames and
    hierarchy, so no retarget step can drift the pose."""
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.fbx(filepath=str(reference), use_anim=False, ignore_leaf_bones=False, automatic_bone_orientation=False)
    armatures = [o for o in scene.objects if o.type == "ARMATURE"]
    if len(armatures) != 1:
        raise ValueError("The character FBX must contain exactly one skeleton.")
    arm = armatures[0]
    for obj in list(scene.objects):
        if obj is not arm:
            bpy.data.objects.remove(obj, do_unlink=True)
    arm.animation_data_clear()
    # A connected child ignores its own location, which would drop pelvis travel under a root bone.
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for edit_bone in arm.data.edit_bones:
        edit_bone.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    bones = sorted(arm.data.bones, key=lambda b: len(b.parent_recursive))
    rest = {b.name: b.matrix_local.copy() for b in bones}
    still = {bone_key(e["name"]): e for e in entries if e["kind"] in ("bone", "empty")}
    matched = {b.name: still[bone_key(b.name)]["name"] for b in bones if bone_key(b.name) in still}
    if len(matched) < 4:
        raise ValueError(f"Only {len(matched)} bones of the character FBX match the character in Still. Load that same FBX into Still, animate it, then export.")
    unit_cm = arm.matrix_world.to_scale().x * 100
    rest_still = {e["name"]: e["rest_export"] for e in entries}
    scale, rotation, offset = umeyama([list(rest_still[s].translation) for s in matched.values()], [list(rest[r].translation) for r in matched])
    turn = Matrix(rotation.tolist()).to_4x4()
    to_reference = Matrix.Translation(Vector(offset.tolist())) @ turn @ Matrix.Scale(scale, 4)
    place = lambda point: Vector((scale * rotation @ np.array(point) + offset).tolist())
    rest_error = max((place(rest_still[s].translation) - rest[r].translation).length for r, s in matched.items()) * unit_cm
    if rest_error > .5:
        raise ValueError(f"The character in Still is {rest_error:.2f} cm away from the FBX's rest pose. Load the same FBX into Still without editing its rest pose, then export again.")
    correction = {r: (turn @ rest_still[s].to_3x3().to_4x4()).inverted() @ rest[r].to_3x3().to_4x4() for r, s in matched.items()}
    roots = [b for b in bones if b.parent is None]
    pelvis = ground_trajectory["sourceBone"] if ground_trajectory else next((e["name"] for e in entries if bone_key(e["name"]) in ("hips", "pelvis")), None)
    # A root above the pelvis (Unreal's usual "root") carries ground motion, whether or not Still's copy has it.
    dedicated_root = len(roots) == 1 and matched.get(roots[0].name) != pelvis and bone_key(roots[0].name) not in ("hips", "pelvis")
    if root_motion == "extract" and not dedicated_root:
        warnings.append(f"{roots[0].name} is the top bone of this skeleton, so there is no root bone for Unreal to extract ground motion into. Travel stays on {roots[0].name}, the same as Preserve. Give the character a root bone above the pelvis to use Extract.")
        root_motion = "preserve"
    trajectory = ground_trajectory["bone"] if ground_trajectory else None
    unmatched = [b.name for b in bones if b.name not in matched and not (b.parent is None and dedicated_root)]
    if unmatched:
        warnings.append("These bones are not in Still and follow their parent at rest: " + ", ".join(unmatched[:12]) + ("…" if len(unmatched) > 12 else ""))
    frames = []
    for values in sampled:
        posed = {}
        for b in bones:
            if b.name in matched:
                world = values[matched[b.name]]
                posed[b.name] = Matrix.Translation(place(world.translation)) @ turn @ world.to_3x3().to_4x4() @ correction[b.name]
            elif b.parent is None:
                posed[b.name] = rest[b.name]
            if b.parent is None and dedicated_root and trajectory and root_motion == "extract":
                posed[b.name] = to_reference @ values[trajectory] @ to_reference.inverted() @ posed[b.name]
            if b.name in posed:
                continue
            posed[b.name] = posed[b.parent.name] @ rest[b.parent.name].inverted() @ rest[b.name]
        frames.append(posed)
    for i, posed in enumerate(frames):
        for b in bones:
            pose_bone = arm.pose.bones[b.name]
            pose_bone.rotation_mode = "QUATERNION"
            rest_local = rest[b.parent.name].inverted() @ rest[b.name] if b.parent else rest[b.name]
            parent = posed[b.parent.name] if b.parent else Matrix.Identity(4)
            pose_bone.matrix_basis = rest_local.inverted() @ parent.inverted() @ posed[b.name]
            for path in ("location", "rotation_quaternion", "scale"):
                pose_bone.keyframe_insert(path, frame=i, group=b.name)
    arm.animation_data.action.name = name + "_Motion"
    for layer in arm.animation_data.action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"
    scene.frame_start, scene.frame_end = 0, intervals
    # Write the clip in the reference's own units and axes: armature data stays
    # in its file units, and the unit scale carries the import's object scale.
    location, orientation, object_scale = arm.matrix_world.decompose()
    arm.matrix_world = Matrix.LocRotScale(location, orientation, Vector((1, 1, 1)))
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = object_scale.x
    forward, up = reference_axes(reference)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.fbx(filepath=str(work / "animation.fbx"), use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL",
                             global_scale=1.0, axis_forward=forward, axis_up=up, use_space_transform=True, bake_space_transform=False,
                             object_types={"ARMATURE"}, add_leaf_bones=False, use_armature_deform_only=False, armature_nodetype="NULL",
                             primary_bone_axis="Y", secondary_bone_axis="X", bake_anim=True, bake_anim_use_all_bones=True,
                             bake_anim_use_nla_strips=False, bake_anim_use_all_actions=False, bake_anim_force_startend_keying=True,
                             bake_anim_step=1.0, bake_anim_simplify_factor=0.0)
    (work / "character.fbx").write_bytes(Path(reference).read_bytes())
    to_ue = lambda v: [float(v[0] * unit_cm), float(-v[1] * unit_cm), float(v[2] * unit_cm)]
    return {"rootMotion": root_motion, "unitCm": unit_cm, "forward": forward, "up": up, "frames": frames,
            "bones": [{"name": b.name, "parent": b.parent.name if b.parent else None, "restWorldCm": to_ue(rest[b.name].translation)} for b in bones],
            "alignment": {"scale": scale, "restErrorCm": rest_error, "matchedBones": len(matched), "unmatchedBones": unmatched},
            "to_ue": to_ue}


def create_morph_samples(meshes):
    """Keep sampling per mesh until duplicate Unreal curve names are checked."""
    return {obj.name: {key.name: [] for key in obj.data.shape_keys.key_blocks if key != obj.data.shape_keys.reference_key}
            for obj in meshes if obj.data.shape_keys}


def sample_morphs(meshes, samples):
    for obj in meshes:
        for name, values in samples.get(obj.name, {}).items():
            value = float(obj.data.shape_keys.key_blocks[name].value)
            if not math.isfinite(value):
                raise ValueError(f"Morph {obj.name}/{name} has a nonfinite weight.")
            values.append(value)


def bake_morphs(clone, samples, name):
    keys = clone.data.shape_keys
    if keys is None:
        return
    keys.animation_data_clear()
    for key in keys.key_blocks:
        if key == keys.reference_key:
            continue
        for frame, value in enumerate(samples[key.name]):
            key.value = value
            key.keyframe_insert("value", frame=frame, group=key.name)
    if keys.animation_data and keys.animation_data.action:
        keys.animation_data.action.name = name + "_Shapes"
        for layer in keys.animation_data.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"


def morph_manifest(samples, warnings):
    curves, names = {}, {}
    for mesh, shapes in samples.items():
        for name, values in shapes.items():
            # Unreal merges shapes by FName. Different weights cannot share a curve.
            previous = names.setdefault(name.lower(), name)
            if previous != name or (name in curves and any(abs(a - b) > 1e-6 for a, b in zip(curves[name], values))):
                raise ValueError(f"Morph {mesh}/{name} conflicts with another mesh's Unreal morph curve. Use distinct shape names or matching weights.")
            curves[name] = values
    if not curves:
        return {}
    warnings.append(f"Exported {len(curves)} morph targets with sampled weight curves in animation.fbx. Enable Import Morph Targets on the character and import animation curves; Unreal morph validation is pending.")
    return {"morphTargets": list(curves), "morphCurves": curves}


def reset_morph_weights(meshes):
    for obj in meshes:
        if obj.data.shape_keys:
            for key in obj.data.shape_keys.key_blocks:
                if key != obj.data.shape_keys.reference_key:
                    key.value = 0.


def convert(input_path, output_path, options):
    fps = options.get("fps", 30)
    if isinstance(fps, bool) or fps not in (24, 30, 60):
        raise ValueError("Unreal export frame rate must be 24, 30, or 60 fps.")
    root_motion = options.get("rootMotion", "preserve")
    if root_motion not in ("preserve", "extract", "in-place"):
        raise ValueError("Choose preserve, extract, or in-place root motion.")
    retarget = options.get("retarget", "none")
    reference_fbx = options.get("referenceFbx", "") if retarget == "skeleton" else ""
    if retarget == "skeleton":
        # Existing Unreal character: write onto the Skeleton imported from this FBX.
        retarget = "none"
        options = {**options, "targetMesh": options.get("targetSkeleton", options.get("targetMesh", ""))}
        if not options["targetMesh"]:
            raise ValueError("Enter the Unreal Skeleton or SkeletalMesh path of your existing character.")
        if not reference_fbx or not Path(reference_fbx).is_file() or Path(reference_fbx).read_bytes()[:18] != b"Kaydara FBX Binary":
            raise ValueError("Choose the binary FBX your Unreal character was imported from, so Still can match its skeleton exactly.")
    if retarget not in ("none", "manny", "metahuman"):
        raise ValueError("Choose no retargeting, Manny, or MetaHuman.")
    target_mesh = options.get("targetMesh", "")
    if not isinstance(target_mesh, str) or (target_mesh and not re.fullmatch(r"/(?:Game|Engine|[A-Za-z][A-Za-z0-9_]*)/[A-Za-z0-9_/]+(?:\.[A-Za-z0-9_]+)?", target_mesh)):
        raise ValueError("The target must be an Unreal Skeleton or SkeletalMesh asset path such as /Game/Characters/MyBody.MyBody.")
    name = safe_name(options.get("name", input_path.stem), set())
    doc, trailing, source_sha = read_glb(input_path)
    if len(doc.get("animations", [])) != 1:
        raise ValueError("Export exactly one animation with the character.")
    accessors = doc.get("accessors", [])
    animation = doc["animations"][0]
    start = min(float(accessors[s["input"]]["min"][0]) for s in animation["samplers"])
    end = max(float(accessors[s["input"]]["max"][0]) for s in animation["samplers"])
    duration = end - start
    if not 0 < duration <= 600:
        raise ValueError("Animation must have a positive duration of at most ten minutes.")
    requested_fps = fps
    if abs(duration - round(duration * fps) / fps) > 1e-5:
        for alternative in (60, 30, 24):
            if abs(duration - round(duration * alternative) / alternative) <= 1e-5:
                fps = alternative
                break
    intervals = max(1, int(math.floor(duration * fps + 0.5)))
    export_duration = intervals / fps
    warnings = []
    if fps != requested_fps:
        warnings.append(f"Export uses {fps} fps instead of {requested_fps} fps to preserve the exact clip duration and final pose.")
    if abs(export_duration - duration) > 1e-5:
        warnings.append(f"The {duration:.6f}s source was resampled to {export_duration:.6f}s at {fps} fps ({(export_duration-duration)*1000:+.3f} ms). The exact first and last poses are retained.")
    if root_motion == "preserve":
        warnings.append("Movement is preserved on the original skeleton. Enable Root Motion is off by default; a pelvis root may include bobbing, pitch, and roll and is not a dedicated ground trajectory.")
    elif root_motion == "extract":
        warnings.append("A dedicated ground-motion root carries horizontal travel and heading. Body height, pitch and roll remain on the source skeleton; the Unreal helper enables root motion and first-frame root lock.")
    else:
        warnings.append("Horizontal travel and heading are removed for in-place playback. Body height, pitch and roll remain on the source skeleton.")
    if retarget != "none":
        warnings.append(f"The Unreal import helper will retarget to {retarget}. The target SkeletalMesh must already exist in that Unreal project; no Epic character assets are included.")
    elif target_mesh:
        warnings.append(f"The Unreal import helper will import animation only onto {target_mesh}. Its bone names and hierarchy must match; no replacement character is imported.")
    progress("Reading the character, skin weights, and animation", .05)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="still-unreal-") as temporary:
        work = Path(temporary)
        prepared = work / "source.glb"
        aliases = prepare_glb(doc, trailing, prepared)
        if any(a["node"] in {j for skin in doc.get("skins", []) for j in skin["joints"]} and a["source"] != a["exported"] for a in aliases):
            warnings.append("Bone names were made Unreal-compatible. Mixamo prefixes are removed (mixamorig:Hips or mixamorigHips becomes Hips); see boneAliases in manifest.json.")
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete(use_global=False)
        scene = bpy.context.scene
        scene.render.fps = fps
        scene.render.fps_base = 1
        bpy.ops.import_scene.gltf(filepath=str(prepared), guess_original_bind_pose=False, import_scene_as_collection=False)
        # The importer retargets mesh bind data to glTF's declared rest pose.
        # Keeping it unguessed avoids changing authored rest frames heuristically.
        armatures = [o for o in scene.objects if o.type == "ARMATURE"]
        if len(armatures) > 1:
            raise ValueError("This GLB contains multiple independent armatures. Export one character at a time.")
        source_arm = armatures[0] if armatures else None
        meshes = [o for o in scene.objects if o.type == "MESH" and not any(c.hide_render for c in o.users_collection)]
        if not meshes:
            raise ValueError("The character has no visible mesh to export.")
        morph_samples = create_morph_samples(meshes)
        rotation = Matrix.Rotation(math.pi / 2, 4, "Z")
        conversion = Matrix.Scale(100, 4) @ rotation
        gltf_to_blender = Matrix.Rotation(math.pi / 2, 4, "X")
        original_worlds = node_world_matrices(doc)
        mesh_rest_world = {}
        for obj in meshes:
            if obj.matrix_world.determinant() <= 0:
                raise ValueError(f"Mesh {obj.name} has a mirrored or zero transform. Apply it before Unreal export.")
            if any(m.type == "ARMATURE" for m in obj.modifiers):
                mesh_rest_world[obj.name] = obj.matrix_world.copy()
            else:
                index = obj.get("stillExportNodeIndex")
                if index is None:
                    raise ValueError(f"Cannot identify the rest transform of mesh {obj.name}.")
                mesh_rest_world[obj.name] = gltf_to_blender @ original_worlds[index] @ gltf_to_blender.inverted()
        entries = []
        if source_arm:
            for b in source_arm.data.bones:
                entries.append({"name": b.name, "parent": b.parent.name if b.parent else None, "source": b, "rest": source_arm.matrix_world @ b.matrix_local, "kind": "bone"})
        bone_names = {e["name"] for e in entries}
        extra_joints = [o for o in scene.objects if o.type == "EMPTY" and o.get("stillJoint")]
        all_names = bone_names | {o.name for o in extra_joints}
        for obj in extra_joints:
            parent = obj.parent
            parent_name = obj.parent_bone if obj.parent_type == "BONE" else None
            while parent and not parent_name:
                if parent.name in all_names:
                    parent_name = parent.name
                    break
                if parent.parent_type == "BONE":
                    parent_name = parent.parent_bone
                    break
                parent = parent.parent
            node_index = obj.get("stillExportNodeIndex")
            if node_index is None:
                raise ValueError(f"Cannot identify rest transform for joint {obj.name}.")
            entries.append({"name": obj.name, "parent": parent_name, "source": obj, "rest": gltf_to_blender @ original_worlds[node_index] @ gltf_to_blender.inverted(), "kind": "empty"})
        if not entries:
            raise ValueError("The character has no skeleton. Add a rig before exporting to Unreal.")
        # Topological order also makes matrix-to-local conversion deterministic.
        ordered, pending = [], entries[:]
        while pending:
            ready = [e for e in pending if e["parent"] is None or e["parent"] in {x["name"] for x in ordered}]
            if not ready:
                raise ValueError("The source skeleton has an unsupported parent hierarchy.")
            ordered.extend(ready)
            pending = [e for e in pending if e not in ready]
        entries = ordered
        roots = [e for e in entries if e["parent"] is None]
        added_root = len(roots) > 1
        if added_root:
            root_name = safe_name("Root", {e["name"].lower() for e in entries})
            for e in roots:
                e["parent"] = root_name
            entries.insert(0, {"name": root_name, "parent": None, "source": None, "kind": "root", "rest": Matrix.Identity(4)})
            warnings.append("A stationary Root bone joins multiple source roots. Child movement is preserved; enabling Unreal root-motion extraction on this stationary root will not move the actor.")
        for e in entries:
            e["rest_export"], e["rest_scale"] = rigid_matrix(conversion @ e["rest"], e["name"])
        sample_indices = sorted({0, intervals // 2, intervals})
        expected_vertices = {}
        sampled = []
        progress("Baking joint motion in centimeters", .2)
        for i in range(intervals + 1):
            if i and i % max(1, intervals // 5) == 0:
                progress("Baking joint motion in centimeters", .2 + .2 * i / intervals)
            set_frame((start + duration * i / intervals) * fps)
            values = {}
            for e in entries:
                source = e["source"]
                world = source_arm.matrix_world @ source_arm.pose.bones[e["name"]].matrix if e["kind"] == "bone" else source.matrix_world if source else Matrix.Identity(4)
                mat, scale = rigid_matrix(conversion @ world, f"{e['name']} at frame {i}")
                if abs(scale / e["rest_scale"] - 1) > 3e-4:
                    raise ValueError(f"{e['name']}: animated scale is unsupported; apply scale before exporting.")
                values[e["name"]] = mat
            sampled.append(values)
            sample_morphs(meshes, morph_samples)
            if i in sample_indices:
                expected_vertices[i] = [(vertices_world(o, True) @ np.array(conversion)[:3, :3].T) for o in meshes]
        ground_trajectory = add_ground_trajectory(entries, sampled, expected_vertices, root_motion)
        if reference_fbx:
            progress("Writing the animation onto your character's own skeleton", .5)
            skeleton = export_onto_reference(reference_fbx, entries, sampled, ground_trajectory, root_motion, scene, work, name, intervals, warnings)
            root_motion, to_ue = skeleton["rootMotion"], skeleton["to_ue"]
            manifest = {"version": 1, "name": name, "sourceSha256": source_sha, "blenderVersion": bpy.app.version_string,
                        "fbxVersion": struct.unpack_from("<I", (work / "animation.fbx").read_bytes(), 23)[0],
                        "mode": "existing-skeleton", "units": "centimeters", "forward": skeleton["forward"], "up": skeleton["up"],
                        "referenceFbx": {"name": Path(reference_fbx).name, "sha256": hashlib.sha256(Path(reference_fbx).read_bytes()).hexdigest()},
                        "alignment": skeleton["alignment"],
                        "requestedFps": requested_fps, "fps": fps, "frameCount": intervals + 1, "sourceDuration": duration, "duration": export_duration,
                        "timeScale": export_duration / duration, "rootMotion": root_motion, "rootBone": skeleton["bones"][0]["name"],
                        "addedStationaryRoot": False, "enableRootMotionByDefault": root_motion == "extract",
                        "groundTrajectory": ground_trajectory if root_motion != "preserve" else None,
                        "retarget": {"mode": "none", "targetMesh": target_mesh},
                        "boneCount": len(skeleton["bones"]), "bones": skeleton["bones"],
                        "samples": [{"time": i / fps, "sourceTime": start + duration * i / intervals,
                                     "worldPositionsCm": {b["name"]: to_ue(skeleton["frames"][i][b["name"]].translation) for b in skeleton["bones"]}}
                                    for i in sample_indices],
                        "boneAliases": [a for a in aliases if a["exported"] in {e["name"] for e in entries}],
                        "warnings": warnings,
                        "unrealImport": {"character": "character.fbx", "animation": "animation.fbx", "importUniformScale": 1.0,
                                         "convertScene": True, "convertSceneUnit": True, "forceFrontXAxis": False,
                                         "useT0AsRefPose": False, "updateSkeletonReferencePose": False, "animationSampleRate": fps,
                                         "existingSkeleton": target_mesh, "skipCharacter": True},
                        "compatibility": "Animation-only Blender binary FBX on the reference skeleton. Validate on the destination Unreal version."}
            write_package(work, output_path, manifest, [
                f"Import animation.fbx as Animation and select the existing Skeleton {target_mesh}.\n"
                "   Skip character.fbx; it is the character FBX you gave Still, included for reference.\n"
                "   Use the same Import Uniform Scale, Convert Scene and Force Front XAxis settings your character was imported with.\n"
                f"   Set custom sample rate {fps}, Import Bone Tracks ON, and preserve the exported range.",
                f"Root-motion mode: {root_motion}. Enable Root Motion is {'ON with first-frame lock' if root_motion == 'extract' else 'OFF'}."], warnings)
            return manifest
        progress("Preparing the shared skeleton and materials", .45)
        # Copy vertex groups and mesh topology before unlinking source objects.
        export_meshes = []
        for obj in meshes:
            clone = obj.copy()
            clone.data = obj.data.copy()
            clone.animation_data_clear()
            clone.parent = None
            clone.matrix_world = Matrix.Identity(4)
            clone.data.transform(conversion @ mesh_rest_world[obj.name], shape_keys=True)
            bake_morphs(clone, morph_samples.get(obj.name, {}), name)
            for modifier in list(clone.modifiers):
                clone.modifiers.remove(modifier)
            clone.name = f"{name}_{obj.name}"
            scene.collection.objects.link(clone)
            arm_mods = [m for m in obj.modifiers if m.type == "ARMATURE"]
            if not arm_mods:
                parent_name = obj.parent_bone if obj.parent_type == "BONE" else None
                ancestor = obj.parent
                while ancestor and not parent_name:
                    if ancestor.name in all_names:
                        parent_name = ancestor.name
                    elif ancestor.parent_type == "BONE":
                        parent_name = ancestor.parent_bone
                    ancestor = ancestor.parent
                if not parent_name:
                    raise ValueError(f"Mesh {obj.name} is neither skinned nor attached to a joint.")
                clone.vertex_groups.clear()
                group = clone.vertex_groups.new(name=parent_name)
                group.add(list(range(len(clone.data.vertices))), 1.0, "REPLACE")
            valid_groups = {g.index for g in clone.vertex_groups if g.name in {e["name"] for e in entries}}
            if any(not any(g.group in valid_groups and g.weight > 0 for g in v.groups) for v in clone.data.vertices):
                raise ValueError(f"Mesh {obj.name} has vertices without a valid joint weight.")
            if any(sum(g.group in valid_groups and g.weight > 0 for g in v.groups) > 8 for v in clone.data.vertices):
                raise ValueError(f"Mesh {obj.name} uses more than eight joint weights on a vertex. Reduce influences before Unreal export to avoid import truncation.")
            export_meshes.append(clone)
        for obj in list(scene.objects):
            if obj not in export_meshes:
                bpy.data.objects.remove(obj, do_unlink=True)
        data = bpy.data.armatures.new(name + "_Skeleton")
        arm = bpy.data.objects.new("Armature", data)
        scene.collection.objects.link(arm)
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        for e in entries:
            b = data.edit_bones.new(e["name"])
            b.head = (0, 0, 0)
            b.tail = (0, 1, 0)
            b.matrix = e["rest_export"]
            b.length = max(.1, min(10, (e["rest_export"].translation.length or 10) * .05))
            if e["parent"]:
                b.parent = data.edit_bones[e["parent"]]
            b.use_connect = False
        bpy.ops.object.mode_set(mode="OBJECT")
        if max(np.abs(np.array(data.bones[e["name"]].matrix_local) - np.array(e["rest_export"])).max() for e in entries) > .001:
            raise ValueError("Blender could not preserve the source rest frames.")
        for obj in export_meshes:
            obj.parent = arm
            obj.matrix_parent_inverse = Matrix.Identity(4)
            modifier = obj.modifiers.new("Skin", "ARMATURE")
            modifier.object = arm
        for i, values in enumerate(sampled):
            for e in entries:
                b = arm.pose.bones[e["name"]]
                b.rotation_mode = "QUATERNION"
                parent_world = values[e["parent"]] if e["parent"] else Matrix.Identity(4)
                rest_local = data.bones[e["parent"]].matrix_local.inverted() @ data.bones[e["name"]].matrix_local if e["parent"] else data.bones[e["name"]].matrix_local
                b.matrix_basis = rest_local.inverted() @ parent_world.inverted() @ values[e["name"]]
                b.keyframe_insert("location", frame=i, group=b.name)
                b.keyframe_insert("rotation_quaternion", frame=i, group=b.name)
                b.keyframe_insert("scale", frame=i, group=b.name)
        arm.animation_data.action.name = name + "_Motion"
        for layer in arm.animation_data.action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
        scene.frame_start, scene.frame_end = 0, intervals
        scene.unit_settings.system = "METRIC"
        scene.unit_settings.scale_length = .01
        verification_error = 0.0
        for i in sample_indices:
            set_frame(i)
            for obj, expected in zip(export_meshes, expected_vertices[i]):
                actual = vertices_world(obj, True)
                if actual.shape != expected.shape:
                    raise ValueError("Vertex topology changed during conversion.")
                verification_error = max(verification_error, float(np.linalg.norm(actual - expected, axis=1).max()))
        if verification_error > .05:
            raise ValueError(f"Skin conversion did not preserve the visible motion (maximum vertex error {verification_error:.4f} cm).")
        textures = work / "textures"
        textures.mkdir()
        texture_names = []
        used_texture_names = set()
        for image in bpy.data.images:
            if image.type != "IMAGE":
                continue
            # Packed glTF images are loaded lazily in background Blender.
            # has_data may be false until the pixel buffer is requested.
            if not len(image.pixels):
                raise ValueError(f"Texture {image.name} could not be decoded; export stopped to avoid losing it.")
            image.filepath_raw = str(textures / (safe_name(image.name, used_texture_names) + ".png"))
            image.file_format = "PNG"
            image.save()
            texture_names.append(Path(image.filepath_raw).stem)
        materials = []
        for material in {m for o in export_meshes for m in o.data.materials if m}:
            material_info = {"name": material.name, "baseColor": list(material.diffuse_color), "textures": []}
            if material.use_nodes:
                for node in material.node_tree.nodes:
                    if node.type == "BSDF_PRINCIPLED":
                        material_info["baseColor"] = list(node.inputs["Base Color"].default_value)
                        material_info["roughness"] = float(node.inputs["Roughness"].default_value)
                        material_info["metallic"] = float(node.inputs["Metallic"].default_value)
                    if node.type == "TEX_IMAGE" and node.image and node.image.filepath_raw:
                        material_info["textures"].append({"file": "textures/" + Path(node.image.filepath_raw).name, "colorSpace": node.image.colorspace_settings.name, "usage": node.label or node.name})
            materials.append(material_info)
        if texture_names:
            warnings.append("Texture images are included. FBX material import is basic; verify PBR map connections, opacity, and color space in Unreal using manifest.json.")
        common = dict(use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL", global_scale=1.0,
                      axis_forward="-Y", axis_up="Z", use_space_transform=True, bake_space_transform=False,
                      object_types={"ARMATURE", "MESH"}, add_leaf_bones=False, use_armature_deform_only=False,
                      armature_nodetype="NULL", use_mesh_modifiers=True, mesh_smooth_type="FACE", use_tspace=True,
                      bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=False,
                      bake_anim_force_startend_keying=True, bake_anim_step=1.0, bake_anim_simplify_factor=0.0,
                      path_mode="COPY", embed_textures=False)
        progress("Writing the character and animation FBX files", .75)
        morph_info = morph_manifest(morph_samples, warnings)
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        for obj in export_meshes:
            obj.select_set(True)
        data.pose_position = "REST"
        reset_morph_weights(export_meshes)
        bpy.ops.export_scene.fbx(filepath=str(work / "character.fbx"), bake_anim=False, **common)
        data.pose_position = "POSE"
        for obj in export_meshes:
            obj.select_set(bool(obj.data.shape_keys))
        bpy.ops.export_scene.fbx(filepath=str(work / "animation.fbx"), bake_anim=True, **common)
        data.pose_position = "REST"
        reset_morph_weights(export_meshes)
        bpy.context.view_layer.update()
        bounds = np.concatenate([vertices_world(o, True) for o in export_meshes])
        to_ue = lambda v: [float(v[0]), float(-v[1]), float(v[2])]
        sample_bounds = {}
        for i, arrays in expected_vertices.items():
            coordinates = np.concatenate(arrays) * np.array([1, -1, 1])
            sample_bounds[i] = {"min": coordinates.min(axis=0).tolist(), "max": coordinates.max(axis=0).tolist()}
        manifest = {"version": 1, "name": name, "sourceSha256": source_sha, "blenderVersion": bpy.app.version_string,
                    "fbxVersion": struct.unpack_from("<I", (work / "character.fbx").read_bytes(), 23)[0],
                    "units": "centimeters", "forward": "+X", "up": "+Z", "objectScale": [1, 1, 1],
                    "requestedFps": requested_fps, "fps": fps, "frameCount": intervals + 1, "sourceDuration": duration, "duration": export_duration,
                    "timeScale": export_duration / duration, "rootMotion": root_motion, "rootBone": entries[0]["name"],
                    "addedStationaryRoot": added_root, "enableRootMotionByDefault": root_motion == "extract",
                    "groundTrajectory": ground_trajectory, "retarget": {"mode": retarget, "targetMesh": target_mesh},
                    "boneCount": len(entries), "meshCount": len(export_meshes), "vertexCount": len(bounds),
                    "heightCm": float(bounds[:, 2].max() - bounds[:, 2].min()), "skinConversionMaxErrorCm": verification_error,
                    "bones": [{"name": e["name"], "parent": e["parent"], "restWorldCm": to_ue(e["rest_export"].translation)} for e in entries],
                    "samples": [{"time": i / fps, "sourceTime": start + duration * i / intervals,
                                 "meshBoundsCm": sample_bounds[i],
                                 "worldPositionsCm": {e["name"]: to_ue(sampled[i][e["name"]].translation) for e in entries}} for i in sample_indices],
                    "boneAliases": [a for a in aliases if a["exported"] in {e["name"] for e in entries}],
                    "textures": [str(p.relative_to(work)).replace("\\", "/") for p in textures.glob("*")],
                    "materials": sorted(materials, key=lambda item: item["name"]),
                    "warnings": warnings,
                    "unrealImport": {"character": "character.fbx", "animation": "animation.fbx", "importUniformScale": 1.0,
                                     "convertScene": True, "convertSceneUnit": True, "forceFrontXAxis": False,
                                     "useT0AsRefPose": False, "updateSkeletonReferencePose": False, "animationSampleRate": fps},
                    "compatibility": "Blender binary FBX 7400; Unreal documents FBX SDK 2020.2. Validate on the destination Unreal version."}
        manifest.update(morph_info)
        direct_import = retarget == "none" and bool(target_mesh)
        conversion_settings = "Import scale 1; Convert Scene and Convert Scene Unit ON; Force Front XAxis OFF."
        manual_steps = ["Extract this whole ZIP first. Keep textures beside the FBX files."]
        if not direct_import:
            manual_steps.append(
                "Import character.fbx as a Skeletal Mesh. Create a new Skeleton; do not assign the Unreal mannequin Skeleton.\n"
                f"   {conversion_settings}\n"
                "   Import Animation OFF; Use T0 As Ref Pose OFF; Update Skeleton Reference Pose OFF.")
        manual_steps.append(
            (f"Import animation.fbx as Animation and select the existing Skeleton for {target_mesh}.\n"
             "   Skip character.fbx. Bone names and hierarchy must match the target.\n" if direct_import else
             "Import animation.fbx as Animation and select the Skeleton from step 2.\n")
            + f"   {conversion_settings}\n"
            + f"   Set custom sample rate {fps}, Import Bone Tracks ON, and preserve the exported range.")
        manual_steps.append(
            f"Root-motion mode: {root_motion}. Enable Root Motion is {'ON with first-frame lock' if root_motion == 'extract' else 'OFF'}.\n"
            f"   Retargeting: {retarget}. The helper creates IK Rigs and a retargeter when requested.\n"
            "   Manny/MetaHuman target meshes must already exist in the destination Unreal project.")
        manual_steps.append("Material conversion is basic FBX material support. Check base color, normal, opacity, and other PBR maps in Unreal.")
        write_package(work, output_path, manifest, manual_steps[1:], warnings)
        return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--options", default="{}")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    try:
        raw_options = args.options.strip()
        if not raw_options.startswith("{"):
            raw_options = Path(raw_options).read_text(encoding="utf-8-sig")
        options = json.loads(raw_options)
        if not isinstance(options, dict):
            raise ValueError("Export options must be a JSON object.")
        manifest = convert(Path(args.input).resolve(), Path(args.output).resolve(), options)
        emit("result", manifest=manifest, warnings=manifest["warnings"])
    except Exception as error:
        traceback.print_exc()
        emit("error", message=str(error))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
