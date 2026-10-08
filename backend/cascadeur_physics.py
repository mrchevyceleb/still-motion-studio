"""Native AutoPhysics correction through the user's licensed Cascadeur instance.

This invokes the installed physical solver and bakes its result on an isolated
humanoid proxy. Learned interpolation is disabled; no vendor code or model
weights are copied or redistributed. Only correction deltas return to the
original skeleton.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

from .cascadeur import ROOT, INSTALL, _bridge, _call, _mapping, _proxy_anchors, _world

PROVIDER = {
    "id": "cascadeur_physics", "name": "Cascadeur AutoPhysics", "learned": False,
    "kind": "physics",
    "description": "Installed Cascadeur physical solver with an explicit all-frame bake; original skeleton and skin preserved.",
    "limits": {"maxDuration": 20, "humanoidOnly": True, "earthGravityOnly": True, "requiresFloorContact": True},
}


def _load_runtime():
    runtime = Path(__file__).with_name("cascadeur_runtime.py")
    # Replacing an idle module is safe; replacing a live one would discard the
    # scene ownership needed by cancellation cleanup.
    return _bridge(
        "import importlib.util,sys,json\n"
        "old=sys.modules.get('still_cascadeur_runtime')\n"
        "if old and old._jobs: raise RuntimeError('A native motion job is already active.')\n"
        f"spec=importlib.util.spec_from_file_location('still_cascadeur_runtime',{str(runtime)!r})\n"
        "runtime=importlib.util.module_from_spec(spec);sys.modules[spec.name]=runtime;spec.loader.exec_module(runtime)\n"
        "print('STILL_RESULT:'+json.dumps({'connected':True}))")


def _dense_request(request):
    """Sample full source motion at the installed sample's 30fps, including end."""
    source = request["frames"]
    times = np.asarray([frame["time"] for frame in source], dtype=float)
    if len(times) < 2 or abs(times[0]) > 1e-6 or abs(times[-1] - request["duration"]) > 1e-5 or np.any(np.diff(times) <= 0):
        raise ValueError("AutoPhysics requires a full, ordered source animation including its first and last frame.")
    native_times = np.linspace(0, request["duration"], max(1, round(request["duration"] * 30)) + 1)
    positions = np.asarray([[bone["position"] for bone in frame["pose"]] for frame in source])
    quaternions = np.asarray([[bone["quaternion"] for bone in frame["pose"]] for frame in source])
    count = len(request["rig"]["names"])
    sampled_p = np.empty((len(native_times), count, 3))
    sampled_q = np.empty((len(native_times), count, 4))
    for joint in range(count):
        for axis in range(3):
            sampled_p[:, joint, axis] = np.interp(native_times, times, positions[:, joint, axis])
        sampled_q[:, joint] = Slerp(times, Rotation.from_quat(quaternions[:, joint]))(native_times).as_quat()
    frames = [{"time": float(at), "pose": [
        {"position": sampled_p[i, joint].tolist(), "quaternion": sampled_q[i, joint].tolist(), "scale": [1, 1, 1]}
        for joint in range(count)]} for i, at in enumerate(native_times)]
    return {**request, "anchors": frames}, native_times


def _log_since(path, offset):
    # Native print messages can be huge. Bound reads and never return the log's
    # unrelated user/session metadata to a client or include it in an error.
    if path.stat().st_size < offset:
        raise RuntimeError("Cascadeur rotated its log during the physics job; its solver completion could not be verified.")
    with path.open("rb") as stream:
        stream.seek(offset)
        return stream.read(2_000_000).decode("utf-8", errors="replace")


def _wait_for_solver(path, offset, progress):
    deadline = time.monotonic() + 150
    last_stage = ""
    while time.monotonic() < deadline:
        text = _log_since(path, offset)
        if "Autophysics core finished" in text:
            statuses = re.findall(r"Termination:\s*([A-Z_]+)", text)
            if "Physics corrector solved" not in text or not statuses or "FAILURE" in statuses:
                raise RuntimeError("Cascadeur ended its AutoPhysics pass without a verified converged physical correction.")
            return {"converged": all(status == "CONVERGENCE" for status in statuses),
                    "terminationStatuses": statuses, "correctorSolved": True, "coreFinished": True}
        for stage, amount in [("Secondary motion solved", .63), ("Physics corrector solved", .57), ("Trajectory smoothness solved", .48)]:
            if stage in text:
                if stage != last_stage:
                    progress("Cascadeur: " + stage.lower() + "…", amount)
                    last_stage = stage
                break
        time.sleep(.35)
    raise RuntimeError("Cascadeur AutoPhysics did not finish within 150 seconds. The temporary scene will be removed; try a shorter clip.")


def _from_to(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if min(np.linalg.norm(a), np.linalg.norm(b)) < 1e-9:
        return Rotation.identity()
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    dot = float(np.clip(np.dot(a, b), -1, 1))
    if dot < -1 + 1e-10:
        axis = np.cross(a, np.eye(3)[np.argmin(np.abs(a))])
        return Rotation.from_rotvec(axis / np.linalg.norm(axis) * np.pi)
    return Rotation.from_quat(np.r_[np.cross(a, b), 1 + dot])


def _match_leg(parents, pose, hip, knee, foot, target):
    """Position a two-segment source leg without changing its bone offsets."""
    p, q = _world(parents, pose)
    ankle_rotation = q[foot]
    upper, lower = np.linalg.norm(p[knee] - p[hip]), np.linalg.norm(p[foot] - p[knee])
    delta = np.asarray(target) - p[hip]
    distance = np.linalg.norm(delta)
    if min(upper, lower, distance) < 1e-7:
        return float(np.linalg.norm(p[foot] - target))
    if np.linalg.norm(p[foot] - target) < 1e-6:
        return 0.
    direction = delta / distance
    distance = float(np.clip(distance, abs(upper - lower) + 1e-7, upper + lower - 1e-7))
    reachable = p[hip] + direction * distance
    bend = p[knee] - p[hip]
    bend -= direction * np.dot(bend, direction)
    if np.linalg.norm(bend) < 1e-6:
        bend = q[hip].apply([0., 0., 1.])
        bend -= direction * np.dot(bend, direction)
    if np.linalg.norm(bend) < 1e-6:
        bend = np.cross(direction, np.eye(3)[np.argmin(np.abs(direction))])
    bend /= np.linalg.norm(bend)
    along = (upper * upper + distance * distance - lower * lower) / (2 * distance)
    knee_target = p[hip] + direction * along + bend * np.sqrt(max(0., upper * upper - along * along))

    def set_world(joint, world, rotations):
        parent = parents[joint]
        pose[joint]["quaternion"] = (rotations[parent].inv() * world if parent >= 0 else world).as_quat().tolist()

    set_world(hip, _from_to(p[knee] - p[hip], knee_target - p[hip]) * q[hip], q)
    p, q = _world(parents, pose)
    set_world(knee, _from_to(p[foot] - p[knee], reachable - p[knee]) * q[knee], q)
    p, q = _world(parents, pose)
    set_world(foot, ankle_rotation, q)
    return float(np.linalg.norm(p[foot] - target))


def _retarget_corrections(request, native, before, after, mapping, scale, native_times):
    parents = request["rig"]["parents"]
    nindices = {name: i for i, name in enumerate(native["names"])}
    mapped = {source: nindices[name] for name, source in mapping.items()}
    strength = float(np.clip(request.get("settings", {}).get("strength", .7), 0, 1))
    source_times = np.asarray([frame["time"] for frame in request["frames"]])
    native_p_before = np.asarray([[bone["position"] for bone in frame] for frame in before])
    native_p_after = np.asarray([[bone["position"] for bone in frame] for frame in after])
    pelvis = nindices["pelvis"]
    hip_delta = (native_p_after[:, pelvis] - native_p_before[:, pelvis]) / scale
    root = mapping["pelvis"]
    while parents[root] >= 0:
        root = parents[root]
    corrections = {}
    native_angles = []
    for source, joint in mapped.items():
        q_before = Rotation.from_quat([frame[joint]["quaternion"] for frame in before])
        q_after = Rotation.from_quat([frame[joint]["quaternion"] for frame in after])
        delta = q_after * q_before.inv()
        native_angles.extend(delta.magnitude().tolist())
        sampled = Slerp(native_times, delta)(source_times)
        corrections[source] = Rotation.from_rotvec(sampled.as_rotvec() * strength)
    hip_delta = np.column_stack([np.interp(source_times, native_times, hip_delta[:, axis]) for axis in range(3)]) * strength
    output, source_feet, result_feet, angles = [], [], [], []
    feet = [mapping[name] for name in ("foot_l", "foot_r", "toe_l", "toe_r") if name in mapping]
    source_world = [_world(parents, frame["pose"]) for frame in request["frames"]]
    rest_p, _ = _world(parents, request["rig"]["restPose"])
    legs = []
    for side in ("l", "r"):
        foot_name = "foot_" + side
        hip, knee, foot = (mapping[name + "_" + side] for name in ("thigh", "calf", "foot"))
        toe = mapping.get("toe_" + side, foot)
        # A proxy's rotations alone do not preserve floor contact on another
        # set of limb lengths. Carry its solved foot-position delta too, then
        # reconstruct the source leg with exact original segment lengths.
        native_delta = (native_p_after[:, nindices[foot_name]] - native_p_before[:, nindices[foot_name]]) / scale
        delta = np.column_stack([np.interp(source_times, native_times, native_delta[:, axis]) for axis in range(3)]) * strength
        clearance = max(0., min(rest_p[[foot, toe], 1].min(), min(world[0][[foot, toe], 1].min() for world in source_world)))
        legs.append((hip, knee, foot, toe, delta, clearance))
    target_errors, contact_corrections = [], []
    for f, frame in enumerate(request["frames"]):
        source_p, source_q = source_world[f]
        pose = copy.deepcopy(frame["pose"])
        out_q = []
        for joint, parent in enumerate(parents):
            if joint in corrections:
                world = corrections[joint][f] * source_q[joint]
            else:
                # Unmapped fingers/twists retain their exact source local pose.
                world = out_q[parent] * Rotation.from_quat(pose[joint]["quaternion"]) if parent >= 0 else source_q[joint]
            if joint in corrections:
                pose[joint]["quaternion"] = (out_q[parent].inv() * world if parent >= 0 else world).as_quat().tolist()
            out_q.append(world)
        pose[root]["position"] = (source_p[root] + hip_delta[f]).tolist()
        if strength > 0:
            for hip, knee, foot, toe, delta, clearance in legs:
                positions, _ = _world(parents, pose)
                target = source_p[foot] + delta[f]
                # Preserve the requested foot orientation and keep its toe
                # joint above the same source floor. This is joint contact,
                # not a claim about the mesh's sole thickness.
                required = clearance - min(0., positions[toe, 1] - positions[foot, 1])
                target[1] = max(target[1], required)
                contact_corrections.append(float(np.linalg.norm(target - positions[foot])))
                target_errors.append(_match_leg(parents, pose, hip, knee, foot, target))
        result_p, result_q = _world(parents, pose)
        angles.extend(float((world * original.inv()).magnitude()) for world, original in zip(result_q, source_q))
        output.append({"time": frame["time"], "pose": pose})
        source_feet.extend(source_p[feet, 1].tolist())
        result_feet.extend(result_p[feet, 1].tolist())
    movement = np.linalg.norm(native_p_after - native_p_before, axis=2)
    metrics = {
        "nativeMaxJointChangeCm": float(movement.max()), "nativeMeanJointChangeCm": float(movement.mean()),
        # Ignore sub-0.1mm numerical motion from solving an already static rig.
        "nativeChangedFrames": int(np.count_nonzero(movement.max(axis=1) > .01)),
        "nativeMaxRotationChangeRadians": max(native_angles, default=0.),
        "meanRotationChangeRadians": float(np.mean(angles)), "maxRotationChangeRadians": max(angles, default=0.),
        "maxRootCorrectionMeters": float(np.linalg.norm(hip_delta, axis=1).max()), "strength": strength,
        "footJointMinHeightBeforeMeters": min(source_feet), "footJointMinHeightAfterMeters": min(result_feet),
        "footJointPenetrationBeforeMeters": max(0., -min(source_feet)),
        "footJointPenetrationAfterMeters": max(0., -min(result_feet)),
        "originalBoneLengthsPreserved": True,
        "contactRefinement": {"method": "Original-length two-bone IK to native foot-position deltas and source floor",
                              "maximumTargetErrorMeters": max(target_errors, default=0.),
                              "maximumPositionCorrectionMeters": max(contact_corrections, default=0.)},
    }
    review = []
    if metrics["footJointPenetrationAfterMeters"] > .006:
        review.append("Retargeted foot joint penetration exceeds 6 mm; review contacts or run a contact refinement pass")
    if metrics["footJointPenetrationAfterMeters"] > metrics["footJointPenetrationBeforeMeters"] + .002:
        review.append("Foot joint penetration increased after proxy retargeting")
    if metrics["maxRootCorrectionMeters"] > .02:
        review.append("The physical correction moved the character root more than 2 cm")
    if metrics["maxRotationChangeRadians"] > .35:
        review.append("The physical correction changed a joint orientation more than 20 degrees")
    if max(target_errors, default=0.) > .01:
        review.append("A retargeted foot target could not be reached within 1 cm without changing bone lengths")
    metrics["quality"] = {"requiresReview": bool(review), "reasons": review,
                          "scope": "Native physical correction on a humanoid proxy; not a physical-feasibility or mesh-contact certificate"}
    return output, metrics


def correct_motion(request, progress):
    if request["rig"].get("kind") != "humanoid":
        raise ValueError("Cascadeur AutoPhysics currently requires a named humanoid skeleton.")
    if not 0 < request["duration"] <= 20:
        raise ValueError("Cascadeur AutoPhysics currently accepts clips up to 20 seconds.")
    settings = request.get("settings", {})
    if abs(float(settings.get("gravity", 9.81)) - 9.8) > .02:
        raise ValueError("Native AutoPhysics currently uses Earth gravity (9.8 m/s²). Choose Earth gravity before running it.")
    if not settings.get("floorContact", True):
        raise ValueError("Native AutoPhysics requires floor contacts. Enable Floor Contact before running it.")
    mapping = _mapping(request["rig"]["names"], request["rig"]["parents"], request["rig"]["restPose"])
    install = Path(request.get("runtime", {}).get("installPath") or INSTALL)
    template = install / "samples" / "Cascy.casc"
    log = Path(os.environ.get("LOCALAPPDATA", "")) / "Nekki Limited" / "Cascadeur" / "logs" / "cascadeur_log.log"
    if not template.is_file() or not log.is_file():
        raise RuntimeError("Open your installed Cascadeur with its Cascy sample and scripting bridge before running native AutoPhysics.")
    dense, native_times = _dense_request(request)
    progress("Connecting to the installed Cascadeur physical solver…", .08)
    _load_runtime()
    job = uuid.uuid4().hex
    local = ROOT / ".local" / "cascadeur-jobs"
    local.mkdir(parents=True, exist_ok=True)
    try:
        progress("Preparing an isolated physics rig with learned tools disabled…", .15)
        native = _call("begin_physics", job, str(template))
        if abs(native["gravityMetersPerSecondSquared"] - 9.8) > .02:
            raise RuntimeError("The installed proxy sample uses an unsupported gravity setting.")
        payload, context = _proxy_anchors(dense, native, mapping)
        for index, anchor in enumerate(payload["anchors"]):
            anchor["frame"] = index
        payload["lastFrame"] = len(payload["anchors"]) - 1
        with tempfile.TemporaryDirectory(prefix=job + "-", dir=local) as directory:
            work = Path(directory)
            inputs, baseline, corrected = work / "poses.json", work / "before.json", work / "after.json"
            inputs.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
            progress("Transferring every source frame to the physics rig…", .27)
            # Return only compact metadata over the native bridge. The actual
            # baseline is read from disk; giant console JSON can obscure logs.
            _bridge(f"import still_cascadeur_runtime as runtime,json\nr=runtime.write_anchors({job!r},{str(inputs)!r})\nprint('STILL_RESULT:'+json.dumps({{'frames':r['frames']}}))")
            _call("read_frames", job, str(baseline))
            offset = log.stat().st_size
            progress("Solving balance, contacts, and secondary motion in Cascadeur…", .40)
            _call("start_physics", job)
            solver = _wait_for_solver(log, offset, progress)
            progress("Baking native AutoPhysics to all animation frames…", .69)
            _call("request_physics_bake", job)
            _call("apply_physics_bake", job)
            baked = _call("read_physics_frames", job, str(corrected))
            if "Command: Snap to autophysics" not in _log_since(log, offset):
                raise RuntimeError("Cascadeur did not confirm the physical bake command.")
            before = json.loads(baseline.read_text(encoding="utf-8"))["frames"]
            after = json.loads(corrected.read_text(encoding="utf-8"))["frames"]
            if len(before) != len(native_times) or len(after) != len(native_times) or baked.get("frames") != len(native_times):
                raise RuntimeError("Cascadeur returned an incomplete physical animation.")
            progress("Applying physical corrections to your original skeleton…", .90)
            frames, metrics = _retarget_corrections(request, native, before, after, mapping, context[-1], native_times)
            metrics.update({"engine": "Installed Cascadeur AutoPhysics", "solver": solver,
                            "nativeBake": "All Frames", "nativeFrames": len(after), "outputFrames": len(frames),
                            "nativeFps": 30, "nativeDuration": (len(after) - 1) / 30,
                            "solverGravityMetersPerSecondSquared": native["gravityMetersPerSecondSquared"],
                            "mappedJoints": len(mapping), "learnedToolsEnabled": False})
            if not solver["converged"]:
                metrics["quality"]["requiresReview"] = True
                metrics["quality"]["reasons"].append("At least one native solver stage reached its iteration limit")
            warnings = ["Native AutoPhysics uses the installed humanoid proxy's mass and contact model at Earth gravity (9.8 m/s²). Corrections are retargeted at your chosen strength; unusual body proportions may need refinement.",
                        "Foot-height metrics measure joint centers, not the character's visible mesh or sole. Retargeting cannot guarantee collision-free mesh contact."]
            warnings.extend(metrics["quality"]["reasons"])
            if not metrics["nativeChangedFrames"]:
                warnings.append("The native solver completed and baked, but this motion received no measurable joint-position correction.")
            return {"frames": frames, "provider": PROVIDER, "metrics": metrics, "warnings": warnings}
    finally:
        _call("finish", job)
