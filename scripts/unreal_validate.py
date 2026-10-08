"""Run inside UnrealEditor-Cmd to validate Still FBX exports in a scratch project.

Set STILL_UNREAL_VALIDATION to an absolute JSON config path. The config supplies
cases [{id, characterFbx, animationFbx, expected?}], output, and a fresh runId.
This script never deletes/replaces assets and only creates assets below its own
/Game/StillExportValidation/<runId> namespace. See docs/unreal-export.md.
"""
import json
import math
import os
from pathlib import Path
import re
import traceback

import unreal
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from unreal_import import import_fbx


def vector(value):
    return [float(value.x), float(value.y), float(value.z)]


def transform(value):
    q = value.rotation
    return {"position": vector(value.translation), "quaternion": [float(q.x), float(q.y), float(q.z), float(q.w)],
            "scale": vector(value.scale3d)}


def distance(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def skin_bounds(mesh, modifier, names, vertex_weights, poses):
    """Evaluate all imported vertices using imported bind poses and weights."""
    dynamic, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_from_skeletal_mesh(
        mesh, unreal.DynamicMesh(), unreal.GeometryScriptCopyMeshFromAssetOptions(), unreal.GeometryScriptMeshReadLOD())
    if outcome != unreal.GeometryScriptOutcomePins.SUCCESS:
        raise RuntimeError("Could not read Unreal's imported mesh geometry for skin verification.")
    _, values, gaps = dynamic.get_all_vertex_positions(False)
    positions = [vector(value) for value in values.convert_vector_list_to_array()]
    if gaps or len(positions) != len(vertex_weights):
        raise RuntimeError("Unreal's mesh geometry and skin-weight vertex indices do not align.")
    indices = {name: index for index, name in enumerate(names)}
    influences = [[(indices[name], weight) for name, weight in values] for values in vertex_weights]
    rest = [modifier.get_bone_transform(name, True) for name in names]
    basis = [unreal.Vector(0, 0, 0), unreal.Vector(1, 0, 0), unreal.Vector(0, 1, 0), unreal.Vector(0, 0, 1)]
    result = []
    for pose in poses:
        matrices = []
        for name, reference in zip(names, rest):
            current = pose.get_bone_pose(name, unreal.AnimPoseSpaces.WORLD)
            transformed = [vector(current.transform_location(reference.inverse_transform_location(point))) for point in basis]
            origin = transformed[0]
            matrices.append([[transformed[axis + 1][row] - origin[row] for axis in range(3)] + [origin[row]] for row in range(3)])
        low, high = [math.inf] * 3, [-math.inf] * 3
        for (x, y, z), weights in zip(positions, influences):
            position = [0., 0., 0.]
            for joint, weight in weights:
                for axis, row in enumerate(matrices[joint]):
                    position[axis] += weight * (row[0] * x + row[1] * y + row[2] * z + row[3])
            for axis in range(3):
                low[axis], high[axis] = min(low[axis], position[axis]), max(high[axis], position[axis])
        result.append({"min": low, "max": high, "vertices": len(positions)})
    return result


def validate_case(case, destination):
    expected = case.get("expected", {})
    if isinstance(expected, str):
        expected = json.loads(Path(expected).read_text(encoding="utf-8-sig"))
    assets, paths = import_fbx(case["characterFbx"], destination, fps=expected.get("fps", 30))
    meshes = [asset for asset in assets if isinstance(asset, unreal.SkeletalMesh)]
    if len(meshes) != 1:
        raise RuntimeError("Expected one imported skeletal mesh; got " + str(len(meshes)))
    mesh = meshes[0]
    skeleton = mesh.get_editor_property("skeleton")
    if skeleton is None:
        raise RuntimeError("Imported skeletal mesh has no Skeleton asset.")
    modifier = unreal.SkeletonModifier()
    if not modifier.set_skeletal_mesh(mesh):
        raise RuntimeError("Could not inspect the imported reference skeleton.")
    names = [str(name) for name in modifier.get_all_bone_names()]
    parents = [str(modifier.get_parent_name(name)) for name in names]
    roots = [name for name, parent in zip(names, parents) if parent == "None" or parent not in names]
    rest = [transform(modifier.get_bone_transform(name, True)) for name in names]
    local_rest = [transform(modifier.get_bone_transform(name, False)) for name in names]
    bounds = mesh.get_imported_bounds()
    size = [2 * value for value in vector(bounds.box_extent)]
    weights = unreal.SkinWeightModifier()
    if not weights.set_skeletal_mesh(mesh):
        raise RuntimeError("Could not inspect imported skin weights.")
    vertex_count = weights.get_num_vertices()
    sums, influences, invalid, vertex_weights = [], [], [], []
    for vertex in range(vertex_count):
        values = weights.get_vertex_weights(vertex)
        sums.append(sum(float(weight) for weight in values.values()))
        influences.append(len(values))
        vertex_weights.append([(str(name), float(weight)) for name, weight in values.items()])
        if not values or any(str(name) not in names or not math.isfinite(float(weight)) or weight < 0 for name, weight in values.items()):
            invalid.append(vertex)
    animations, animation_paths = import_fbx(case["animationFbx"], destination, skeleton, expected.get("fps", 30))
    sequences = [asset for asset in animations if isinstance(asset, unreal.AnimSequence)]
    if len(sequences) != 1:
        raise RuntimeError("Expected one imported animation sequence; got " + str(len(sequences)))
    animation = sequences[0]
    if animation.get_editor_property("skeleton") != skeleton:
        raise RuntimeError("Imported animation is not assigned to the character's Skeleton asset.")
    model = animation.get_editor_property("data_model_interface")
    rate = model.get_frame_rate()
    duration = animation.get_play_length()
    options = unreal.AnimPoseEvaluationOptions()
    options.set_editor_property("evaluation_type", unreal.AnimDataEvalType.RAW)
    options.set_editor_property("should_retarget", False)
    options.set_editor_property("extract_root_motion", False)
    options.set_editor_property("incorporate_root_motion_into_pose", True)
    options.set_editor_property("optional_skeletal_mesh", mesh)
    sample_times = expected.get("sampleTimes", [0., duration / 2, duration])
    samples, poses = [], []
    for at in sample_times:
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(animation, min(float(at), duration), options)
        poses.append(pose)
        samples.append({"time": float(at), "world": {name: transform(pose.get_bone_pose(name, unreal.AnimPoseSpaces.WORLD)) for name in names}})
    deformed_bounds = skin_bounds(mesh, modifier, names, vertex_weights, poses)
    for sample, bounds_at_time in zip(samples, deformed_bounds):
        sample["meshBoundsCm"] = bounds_at_time
    root = roots[0] if len(roots) == 1 else None
    root_first = samples[0]["world"][root] if root else None
    root_last = samples[-1]["world"][root] if root else None
    root_enabled = unreal.AnimationLibrary.is_root_motion_enabled(animation)
    root_lock = unreal.AnimationLibrary.get_root_motion_lock_type(animation)
    locked_positions = []
    if root:
        try:
            unreal.AnimationLibrary.set_root_motion_enabled(animation, True)
            unreal.AnimationLibrary.set_root_motion_lock_type(animation, unreal.RootMotionRootLock.ANIM_FIRST_FRAME)
            options.set_editor_property("extract_root_motion", True)
            options.set_editor_property("incorporate_root_motion_into_pose", False)
            for at in sample_times:
                locked = unreal.AnimPoseExtensions.get_anim_pose_at_time(animation, min(float(at), duration), options)
                locked_positions.append(vector(locked.get_bone_pose(root, unreal.AnimPoseSpaces.WORLD).translation))
        finally:
            unreal.AnimationLibrary.set_root_motion_enabled(animation, root_enabled)
            unreal.AnimationLibrary.set_root_motion_lock_type(animation, root_lock)
    report = {
        "id": case["id"], "assets": paths + animation_paths, "mesh": mesh.get_path_name(),
        "skeleton": skeleton.get_path_name(), "animation": animation.get_path_name(),
        "names": names, "parents": parents, "roots": roots, "restWorld": rest, "restLocal": local_rest,
        "boundsOriginCm": vector(bounds.origin), "boundsSizeCm": size,
        "vertices": vertex_count, "skinWeights": {"invalidVertices": invalid, "minSum": min(sums, default=0), "maxSum": max(sums, default=0), "maxInfluences": max(influences, default=0)},
        "animationFrames": model.get_number_of_frames(), "animationKeys": unreal.AnimationLibrary.get_num_keys(animation),
        "fps": rate.numerator / rate.denominator, "duration": duration,
        "boneTracks": [str(name) for name in model.get_bone_track_names()], "samples": samples,
        "rootMotion": {"enabledOnImport": root_enabled,
                       "root": root, "first": root_first, "last": root_last,
                       "translationDistanceCm": distance(root_first["position"], root_last["position"]) if root else None,
                       "rootLockTest": "EnableRootMotion + AnimFirstFrame; original import settings restored",
                       "lockedPositionsCm": locked_positions,
                       "lockedRootDriftCm": max((distance(position, locked_positions[0]) for position in locked_positions), default=0.)},
        "checks": {},
    }
    checks = report["checks"]
    checks["oneRoot"] = len(roots) == 1
    checks["weightedMesh"] = vertex_count > 0 and not invalid and all(abs(total - 1) < .0001 for total in sums)
    checks["finiteTransforms"] = all(math.isfinite(value) for sample in samples for bone in sample["world"].values() for values in bone.values() for value in values)
    checks["unitBoneScale"] = all(max(abs(value - 1) for value in bone["scale"]) < .001 for sample in samples for bone in sample["world"].values())
    checks["rootMotionLockWorks"] = bool(locked_positions) and report["rootMotion"]["lockedRootDriftCm"] < .01
    by_name = {re.sub(r"[^a-z0-9]", "", name.lower()).replace("mixamorig", ""): bone["position"] for name, bone in zip(names, rest)}
    if all(name in by_name for name in ("leftfoot", "rightfoot", "lefttoebase", "righttoebase", "head", "hips")):
        forward = [(by_name["lefttoebase"][axis] + by_name["righttoebase"][axis] - by_name["leftfoot"][axis] - by_name["rightfoot"][axis]) * .5 for axis in range(3)]
        up = [by_name["head"][axis] - by_name["hips"][axis] for axis in range(3)]
        report["orientation"] = {"footToToeVectorCm": forward, "hipsToHeadVectorCm": up,
                                 "rightMinusLeftFootYCm": by_name["rightfoot"][1] - by_name["leftfoot"][1]}
        checks["facesPositiveX"] = forward[0] > 0 and forward[0] > abs(forward[1])
        checks["uprightPositiveZ"] = up[2] > max(abs(up[0]), abs(up[1]))
        checks["rightIsPositiveY"] = report["orientation"]["rightMinusLeftFootYCm"] > 0
    if expected.get("names"):
        checks["boneNamesMatch"] = set(names) == set(expected["names"])
    if expected.get("parents") and expected.get("names"):
        expected_parents = {name: (expected["names"][parent] if isinstance(parent, int) and parent >= 0 else "None" if parent in (-1, None, "") else str(parent))
                            for name, parent in zip(expected["names"], expected["parents"])}
        checks["hierarchyMatches"] = all(expected_parents.get(name) == parent for name, parent in zip(names, parents))
    if expected.get("restWorld") and expected.get("names"):
        reference = dict(zip(expected["names"], expected["restWorld"]))
        errors = [distance(bone["position"], reference[name]["position"]) for name, bone in zip(names, rest) if name in reference]
        report["restPoseMaxPositionErrorCm"] = max(errors, default=0.)
        checks["restPoseMatches"] = bool(errors) and max(errors) < .1
    if expected.get("samples"):
        errors = []
        for source, actual in zip(expected["samples"], samples):
            for name, bone in source["world"].items():
                if name not in actual["world"]:
                    continue
                errors.append(distance(actual["world"][name]["position"], bone["position"]))
        report["animationMaxPositionErrorCm"] = max(errors, default=0.)
        checks["animationPoseMatches"] = bool(errors) and max(errors) < .1
        bounds_errors = [abs(source["meshBoundsCm"][side][axis] - actual["meshBoundsCm"][side][axis])
                         for source, actual in zip(expected["samples"], samples) if source.get("meshBoundsCm")
                         for side in ("min", "max") for axis in range(3)]
        if bounds_errors:
            report["deformedMeshBoundsMaxErrorCm"] = max(bounds_errors)
            checks["deformedMeshBoundsMatch"] = max(bounds_errors) < .1
    if expected.get("duration") is not None:
        report["durationErrorSeconds"] = abs(duration - expected["duration"])
        checks["durationMatches"] = report["durationErrorSeconds"] < .0001
    if expected.get("heightCm") is not None:
        report["heightErrorCm"] = abs(size[2] - expected["heightCm"])
        checks["heightMatches"] = report["heightErrorCm"] < .1
    report["passed"] = all(checks.values())
    return report


def main():
    config_path = Path(os.environ["STILL_UNREAL_VALIDATION"])
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    run_id = re.sub(r"[^a-zA-Z0-9_]", "_", config["runId"])
    destination = "/Game/StillExportValidation/" + run_id
    report = {"engine": unreal.SystemLibrary.get_engine_version(), "project": unreal.Paths.project_dir(),
              "importer": "FBX legacy via explicit FbxImportUI settings", "cases": [], "errors": []}
    try:
        if unreal.EditorAssetLibrary.does_directory_exist(destination):
            raise RuntimeError("Validation destination already exists; use a fresh runId to preserve previous assets.")
        unreal.SystemLibrary.execute_console_command(None, "Interchange.FeatureFlags.Import.FBX 0")
        for case in config["cases"]:
            label = re.sub(r"[^a-zA-Z0-9_]", "_", case["id"])
            report["cases"].append(validate_case(case, destination + "/" + label))
    except Exception:
        report["errors"].append(traceback.format_exc())
    report["passed"] = bool(report["cases"]) and not report["errors"] and all(case["passed"] for case in report["cases"])
    Path(config["output"]).write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    unreal.log("STILL_UNREAL_VALIDATION:" + json.dumps({"passed": report["passed"], "output": config["output"]}))
    if not report["passed"]:
        raise RuntimeError("Still FBX validation failed. Read the JSON report for measured findings.")


if __name__ == "__main__":
    main()
