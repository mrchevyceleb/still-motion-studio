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
    for i, node in enumerate(doc.get("nodes", [])):
        original = node.get("name", f"Node_{i}")
        node["name"] = safe_name(original, used)
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


def convert(input_path, output_path, options):
    fps = options.get("fps", 30)
    if isinstance(fps, bool) or fps not in (24, 30, 60):
        raise ValueError("Unreal export frame rate must be 24, 30, or 60 fps.")
    root_motion = options.get("rootMotion", "preserve")
    if root_motion not in ("preserve", "extract", "in-place"):
        raise ValueError("Choose preserve, extract, or in-place root motion.")
    retarget = options.get("retarget", "none")
    if retarget not in ("none", "manny", "metahuman"):
        raise ValueError("Choose no retargeting, Manny, or MetaHuman.")
    target_mesh = options.get("targetMesh", "")
    if not isinstance(target_mesh, str) or (target_mesh and not re.fullmatch(r"/(?:Game|Engine|[A-Za-z][A-Za-z0-9_]*)/[A-Za-z0-9_/]+(?:\.[A-Za-z0-9_]+)?", target_mesh)):
        raise ValueError("The target mesh must be an Unreal asset path such as /Game/Characters/MyBody.MyBody.")
    name = safe_name(options.get("name", input_path.stem), set())
    doc, trailing, source_sha = read_glb(input_path)
    if len(doc.get("animations", [])) != 1:
        raise ValueError("Export exactly one animation with the character.")
    if any(c["target"].get("path") == "weights" for c in doc["animations"][0]["channels"]):
        raise ValueError("Animated morph targets are not supported by this export path yet.")
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
    progress("Reading the character, skin weights, and animation", .05)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="still-unreal-") as temporary:
        work = Path(temporary)
        prepared = work / "source.glb"
        aliases = prepare_glb(doc, trailing, prepared)
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
        if any(o.data.shape_keys for o in meshes):
            raise ValueError("Morph-target meshes are not supported yet; export a character without morph targets.")
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
            if i in sample_indices:
                expected_vertices[i] = [(vertices_world(o, True) @ np.array(conversion)[:3, :3].T) for o in meshes]
        ground_trajectory = add_ground_trajectory(entries, sampled, expected_vertices, root_motion)
        progress("Preparing the shared skeleton and materials", .45)
        # Copy vertex groups and mesh topology before unlinking source objects.
        export_meshes = []
        for obj in meshes:
            clone = obj.copy()
            clone.data = obj.data.copy()
            clone.animation_data_clear()
            clone.parent = None
            clone.matrix_world = Matrix.Identity(4)
            clone.data.transform(conversion @ mesh_rest_world[obj.name])
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
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        for obj in export_meshes:
            obj.select_set(True)
        data.pose_position = "REST"
        bpy.ops.export_scene.fbx(filepath=str(work / "character.fbx"), bake_anim=False, **common)
        data.pose_position = "POSE"
        for obj in export_meshes:
            obj.select_set(False)
        bpy.ops.export_scene.fbx(filepath=str(work / "animation.fbx"), bake_anim=True, **common)
        data.pose_position = "REST"
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
        (work / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        importer = Path(__file__).resolve().parents[1] / "scripts" / "unreal_import.py"
        if not importer.is_file():
            raise ValueError("The Unreal import helper is missing from this installation.")
        (work / "import_unreal.py").write_bytes(importer.read_bytes())
        retargeter = importer.with_name("unreal_retarget.py")
        if not retargeter.is_file():
            raise ValueError("The Unreal retarget helper is missing from this installation.")
        (work / "unreal_retarget.py").write_bytes(retargeter.read_bytes())
        (work / "IMPORT.txt").write_text(
            "STILL — UNREAL CHARACTER AND ANIMATION\n\n"
            "AUTOMATIC IMPORT (Unreal 5.8 verified)\n"
            "Extract this ZIP. Enable Python Editor Script Plugin and Editor Scripting Utilities in Unreal.\n"
            "Choose Tools > Execute Python Script and select import_unreal.py in the extracted folder.\n"
            "The helper creates new assets under /Game/Still, assigns the matching skeleton, preserves motion,\n"
            "and restores the previous FBX importer setting. Existing assets are never overwritten.\n\n"
            "MANUAL IMPORT\n"
            "These settings refer to Unreal's legacy FBX dialog. For the verified route, use the automatic helper above.\n"
            "1. Extract this whole ZIP first. Keep textures beside the FBX files.\n"
            "2. Import character.fbx as a Skeletal Mesh. Create a new Skeleton; do not assign the Unreal mannequin Skeleton.\n"
            "   Import scale 1; Convert Scene and Convert Scene Unit ON; Force Front XAxis OFF.\n"
            "   Import Animation OFF; Use T0 As Ref Pose OFF; Update Skeleton Reference Pose OFF.\n"
            "3. Import animation.fbx as Animation and select the Skeleton from step 2.\n"
            f"   Set custom sample rate {fps}, Import Bone Tracks ON, and preserve the exported range.\n"
            f"4. Root-motion mode: {root_motion}. Enable Root Motion is {'ON with first-frame lock' if root_motion == 'extract' else 'OFF'}.\n"
            f"   Retargeting: {retarget}. The helper creates IK Rigs and a retargeter when requested.\n"
            "   Manny/MetaHuman target meshes must already exist in the destination Unreal project.\n"
            "5. Material conversion is basic FBX material support. Check base color, normal, opacity, and other PBR maps in Unreal.\n\n"
            + "\n".join("NOTE: " + w for w in warnings) + "\n", encoding="utf-8")
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(work.rglob("*")):
                if path.is_file() and path != prepared:
                    archive.write(path, path.relative_to(work).as_posix())
        validate_package(output_path)
        output_path.with_suffix(".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        progress("Unreal export package is ready", 1)
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
