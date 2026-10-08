"""Local learned inbetweening through the user's installed Cascadeur engine.

The original character is never imported/re-rigged in Cascadeur. Its authored
poses drive an isolated installed humanoid proxy; only motion is retargeted back.
No vendor model files or source packages are redistributed with this adapter.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.request
import uuid

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

ROOT = Path(__file__).resolve().parent.parent
INSTALL = Path(os.environ.get("CASCADEUR_HOME", Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Cascadeur"))
BRIDGE = "http://127.0.0.1:8765"
PROVIDER = {"id": "cascadeur", "name": "Cascadeur AI", "learned": True,
            "description": "Installed Cascadeur learned humanoid inbetweening, using an isolated proxy and preserving your character's skin.",
            "limits": {"maxDuration": 20, "humanoidOnly": True}}

ALIASES = {
    "pelvis": ["hips", "pelvis"], "stomach": ["spine", "spine01"],
    "chest": ["spine2", "spine02", "spine1", "chest", "upperchest"],
    "neck": ["neck", "neck01"], "head": ["head"],
    "clavicle_l": ["leftshoulder", "claviclel", "shoulderl"],
    "clavicle_r": ["rightshoulder", "clavicler", "shoulderr"],
    "arm_l": ["leftarm", "upperarml", "arml"], "arm_r": ["rightarm", "upperarmr", "armr"],
    "forearm_l": ["leftforearm", "lowerarml", "forearml"], "forearm_r": ["rightforearm", "lowerarmr", "forearmr"],
    "hand_l": ["lefthand", "handl"], "hand_r": ["righthand", "handr"],
    "thigh_l": ["leftupleg", "leftupperleg", "thighl"], "thigh_r": ["rightupleg", "rightupperleg", "thighr"],
    "calf_l": ["leftleg", "leftlowerleg", "calfl", "shinl"], "calf_r": ["rightleg", "rightlowerleg", "calfr", "shinr"],
    "foot_l": ["leftfoot", "footl", "anklel"], "foot_r": ["rightfoot", "footr", "ankler"],
    "toe_l": ["lefttoebase", "balll", "toel"], "toe_r": ["righttoebase", "ballr", "toer"],
}
REQUIRED = {"pelvis", "head", "arm_l", "arm_r", "forearm_l", "forearm_r", "hand_l", "hand_r",
            "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r"}


def _clean(name):
    return re.sub(r"[^a-z0-9]", "", name.rsplit(":", 1)[-1].lower()).replace("mixamorig", "")


def _mapping(names, parents=None, rest_pose=None):
    cleaned = [_clean(name) for name in names]
    rest_positions = _world(parents, rest_pose)[0] if parents is not None and rest_pose is not None else None
    mapping = {}
    for native, aliases in ALIASES.items():
        for alias in aliases:
            matches = [i for i, name in enumerate(cleaned) if name == alias]
            if len(matches) > 1:
                # FBX may wrap each skinned bone in a same-named zero-length
                # transform. Accept only a coincident ancestor chain and use its
                # distal bone; unrelated duplicate names remain ambiguous.
                candidate = max(matches)
                ancestors = {candidate}
                parent = parents[candidate] if parents is not None else -1
                while parent >= 0:
                    ancestors.add(parent)
                    parent = parents[parent]
                coincident = rest_positions is not None and all(np.linalg.norm(rest_positions[i] - rest_positions[candidate]) < 1e-5 for i in matches)
                if not set(matches).issubset(ancestors) or not coincident:
                    raise ValueError(f"Cascadeur AI needs unambiguous joint names; multiple unrelated joints match {alias}.")
                matches = [candidate]
            if matches:
                mapping[native] = matches[0]
                break
    missing = REQUIRED - mapping.keys()
    if missing:
        raise ValueError("Cascadeur AI needs a named humanoid skeleton. Missing: " + ", ".join(sorted(missing)))
    if len(set(mapping.values())) != len(mapping):
        raise ValueError("Cascadeur AI could not resolve distinct joints for this humanoid.")
    return mapping


def _world(parents, pose):
    positions, rotations = [], []
    for i, parent in enumerate(parents):
        local = Rotation.from_quat(pose[i]["quaternion"])
        offset = np.asarray(pose[i]["position"], dtype=float)
        if parent < 0:
            positions.append(offset)
            rotations.append(local)
        else:
            positions.append(positions[parent] + rotations[parent].apply(offset))
            rotations.append(rotations[parent] * local)
    return np.asarray(positions), rotations


def _bridge(code):
    payload = json.dumps({"code": code}).encode()
    request = urllib.request.Request(BRIDGE + "/run", data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            result = json.load(response)
    except (OSError, urllib.error.URLError) as error:
        raise RuntimeError("The local Cascadeur scripting bridge is unavailable. Open Cascadeur and start Scripts → MCP → Script Server, then retry.") from error
    messages = result.get("messages", [])
    errors = [str(message.get("text", "")) for message in messages if str(message.get("level", "")).lower() in ("error", "fatal")]
    if not result.get("ok") or errors:
        detail = result.get("error") or "; ".join(errors)
        raise RuntimeError("Cascadeur did not complete the motion operation: " + str(detail))
    for message in reversed(messages):
        text = str(message.get("text", ""))
        if text.startswith("STILL_RESULT:"):
            return json.loads(text[len("STILL_RESULT:"):])
    raise RuntimeError("Cascadeur returned no verified operation result.")


def _call(operation, *args):
    encoded = ",".join(repr(arg) for arg in args)
    return _bridge(f"import still_cascadeur_runtime as runtime,json\nprint('STILL_RESULT:'+json.dumps(runtime.{operation}({encoded})))")


def _proxy_anchors(request, native, mapping):
    parents = request["rig"]["parents"]
    rest_p, rest_q = _world(parents, request["rig"]["restPose"])
    nr_p = np.asarray([p["position"] for p in native["restWorld"]])
    nr_q = [Rotation.from_quat(p["quaternion"]) for p in native["restWorld"]]
    names, nparents = native["names"], native["parents"]
    pelvis = names.index("pelvis")
    src_hips = mapping["pelvis"]
    source_height = np.linalg.norm(rest_p[mapping["head"]] - (rest_p[mapping["foot_l"]] + rest_p[mapping["foot_r"]]) * .5)
    native_height = np.linalg.norm(nr_p[names.index("head")] - (nr_p[names.index("foot_l")] + nr_p[names.index("foot_r")]) * .5)
    if source_height < .05:
        raise ValueError("The humanoid rest pose has no usable height.")
    scale = native_height / source_height
    native_local_p, native_local_q = [], []
    for i, parent in enumerate(nparents):
        native_local_p.append(nr_p[i] if parent < 0 else nr_q[parent].inv().apply(nr_p[i] - nr_p[parent]))
        native_local_q.append(nr_q[i] if parent < 0 else nr_q[parent].inv() * nr_q[i])
    anchors = []
    native_frame = 0
    previous_time = 0.
    for anchor in request["anchors"]:
        # The learned model supports 120 frames per interval. Longer intervals
        # are inferred at that limit, then smoothly retimed to the authored times.
        native_frame += min(120, round((anchor["time"] - previous_time) * 30))
        previous_time = anchor["time"]
        positions, rotations = _world(parents, anchor["pose"])
        out_p, out_q = [], []
        for i, name in enumerate(names):
            parent = nparents[i]
            src = mapping.get(name)
            rotation = rotations[src] * rest_q[src].inv() * nr_q[i] if src is not None else (out_q[parent] * native_local_q[i] if parent >= 0 else nr_q[i])
            position = nr_p[i] + (positions[src_hips] - rest_p[src_hips]) * scale if i == pelvis else (out_p[parent] + out_q[parent].apply(native_local_p[i]) if parent >= 0 else nr_p[i])
            out_p.append(position)
            out_q.append(rotation)
        anchors.append({"frame": native_frame, "pose": [{"position": p.tolist(), "quaternion": q.as_quat().tolist()} for p, q in zip(out_p, out_q)]})
    return {"anchors": anchors, "lastFrame": native_frame}, (rest_p, rest_q, nr_p, nr_q, scale)


def _retarget(request, native, generated, mapping, context, desired):
    rest_p, rest_q, nr_p, nr_q, scale = context
    parents = request["rig"]["parents"]
    nindices = {name: i for i, name in enumerate(native["names"])}
    src_to_native = {src: nindices[name] for name, src in mapping.items()}
    native_p = np.asarray([[bone["position"] for bone in frame] for frame in generated])
    rotations = [Slerp(np.arange(len(generated)), Rotation.from_quat([frame[i]["quaternion"] for frame in generated])) for i in range(len(native["names"]))]
    anchor_frames = [anchor["frame"] for anchor in desired["anchors"]]
    anchor_times = [anchor["time"] for anchor in request["anchors"]]
    # Native rig constraints may adjust a transferred pose slightly. Carry a
    # smoothly interpolated calibration between anchors so restoring the exact
    # authored source keys does not introduce a one-frame pop.
    corrections = []
    for i in range(len(native["names"])):
        corrections.append(Slerp(anchor_frames, Rotation.concatenate([
            Rotation.from_quat(anchor["pose"][i]["quaternion"]) * Rotation.from_quat(generated[anchor["frame"]][i]["quaternion"]).inv()
            for anchor in desired["anchors"]])))
    pelvis = nindices["pelvis"]
    src_hips = mapping["pelvis"]
    hip_corrections = np.asarray([np.asarray(anchor["pose"][pelvis]["position"]) - native_p[anchor["frame"], pelvis] for anchor in desired["anchors"]])
    hip_root = src_hips
    while parents[hip_root] >= 0:
        hip_root = parents[hip_root]
    result = []
    angular_changes = []
    for frame in request["frames"]:
        authored = next((anchor for anchor in request["anchors"] if abs(anchor["time"] - frame["time"]) < 1e-6), None)
        if authored:
            result.append(copy.deepcopy(authored))
            continue
        at = float(np.interp(frame["time"], anchor_times, anchor_frames))
        low, high = int(at), min(int(at) + 1, len(generated) - 1)
        fraction = at - low
        native_hips = native_p[low, pelvis] * (1 - fraction) + native_p[high, pelvis] * fraction
        native_hips += np.asarray([np.interp(at, anchor_frames, hip_corrections[:, axis]) for axis in range(3)])
        src_p, src_q = _world(parents, frame["pose"])
        desired_hips = rest_p[src_hips] + (native_hips - nr_p[pelvis]) / scale
        output = copy.deepcopy(frame["pose"])
        out_q = []
        for i, parent in enumerate(parents):
            native_index = src_to_native.get(i)
            q = corrections[native_index](at) * rotations[native_index](at) * nr_q[native_index].inv() * rest_q[i] if native_index is not None else (out_q[parent] * Rotation.from_quat(output[i]["quaternion"]) if parent >= 0 else src_q[i])
            angular_changes.append(float((q * src_q[i].inv()).magnitude()))
            output[i]["quaternion"] = (out_q[parent].inv() * q if parent >= 0 else q).as_quat().tolist()
            out_q.append(q)
        output[hip_root]["position"] = (src_p[hip_root] + desired_hips - src_p[src_hips]).tolist()
        result.append({"time": frame["time"], "pose": output})
    return result, {"meanInteriorRotationChangeRadians": float(np.mean(angular_changes)) if angular_changes else 0,
                    "maxInteriorRotationChangeRadians": max(angular_changes, default=0.)}


def generate_motion(request, progress):
    if request["rig"].get("kind") != "humanoid":
        raise ValueError("Cascadeur learned inbetweening currently supports humanoids. Quadruped motion remains editable with the regular tools.")
    if not 0 < request["duration"] <= 20:
        raise ValueError("Cascadeur AI currently accepts clips up to 20 seconds.")
    mapping = _mapping(request["rig"]["names"], request["rig"]["parents"], request["rig"]["restPose"])
    anchors = request["anchors"]
    if len(anchors) < 2 or abs(anchors[0]["time"]) > 1e-6 or abs(anchors[-1]["time"] - request["duration"]) > 1e-5:
        raise ValueError("Add a pose at the beginning and end before using Cascadeur AI.")
    if any(round((b["time"] - a["time"]) * 30) < 1 for a, b in zip(anchors, anchors[1:])):
        raise ValueError("Cascadeur AI needs distinct authored poses at least one native frame apart.")
    configured_install = Path(request.get("runtime", {}).get("installPath") or INSTALL)
    template = configured_install / "samples" / "Cascy.casc"
    if not template.is_file():
        raise RuntimeError("Install Cascadeur with its Cascy sample, or set CASCADEUR_HOME to your installation directory.")
    runtime = Path(__file__).with_name("cascadeur_runtime.py")
    job = uuid.uuid4().hex
    local = ROOT / ".local" / "cascadeur-jobs"
    local.mkdir(parents=True, exist_ok=True)
    progress("Connecting to the installed Cascadeur learned engine…", .08)
    # Reuse a module only while its owned scene objects are alive. Never reload
    # it over an active job, since that would orphan its cleanup references.
    _bridge("import importlib.util,sys,json\n"
            "if 'still_cascadeur_runtime' not in sys.modules:\n"
            f" spec=importlib.util.spec_from_file_location('still_cascadeur_runtime',{str(runtime)!r})\n"
            " runtime=importlib.util.module_from_spec(spec);sys.modules[spec.name]=runtime;spec.loader.exec_module(runtime)\n"
            "print('STILL_RESULT:'+json.dumps({'connected':True}))")
    try:
        progress("Preparing an isolated humanoid inference rig…", .16)
        native = _call("begin", job, str(template))
        payload, context = _proxy_anchors(request, native, mapping)
        with tempfile.TemporaryDirectory(prefix=job + "-", dir=local) as work:
            inputs, outputs = Path(work) / "anchors.json", Path(work) / "motion.json"
            inputs.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
            progress("Transferring your authored poses to the learned engine…", .30)
            transferred = _call("write_anchors", job, str(inputs))
            progress("Generating learned inbetween motion in Cascadeur…", .48)
            _call("generate", job)
            # A distinct queued request executes on the next native idle event,
            # after the preceding scene update and network inference complete.
            progress("Reading the generated motion…", .74)
            baked = _call("read_frames", job, str(outputs))
            generated = json.loads(outputs.read_text(encoding="utf-8"))["frames"]
            if baked.get("frames") != payload["lastFrame"] + 1 or len(generated) != baked["frames"]:
                raise RuntimeError("Cascadeur returned an incomplete generated animation.")
            frames, metrics = _retarget(request, native, generated, mapping, context, payload)
            errors = [np.linalg.norm(np.asarray(a["position"]) - b["position"]) for desired, actual in zip(payload["anchors"], transferred["actualAnchors"]) for a, b in zip(desired["pose"], actual["pose"])]
            metrics.update({"engine": "Cascadeur installed learned inbetweening", "nativeFrames": baked["frames"],
                            "mappedJoints": len(mapping), "authoredPosesPreserved": True,
                            "maxProxyPoseAdjustmentCm": float(max(errors, default=0.))})
            progress("Applying motion to your existing skeleton…", .94)
            warnings = ["Learned motion is retargeted through a humanoid proxy. Authored poses and your character's original bone lengths and skin are preserved; unusual proportions may need refinement."]
            if any(b["time"] - a["time"] > 4 for a, b in zip(anchors, anchors[1:])):
                warnings.append("Intervals longer than four seconds were inferred within the native model's limit, then stretched to your authored timing.")
            return {"frames": frames, "provider": PROVIDER, "metrics": metrics, "warnings": warnings}
    finally:
        _call("finish", job)


def cleanup_owned_jobs():
    """Call after terminating a worker, before allowing another native job.

    The native bridge queues this after any in-flight operation. It removes only
    temporary scenes registered by this adapter, never an existing user scene.
    """
    return _bridge("import sys,json\n"
                   "runtime=sys.modules.get('still_cascadeur_runtime')\n"
                   "result=runtime.cleanup_owned_jobs() if runtime else {'closedTemporaryScenes':0}\n"
                   "print('STILL_RESULT:'+json.dumps(result))")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cleanup", action="store_true", required=True)
    parser.parse_args()
    print(json.dumps(cleanup_owned_jobs()))
