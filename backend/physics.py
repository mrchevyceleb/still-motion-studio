"""Independent dynamics correction using MuJoCo inverse dynamics and trajectory fitting.

This is not a learned model. It fits an approximate articulated inertial model to
the original skeleton and minimizes the external wrench a floating pelvis would
need. MuJoCo computes gravity, articulated inertia, and unilateral frictional
floor-contact forces. Meshes, skinning, and non-support joint motion stay outside
the solver. The reported residuals describe this proxy model, not measured mass.
"""
from __future__ import annotations

import copy
import json
import math
import re
import time
from pathlib import Path
from typing import Callable
from xml.etree.ElementTree import Element, SubElement, tostring

import mujoco
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.spatial import ConvexHull
from scipy.spatial.transform import Rotation

PROVIDER = {"id": "mujoco", "name": "MuJoCo dynamics", "learned": False,
            "description": "Articulated inverse-dynamics correction with frictional floor contacts; approximate body inertia, not a trained model."}


def _fmt(values):
    return " ".join(f"{float(v):.12g}" for v in values)


def _wxyz(xyzw):
    return np.asarray(xyzw)[[3, 0, 1, 2]]


def _xyzw(wxyz):
    return np.asarray(wxyz)[[1, 2, 3, 0]]


def _world(parents, pose):
    positions, rotations = [], []
    for index, parent in enumerate(parents):
        local = Rotation.from_quat(pose[index]["quaternion"])
        offset = np.asarray(pose[index]["position"], dtype=float)
        if parent < 0:
            positions.append(offset)
            rotations.append(local)
        else:
            positions.append(positions[parent] + rotations[parent].apply(offset))
            rotations.append(rotations[parent] * local)
    return np.asarray(positions), rotations


def _clean(name):
    return re.sub(r"[^a-z]", "", name.lower()).replace("mixamorig", "")


def _mass(name, length):
    if length < .008:
        return .015
    name = _clean(name)
    if any(word in name for word in ("finger", "thumb", "index", "middle", "ring", "pinky", "eye", "end")):
        return .025
    if any(word in name for word in ("hips", "pelvis")):
        return 9.
    if "head" in name:
        return 4.5
    if "spine" in name or "chest" in name:
        return 7.
    if "upleg" in name or "thigh" in name or "upperleg" in name:
        return 7.
    if "leg" in name or "shin" in name or "calf" in name:
        return 3.5
    if "foot" in name or "ankle" in name:
        return 1.1
    if "forearm" in name or "lowerarm" in name:
        return 1.2
    if "arm" in name:
        return 2.1
    return max(.15, length * 2.)


class ArticulatedProxy:
    def __init__(self, request):
        rig = request["rig"]
        self.names = list(rig["names"])
        self.parents = np.asarray(rig["parents"], dtype=int)
        self.rest = rig["restPose"]
        self.count = len(self.names)
        if not (1 <= self.count <= 256) or len(self.rest) != self.count or len(self.parents) != self.count:
            raise ValueError("Physics needs between 1 and 256 matching skeleton joints.")
        roots = np.flatnonzero(self.parents < 0)
        if len(roots) != 1 or roots[0] != 0 or any(p >= i for i, p in enumerate(self.parents) if p >= 0):
            raise ValueError("Physics needs one connected skeleton in parent-before-child order, with its root first.")
        self.rest_world, rest_rotations = _world(self.parents, self.rest)
        self.height = max(.3, float(np.ptp(self.rest_world[:, 1])))
        self.ground = float(request.get("groundHeight", 0.))
        self.gravity = float(request.get("settings", {}).get("gravity", 9.81))
        if not 0 <= self.gravity <= 30:
            raise ValueError("Gravity must be between zero and 30 m/s².")
        support = rig.get("supportJoints")
        if support is None:
            support = [i for i, name in enumerate(self.names) if re.search(r"(?:foot|ankle|hoof|paw)(?:_\d+)?$", name, re.I)]
        self.feet = []
        for index in support:
            if not 0 <= index < self.count:
                raise ValueError("A mapped support joint is outside the skeleton.")
            duplicate = next((i for i, old in enumerate(self.feet) if np.linalg.norm(self.rest_world[index] - self.rest_world[old]) < .005), None)
            if duplicate is None:
                self.feet.append(index)
            else:
                self.feet[duplicate] = index  # Prefer the distal control of coincident FBX bones.
        if not self.feet:
            raise ValueError("Map foot, ankle, hoof, or paw joints before running dynamics correction.")
        self.feet = self.feet[:4]
        children = [[i for i, p in enumerate(self.parents) if p == j] for j in range(self.count)]
        offsets = [np.asarray(p["position"], float) for p in self.rest]
        lengths = [max([np.linalg.norm(offsets[c]) for c in children[i]] + [.06 if i in self.feet else 0.]) for i in range(self.count)]
        raw_masses = np.asarray([_mass(name, length) for name, length in zip(self.names, lengths)])
        masses = raw_masses / raw_masses.sum() * 70.
        xml = Element("mujoco", model="still_original_skeleton_proxy")
        SubElement(xml, "compiler", angle="radian", autolimits="true")
        SubElement(xml, "option", gravity=f"0 {-self.gravity} 0", timestep="0.005", cone="elliptic", iterations="30", tolerance="1e-9")
        defaults = SubElement(xml, "default")
        SubElement(defaults, "joint", damping=".05", armature=".001")
        SubElement(defaults, "geom", friction=".9 .02 .002", solref=".015 1", solimp=".9 .95 .001", condim="3")
        world = SubElement(xml, "worldbody")
        # MuJoCo planes face local +Z; rotate that normal onto world +Y.
        SubElement(world, "geom", name="floor", type="plane", pos=f"0 {self.ground} 0", quat=".7071067812 -.7071067812 0 0", size="20 20 .1", contype="1", conaffinity="2")
        bodies = []
        self.foot_offsets = []
        self.foot_radii = []
        self.limit_radians = np.full(self.count, math.pi)
        for index in range(self.count):
            parent_xml = world if self.parents[index] < 0 else bodies[self.parents[index]]
            body = SubElement(parent_xml, "body", name=f"bone_{index}", pos=_fmt(offsets[index]), quat=_fmt(_wxyz(self.rest[index]["quaternion"])))
            bodies.append(body)
            if index == 0:
                SubElement(body, "freejoint", name="root")
            else:
                name = _clean(self.names[index])
                degrees = 175
                if any(term in name for term in ("spine", "chest")): degrees = 70
                elif any(term in name for term in ("foot", "ankle")): degrees = 85
                elif any(term in name for term in ("neck", "head")): degrees = 85
                elif name.endswith("leg") and "upleg" not in name: degrees = 160
                self.limit_radians[index] = math.radians(degrees)
                SubElement(body, "joint", name=f"joint_{index}", type="ball", limited="true", range=f"0 {self.limit_radians[index]}")
            length = float(lengths[index])
            segment = offsets[max(children[index], key=lambda c: np.linalg.norm(offsets[c]))] if children[index] else np.array([0., .06, 0.])
            com = segment * .45
            radius = max(.014, min(.07, length * .18))
            inertia = max(1e-5, masses[index] * (length * length + radius * radius) / 12.)
            SubElement(body, "inertial", pos=_fmt(com), mass=str(masses[index]), diaginertia=_fmt([inertia] * 3))
            # Non-contact proxy shapes only visualize mass distribution; self-collision is not claimed.
            if np.linalg.norm(segment) > .015:
                SubElement(body, "geom", type="capsule", fromto=_fmt(np.r_[np.zeros(3), segment]), size=str(radius), contype="0", conaffinity="0", rgba=".55 .68 .45 .5")
            if index in self.feet:
                half_height = max(.018, self.height * .012)
                clearance = float(np.clip(self.rest_world[index, 1] - self.ground, half_height, self.height * .12))
                local = rest_rotations[index].inv().apply([0, -clearance + half_height, self.height * .015])
                orient = rest_rotations[index].inv().as_quat()
                SubElement(body, "geom", name=f"sole_{index}", type="box", pos=_fmt(local), quat=_fmt(_wxyz(orient)), size=_fmt([self.height * .026, half_height, self.height * .06]), contype="2", conaffinity="1", rgba=".7 .4 .2 1")
                SubElement(body, "site", name=f"support_{index}", pos=_fmt(local), size=".008")
                self.foot_offsets.append(local)
                self.foot_radii.append(half_height)
        self.xml = tostring(xml, encoding="unicode")
        self.model = mujoco.MjModel.from_xml_string(self.xml)
        self.data = mujoco.MjData(self.model)
        self.body_ids = np.asarray([mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, f"bone_{i}") for i in range(self.count)])
        self.sites = np.asarray([mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_SITE, f"support_{i}") for i in self.feet])
        self.sole_geoms = np.asarray([mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_GEOM, f"sole_{i}") for i in self.feet])
        self.joint_ids = [0] + [mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, f"joint_{i}") for i in range(1, self.count)]
        self.qaddrs = self.model.jnt_qposadr[self.joint_ids]
        self.daddrs = self.model.jnt_dofadr[self.joint_ids]
        optimized = set(range(6))
        for foot in self.feet:
            current = foot
            while current > 0:
                optimized.update(range(self.daddrs[current], self.daddrs[current] + 3))
                current = self.parents[current]
        self.dofs = np.asarray(sorted(optimized), dtype=int)
        self.mass = float(self.model.body_mass.sum())
        self.weight = self.mass * max(self.gravity, 1.)
        self.torque_limits = np.full(self.model.nv - 6, 120.)
        for i in range(1, self.count):
            name = _clean(self.names[i])
            limit = 200. if any(term in name for term in ("hips", "pelvis", "upleg", "thigh", "spine")) else 120.
            if any(term in name for term in ("arm", "shoulder")): limit = 85.
            if any(term in name for term in ("hand", "foot", "ankle", "head", "neck")): limit = 55.
            if any(term in name for term in ("finger", "thumb", "index", "middle", "ring", "pinky", "eye", "end")): limit = 8.
            address = self.daddrs[i] - 6
            self.torque_limits[address:address + 3] = limit

    def pose_to_q(self, pose):
        q = self.model.qpos0.copy()
        q[:3] = pose[0]["position"]
        q[3:7] = _wxyz(pose[0]["quaternion"])
        for i in range(1, self.count):
            rotation = Rotation.from_quat(self.rest[i]["quaternion"]).inv() * Rotation.from_quat(pose[i]["quaternion"])
            address = self.qaddrs[i]
            q[address:address + 4] = _wxyz(rotation.as_quat())
        return q

    def q_to_pose(self, q, original):
        pose = copy.deepcopy(original)
        pose[0]["position"] = q[:3].tolist()
        pose[0]["quaternion"] = _xyzw(q[3:7]).tolist()
        for i in range(1, self.count):
            if self.daddrs[i] not in self.dofs:
                continue
            address = self.qaddrs[i]
            rotation = Rotation.from_quat(self.rest[i]["quaternion"]) * Rotation.from_quat(_xyzw(q[address:address + 4]))
            pose[i]["quaternion"] = rotation.as_quat().tolist()
        return pose

    def sample(self, q, velocity=None, acceleration=None):
        data, model = self.data, self.model
        data.qpos[:] = q
        data.qvel[:] = 0 if velocity is None else velocity
        data.qacc[:] = 0 if acceleration is None else acceleration
        mujoco.mj_inverse(model, data)
        centers = data.site_xpos[self.sites].copy()
        # Actual oriented box vertical extent, not just ankle-point penetration.
        bottoms = []
        for geom in self.sole_geoms:
            mat = data.geom_xmat[geom].reshape(3, 3)
            extent = np.abs(mat[1]).dot(model.geom_size[geom])
            bottoms.append(data.geom_xpos[geom, 1] - extent - self.ground)
        return {"feet": centers, "bottoms": np.asarray(bottoms), "com": data.subtree_com[self.body_ids[0]].copy(),
                "wrench": data.qfrc_inverse[:6].copy(), "torques": data.qfrc_inverse[6:].copy()}


def _derivatives(proxy, q, times):
    count = len(q)
    velocity = np.zeros((count, proxy.model.nv))
    acceleration = np.zeros_like(velocity)
    if count < 2: return velocity, acceleration
    segments = np.zeros((count - 1, proxy.model.nv))
    for i in range(count - 1):
        mujoco.mj_differentiatePos(proxy.model, segments[i], times[i + 1] - times[i], q[i], q[i + 1])
    velocity[0], velocity[-1] = segments[0], segments[-1]
    for i in range(1, count - 1):
        velocity[i] = (segments[i - 1] + segments[i]) / 2
        acceleration[i] = 2 * (segments[i] - segments[i - 1]) / (times[i + 1] - times[i - 1])
    if count > 2:
        acceleration[0], acceleration[-1] = acceleration[1], acceleration[-2]
    return velocity, acceleration


def _contact_schedule(samples, times, proxy):
    feet = np.asarray([sample["feet"] for sample in samples])
    bottoms = np.asarray([sample["bottoms"] for sample in samples])
    velocity = np.gradient(feet, times, axis=0) if len(times) > 1 else np.zeros_like(feet)
    speed = np.linalg.norm(velocity[:, :, [0, 2]], axis=2)
    # Schmitt thresholds keep a planted foot from flickering off during small
    # noisy excursions, but liftoff/airborne frames cannot be bridged merely by
    # a fixed number of samples. All thresholds scale with character height.
    vertical = np.abs(velocity[:, :, 1])
    enter = (bottoms < proxy.height * .015) & (speed < proxy.height * .18) & (vertical < proxy.height * .18)
    remain = (bottoms < proxy.height * .028) & (speed < proxy.height * .30) & (vertical < proxy.height * .25)
    active = np.zeros_like(enter)
    for foot in range(len(proxy.feet)):
        planted = False
        for index in range(len(times)):
            planted = bool(enter[index, foot] or (planted and remain[index, foot]))
            active[index, foot] = planted
    targets = feet.copy()
    for foot in range(len(proxy.feet)):
        start = 0
        while start < len(times):
            if not active[start, foot]: start += 1; continue
            end = start + 1
            while end < len(times) and active[end, foot]: end += 1
            if end - start < 2 or times[end - 1] - times[start] < .04:
                active[start:end, foot] = False
            else:
                # A stance segment has one stationary support target.
                # Prefer the quietest measured part of the stance, so heel
                # strike/toe-off drift does not drag the whole contact target.
                steady = np.argsort(speed[start:end, foot])[:max(2, (end - start) // 2)] + start
                anchor = np.median(feet[steady, foot], axis=0)
                anchor[1] = proxy.ground + proxy.foot_radii[foot]
                targets[start:end, foot] = anchor
            start = end
    return active, targets


def _refine_contacts(proxy, fitted, times, active, targets, report):
    """Plant stance feet at full frame rate without flattening authored rolls.

    The dynamics solve supplies vertical compression and foot rotation. This
    kinematic projection only removes support drift, caps excess penetration,
    and blends corrections through adjacent swing frames. Final acceptance still
    uses a fresh full-rate dynamics audit; a foot lock is never physical proof.
    """
    count = len(times)
    samples = [proxy.sample(state) for state in fitted]
    feet = np.asarray([sample["feet"] for sample in samples])
    bottoms = np.asarray([sample["bottoms"] for sample in samples])
    weights = active.astype(float)
    goals = targets.copy()
    # Extend the transition into swing, keeping the entire stance fully locked.
    ramp_seconds = .15
    for foot in range(len(proxy.feet)):
        start = 0
        while start < count:
            if not active[start, foot]: start += 1; continue
            end = start + 1
            while end < count and active[end, foot]: end += 1
            low = int(np.searchsorted(times, times[start] - ramp_seconds))
            high = int(np.searchsorted(times, times[end - 1] + ramp_seconds, side="right"))
            for i in range(low, high):
                distance = max(times[start] - times[i], times[i] - times[end - 1], 0.)
                weight = max(0., 1 - distance / ramp_seconds)
                weight = weight * weight * (3 - 2 * weight)
                if weight > weights[i, foot]:
                    weights[i, foot] = weight
                    goals[i, foot] = targets[start, foot]
            start = end
    output = fitted.copy()
    # Keep root orientation from dynamics, and use translations plus support
    # chains to avoid rotating the whole character just to fix one ankle.
    dofs = np.r_[np.arange(3), proxy.dofs[proxy.dofs >= 6]]
    scale = np.r_[[.25] * 3, [1.] * (len(dofs) - 3)]
    jacobian = np.zeros((3, proxy.model.nv))
    angular = np.zeros_like(jacobian)
    velocity = np.zeros(proxy.model.nv)
    maximum_error = 0.
    for i in range(count):
        proxy.data.qpos[:] = fitted[i]
        mujoco.mj_kinematics(proxy.model, proxy.data)
        rotations = proxy.data.xmat[proxy.body_ids[proxy.feet]].reshape(-1, 3, 3).copy()
        desired = feet[i] + weights[i, :, None] * (goals[i] - feet[i])
        # Keep the oriented sole on the floor throughout stance. Swing feet
        # only receive penetration correction; they are never pulled down.
        vertical_delta = np.where(weights[i] > 0, -bottoms[i] * weights[i], np.maximum(0., -bottoms[i] - .004))
        desired[:, 1] = feet[i, :, 1] + vertical_delta
        if not weights[i].any() and np.max(np.abs(desired - feet[i])) < 1e-8: continue
        for _ in range(20):
            proxy.data.qpos[:] = output[i]
            mujoco.mj_kinematics(proxy.model, proxy.data)
            mujoco.mj_comPos(proxy.model, proxy.data)
            rows, errors = [], []
            for foot, site in enumerate(proxy.sites):
                mujoco.mj_jacSite(proxy.model, proxy.data, jacobian, angular, site)
                orientation = proxy.data.xmat[proxy.body_ids[proxy.feet[foot]]].reshape(3, 3)
                rotation_error = Rotation.from_matrix(rotations[foot] @ orientation.T).as_rotvec()
                rows.extend([jacobian[:, dofs], angular[:, dofs] * .3])
                errors.extend(desired[foot] - proxy.data.site_xpos[site])
                errors.extend(rotation_error * .3)
            matrix = np.vstack(rows) * scale
            error = np.asarray(errors)
            if np.linalg.norm(error) < 1e-5: break
            step = matrix.T @ np.linalg.solve(matrix @ matrix.T + np.eye(len(error)) * 1e-5, error)
            velocity[:] = 0.
            velocity[dofs] = np.clip(step * scale, -.1, .1)
            mujoco.mj_integratePos(proxy.model, output[i], velocity, 1.)
        sample = proxy.sample(output[i])
        maximum_error = max(maximum_error, float(np.max(np.linalg.norm(sample["feet"] - desired, axis=1))))
        if i % 100 == 0: report("Holding planted feet while preserving foot rolls", .90 + .04 * i / count)
    return output, {"stanceFrames": int(np.count_nonzero(active.any(axis=1))),
                    "airborneFrames": int(np.count_nonzero(~active.any(axis=1))),
                    "maximumTargetErrorM": maximum_error, "transitionSeconds": ramp_seconds,
                    "rootAdjustmentRmsM": float(np.sqrt(np.mean(np.sum((output[:, :3] - fitted[:, :3]) ** 2, axis=1))))}


def _balance_distance(com, feet):
    # Static COM support distance is diagnostic only during contact. It is not a
    # dynamic stability guarantee (running COM can legitimately leave support).
    if not len(feet): return 0.
    points = np.asarray([point[[0, 2]] + offset for point in feet for offset in ([-.055, -.12], [-.055, .12], [.055, -.12], [.055, .12])])
    hull = ConvexHull(points)
    xy = com[[0, 2]]
    distances = hull.equations[:, :2] @ xy + hull.equations[:, 2]
    return float(max(0., distances.max()))


def _metrics(proxy, q, times, active, reference=None):
    velocity, acceleration = _derivatives(proxy, q, times)
    samples = [proxy.sample(state, velocity[i], acceleration[i]) for i, state in enumerate(q)]
    penetration = np.maximum(0, -np.asarray([s["bottoms"] for s in samples]))
    feet = np.asarray([s["feet"] for s in samples])
    sliding = []
    for i in range(1, len(q)):
        both = active[i] & active[i - 1]
        if both.any(): sliding.extend((np.linalg.norm((feet[i, both] - feet[i - 1, both])[:, [0, 2]], axis=1) / (times[i] - times[i - 1])).tolist())
    forces = np.asarray([s["wrench"][:3] for s in samples])
    torques = np.asarray([s["wrench"][3:] for s in samples])
    joint_excess = []
    for index in range(1, proxy.count):
        angles = 2 * np.arccos(np.clip(np.abs(q[:, proxy.qaddrs[index]]), 0, 1))
        joint_excess.extend(np.maximum(angles - proxy.limit_radians[index], 0).tolist())
    metric = {"floorPenetrationMaxM": float(penetration.max()), "floorPenetrationMeanM": float(penetration.mean()),
              "contactSlidingMeanMps": float(np.mean(sliding)) if sliding else 0.,
              "staticSupportOutsideMeanM": float(np.mean([_balance_distance(s["com"], s["feet"][active[i]]) for i, s in enumerate(samples)])),
              "rootForceResidualRmsN": float(np.sqrt(np.mean(np.sum(forces * forces, axis=1)))),
              "rootTorqueResidualRmsNm": float(np.sqrt(np.mean(np.sum(torques * torques, axis=1)))),
              "requiredJointTorqueMaxNm": float(max(np.max(np.abs(s["torques"])) for s in samples)),
              "jointLimitViolationMaxRad": float(max(joint_excess, default=0.)),
              "contactFrames": int(np.count_nonzero(active.any(axis=1))),
              "airborneFrames": int(np.count_nonzero(~active.any(axis=1)))}
    if reference is not None:
        metric["rootCorrectionRmsM"] = float(np.sqrt(np.mean(np.sum((q[:, :3] - reference[:, :3]) ** 2, axis=1))))
    return metric, samples


def correct_motion(request: dict, progress: Callable[[str, float], None] | None = None) -> dict:
    report = progress or (lambda *_: None)
    start_time = time.monotonic()
    report("Building an articulated dynamics model from your original skeleton", .03)
    frames = request.get("frames", [])
    if len(frames) < 3:
        raise ValueError("Dynamics correction needs at least three sampled animation frames.")
    if len(frames) > 3601:
        raise ValueError("Use at most 3,601 frames per dynamics correction.")
    all_times = np.asarray([frame["time"] for frame in frames], dtype=float)
    if not np.isfinite(all_times).all() or np.any(np.diff(all_times) <= 0):
        raise ValueError("Animation times must be finite and strictly increasing.")
    for frame in frames:
        if len(frame["pose"]) != len(request["rig"]["names"]):
            raise ValueError("All motion frames must match the original skeleton.")
        values = np.asarray([b["position"] + b["quaternion"] + b["scale"] for b in frame["pose"]], dtype=float)
        if values.shape[1] != 10 or not np.isfinite(values).all():
            raise ValueError("Physics received invalid or non-finite pose data.")
        # This articulated model has fixed segment offsets. Do not report proxy
        # metrics as if they measured a source skeleton with animated lengths.
        for index, bone in enumerate(frame["pose"]):
            if np.max(np.abs(np.asarray(bone["scale"]) - 1.)) > 1e-5:
                raise ValueError("Dynamics requires normalized unit-scale joints.")
            if index and np.linalg.norm(np.asarray(bone["position"]) - request["rig"]["restPose"][index]["position"]) > .001:
                raise ValueError("This clip animates bone lengths or joint offsets. Dynamics currently requires fixed segment lengths; the source animation was kept.")
    proxy = ArticulatedProxy(request)
    maximum = int(request.get("runtime", {}).get("maxSolveFrames", 241))
    maximum = max(3, min(301, maximum))
    indices = np.unique(np.round(np.linspace(0, len(frames) - 1, min(maximum, len(frames)))).astype(int))
    times = all_times[indices]
    reference = np.asarray([proxy.pose_to_q(frames[i]["pose"]) for i in indices])
    initial_samples = [proxy.sample(q) for q in reference]
    active, targets = _contact_schedule(initial_samples, times, proxy)
    if not active.any():
        # In flight only the floating root is corrected; the authored internal
        # articulation is retained rather than exploiting violent limb motion.
        proxy.dofs = np.arange(6)
    before, _ = _metrics(proxy, reference, times, active)
    count, dimensions = len(indices), len(proxy.dofs)
    strength = float(np.clip(request.get("settings", {}).get("strength", .7), 0, 1))
    lock_feet = bool(request.get("settings", {}).get("floorContact", True))
    anchors = np.asarray([a["time"] for a in request.get("anchors", [])], dtype=float)
    anchor_weights = np.ones(count)
    if len(anchors):
        for t in anchors: anchor_weights[int(np.argmin(abs(times - t)))] = 20.
    anchor_weights[[0, -1]] = np.maximum(anchor_weights[[0, -1]], 10.)
    scale = np.asarray([.08 if dof < 3 else .35 for dof in proxy.dofs])
    eval_count = 0
    best = {"cost": float("inf"), "x": np.zeros((count, dimensions))}
    max_seconds = float(request.get("runtime", {}).get("maxSeconds", 35.))
    rows_per_frame = dimensions + 6 + len(proxy.feet) * 4 + 3 + dimensions + len(proxy.torque_limits)

    def states(x):
        deltas = x.reshape(count, dimensions)
        output = reference.copy()
        velocity = np.zeros(proxy.model.nv)
        for i in range(count):
            velocity[:] = 0
            velocity[proxy.dofs] = deltas[i]
            mujoco.mj_integratePos(proxy.model, output[i], velocity, 1.)
        return output

    def residual(x):
        nonlocal eval_count
        if time.monotonic() - start_time > max_seconds and eval_count > 1:
            raise TimeoutError("Solver time budget reached")
        eval_count += 1
        delta = x.reshape(count, dimensions)
        q = states(x)
        velocity, acceleration = _derivatives(proxy, q, times)
        rows = np.zeros((count, rows_per_frame))
        for i in range(count):
            sample = proxy.sample(q[i], velocity[i], acceleration[i])
            support_error = (sample["feet"] - targets[i]) * active[i, :, None]
            support_error[:, 1] *= .4
            if not lock_feet: support_error *= .12
            wrench = sample["wrench"].copy()
            wrench[:3] /= proxy.weight
            wrench[3:] /= proxy.weight * proxy.height * .25
            # Weak COM guidance is gated by low horizontal velocity; dynamics
            # determines whether moving poses can live outside static support.
            static = active[i].any() and np.linalg.norm(velocity[i, [0, 2]]) < .25
            balance = np.zeros(3)
            if static:
                center = targets[i, active[i]].mean(axis=0)
                halfwidth = np.ptp(targets[i, active[i]][:, [0, 2]], axis=0) / 2 + [.055, .12]
                deviation = sample["com"][[0, 2]] - center[[0, 2]]
                balance[[0, 2]] = np.sign(deviation) * np.maximum(np.abs(deviation) - halfwidth, 0) / .05
            smooth = np.zeros(dimensions)
            if 0 < i < count - 1:
                smooth = (delta[i - 1] - 2 * delta[i] + delta[i + 1]) / scale * .35
            torques = sample["torques"] / proxy.torque_limits
            excessive_torque = np.sign(torques) * np.maximum(np.abs(torques) - 1, 0) * 2 + torques * .02
            rows[i] = np.r_[delta[i] / scale * .22 * anchor_weights[i], wrench * (2 + 5 * strength),
                            (support_error / .025 * (1 + strength * 2)).ravel(), np.maximum(0, -sample["bottoms"]) / .004,
                            balance * .7, smooth, excessive_torque]
        cost = float(np.sum(rows * rows))
        if cost < best["cost"]:
            best.update(cost=cost, x=delta.copy())
        if eval_count % 80 == 1:
            report("Solving gravity, contact forces, and support-chain motion", min(.88, .12 + .75 * (time.monotonic() - start_time) / max_seconds))
        return rows.ravel()

    sparsity = lil_matrix((count * rows_per_frame, count * dimensions), dtype=int)
    for i in range(count):
        # Endpoint accelerations reuse the adjacent interior stencil.
        low, high = max(0, i - 1), min(count, i + 2)
        if i == 0: high = min(count, 3)
        if i == count - 1: low = max(0, count - 3)
        sparsity[i * rows_per_frame:(i + 1) * rows_per_frame, low * dimensions:high * dimensions] = 1
    bounds = np.tile(np.asarray([proxy.height * .3 if dof < 3 else .7 for dof in proxy.dofs]), count)
    converged = False
    message = "Strength is zero; original motion retained."
    if strength > 0:
        try:
            seed = np.zeros((count, dimensions))
            for i in range(count):
                if active[i].any():
                    seed[i, 1] = -np.median(initial_samples[i]["bottoms"][active[i]]) - .0005
            seed = np.clip(seed.ravel(), -bounds * .99, bounds * .99)
            fit = least_squares(residual, seed, bounds=(-bounds, bounds), jac_sparsity=sparsity.tocsr(),
                                tr_solver="lsmr", x_scale=np.tile(scale, count), max_nfev=int(request.get("runtime", {}).get("maxIterations", 40)),
                                ftol=2e-3, xtol=2e-3, gtol=2e-3, diff_step=1e-4)
            converged = bool(fit.success)
            message = str(fit.message)
        except TimeoutError:
            message = "Time budget reached; returning the best measured correction."
    corrected = states(best["x"].ravel())
    after, after_samples = _metrics(proxy, corrected, times, active, reference)
    report("Refining support contacts at the original frame rate", .90)
    # Interpolate corrections, never the character's source animation: preserve
    # all detail at its original frame rate and preserve original time endpoints.
    changes = best["x"]
    dense_delta = np.stack([np.interp(all_times, times, changes[:, i]) for i in range(dimensions)], axis=1)
    result_frames = []
    for i, frame in enumerate(frames):
        state = proxy.pose_to_q(frame["pose"])
        velocity = np.zeros(proxy.model.nv)
        velocity[proxy.dofs] = dense_delta[i]
        mujoco.mj_integratePos(proxy.model, state, velocity, 1.)
        result_frames.append({"time": frame["time"], "pose": proxy.q_to_pose(state, frame["pose"])})
    sampled_before, sampled_after = before, after
    # Fit dynamics sparsely, then hold detected stance centers at full rate.
    # Audit the actual returned motion against the same source contact schedule.
    original_dense = np.asarray([proxy.pose_to_q(frame["pose"]) for frame in frames])
    corrected_dense = np.asarray([proxy.pose_to_q(frame["pose"]) for frame in result_frames])
    dense_samples = [proxy.sample(q) for q in original_dense]
    dense_active, dense_targets = _contact_schedule(dense_samples, all_times, proxy)
    contact_refinement = None
    if strength > 0 and lock_feet and dense_active.any():
        corrected_dense, contact_refinement = _refine_contacts(proxy, corrected_dense, all_times, dense_active, dense_targets, report)
        result_frames = [{"time": frame["time"], "pose": proxy.q_to_pose(corrected_dense[i], frame["pose"])} for i, frame in enumerate(frames)]
    before, _ = _metrics(proxy, original_dense, all_times, dense_active)
    after, after_samples = _metrics(proxy, corrected_dense, all_times, dense_active, original_dense)
    if strength > 0:
        # Never silently replace the user's motion with a fit that merely looks
        # better on the sparse optimization grid but worsens actual dynamics.
        rejected = []
        if after["rootForceResidualRmsN"] > max(before["rootForceResidualRmsN"] * 1.25, proxy.weight * .5):
            rejected.append("unphysical root forces increased")
        if after["rootTorqueResidualRmsNm"] > max(before["rootTorqueResidualRmsNm"] * 1.25, proxy.weight * proxy.height * .05):
            rejected.append("unphysical root torques increased")
        if after["requiredJointTorqueMaxNm"] > max(before["requiredJointTorqueMaxNm"] * 1.4, 400.):
            rejected.append("required joint torques increased beyond the acceptance limit")
        if after["floorPenetrationMaxM"] > max(before["floorPenetrationMaxM"] + .007, .015):
            rejected.append("ground penetration increased")
        if lock_feet and after["contactSlidingMeanMps"] > max(before["contactSlidingMeanMps"] + .035, before["contactSlidingMeanMps"] * 1.5, .08):
            rejected.append("planted feet started sliding")
        if rejected:
            raise ValueError("Dynamics correction was not applied: " + "; ".join(rejected) + ". Your original animation is unchanged. Try a shorter interval or a calibrated support rig.")
    anchor_drift = []
    for anchor in request.get("anchors", []):
        index = int(np.argmin(abs(all_times - anchor["time"])))
        original = proxy.pose_to_q(anchor["pose"])
        final = proxy.pose_to_q(result_frames[index]["pose"])
        difference = np.zeros(proxy.model.nv)
        mujoco.mj_differentiatePos(proxy.model, difference, 1., original, final)
        anchor_drift.append({"time": anchor["time"], "rootTranslationM": float(np.linalg.norm(difference[:3])), "maxJointRotationRad": float(np.max(np.abs(difference[3:])))})
    warnings = ["Dynamics uses inferred segment masses and proxy foot shapes; it does not change the source skin or mesh.",
                "Joint limits are rest-relative rotational cones; anatomical hinge axes and full-body self-collision require rig-specific calibration."]
    if not converged and strength > 0: warnings.append(message)
    if after["rootForceResidualRmsN"] > proxy.weight * .15:
        warnings.append("This motion still requires a substantial unphysical root force in the proxy model. Treat the result as a correction proposal, not a physically certified animation.")
    if after["requiredJointTorqueMaxNm"] > 350:
        warnings.append("Some inferred joint torques remain above 350 Nm. The proxy or timing needs calibration before this motion can be considered physically feasible.")
    if len(indices) < len(frames): warnings.append(f"Dynamics solved at {len(indices)} temporal samples; interpolated corrections retain all {len(frames)} original frames. Before/after metrics audit the full returned frame rate.")
    if anchor_drift and max(a["rootTranslationM"] for a in anchor_drift) > .015:
        warnings.append("Some authored anchor poses moved to satisfy contact/dynamics. Review the reported anchor drift.")
    review_reasons = []
    # A foot-only proxy cannot certify handstands, tumbling contacts or body
    # collisions. Expose that limitation per clip instead of hiding it behind
    # an apparently good mean-force number.
    if np.count_nonzero(~dense_active.any(axis=1)) > len(dense_active) * .15:
        review_reasons.append("Airborne or non-foot-supported motion needs acrobatic/contact review")
    if after["rootForceResidualRmsN"] > proxy.weight * .15: review_reasons.append("Significant unphysical root force remains")
    if after["rootTorqueResidualRmsNm"] > proxy.weight * proxy.height * .04: review_reasons.append("Significant unphysical root torque remains")
    if after["requiredJointTorqueMaxNm"] > 350.: review_reasons.append("High joint torque requires rig calibration")
    if after["floorPenetrationMaxM"] > .006: review_reasons.append("Foot penetration exceeds 6 mm")
    if after["contactSlidingMeanMps"] > .03: review_reasons.append("Support-foot sliding exceeds 3 cm/s")
    if after["jointLimitViolationMaxRad"] > .02: review_reasons.append("A proxy joint limit remains exceeded")
    if contact_refinement and contact_refinement["maximumTargetErrorM"] > .01: review_reasons.append("A planted-foot target could not be reached within 1 cm")
    if anchor_drift and max(a["rootTranslationM"] for a in anchor_drift) > .02: review_reasons.append("An authored anchor moved more than 2 cm")
    report("Dynamics correction complete", 1.)
    return {"frames": result_frames, "metrics": {"before": before, "after": after, "anchorDrift": anchor_drift,
              "quality": {"requiresReview": bool(review_reasons), "reasons": review_reasons, "scope": "Approximate articulated proxy; not a physical feasibility certificate"},
              "solver": {"engine": f"MuJoCo {mujoco.__version__}", "converged": converged, "message": message, "seconds": time.monotonic() - start_time,
                         "evaluations": eval_count, "samples": count, "optimizedDegreesOfFreedom": dimensions, "bodyMassKg": proxy.mass,
                         "sampledBefore": sampled_before, "sampledAfter": sampled_after, "contactRefinement": contact_refinement}},
            "contacts": [{"time": float(all_times[i]), "joints": [proxy.names[j] for k, j in enumerate(proxy.feet) if dense_active[i, k]], "centerOfMass": sample["com"].tolist()} for i, sample in enumerate(after_samples)],
            "warnings": warnings, "provider": PROVIDER}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    request = json.loads(Path(args.input).read_text(encoding="utf-8-sig"))
    response = correct_motion(request, lambda message, fraction: print(f"{fraction:.0%} {message}", flush=True))
    Path(args.output).write_text(json.dumps(response, indent=2), encoding="utf-8")
    print(json.dumps(response["metrics"], indent=2))
