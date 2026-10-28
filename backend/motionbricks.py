"""Pose-conditioned MotionBricks SOMA inference on the original character rig.

The NumPy feature codec follows NVIDIA's Apache-2.0 SOMA kernels at revision
54fc563aeaaf819a753d72cc9fdc6713989cdd43. See assets/motionbricks-LICENSE.txt.
Weights are installed separately; no NVIDIA sample motions are used or shipped.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import time

import numpy as np
from scipy.spatial.transform import Rotation, Slerp

MODEL_SHA256 = '856419dc72aeb14e591eebf4dd0ea05734a2506ddb00bcd39dd6dac2ad60f4fb'
_DLL_DIRECTORIES = []


def load_onnxruntime():
    # Desktop bundles the pinned Microsoft C++ runtime beside python.exe.
    # Make those app-local DLLs visible to ORT on clean Windows as well.
    if sys.platform == 'win32' and not _DLL_DIRECTORIES:
        folder = Path(sys.executable).parent
        if folder.is_dir():
            _DLL_DIRECTORIES.append(os.add_dll_directory(str(folder)))
    import onnxruntime
    return onnxruntime

PROVIDER = {'id': 'motionbricks', 'name': 'MotionBricks', 'learned': True,
            'description': 'Local NVIDIA humanoid inbetweening, preserving your poses and original rig.'}
RIG = json.loads((Path(__file__).parent / 'assets/motionbricks-soma.json').read_text())
NAMES, PARENTS = RIG['names'], RIG['parents']
OFFSETS = np.asarray(RIG['offsets'], dtype=float)
NEUTRAL_ROTATIONS = Rotation.from_quat(RIG['neutralRotations'])
ALIASES = {
    'Hips': ('hips', 'pelvis'), 'Head': ('head',),
    'LeftShoulder': ('leftshoulder', 'claviclel', 'shoulderl'),
    'RightShoulder': ('rightshoulder', 'clavicler', 'shoulderr'),
    'LeftArm': ('leftarm', 'upperarml'), 'RightArm': ('rightarm', 'upperarmr'),
    'LeftForeArm': ('leftforearm', 'lowerarml', 'forearml'),
    'RightForeArm': ('rightforearm', 'lowerarmr', 'forearmr'),
    'LeftHand': ('lefthand', 'handl'), 'RightHand': ('righthand', 'handr'),
    'LeftLeg': ('leftupleg', 'leftupperleg', 'thighl'),
    'RightLeg': ('rightupleg', 'rightupperleg', 'thighr'),
    'LeftShin': ('leftleg', 'leftlowerleg', 'calfl', 'shinl'),
    'RightShin': ('rightleg', 'rightlowerleg', 'calfr', 'shinr'),
    'LeftFoot': ('leftfoot', 'footl', 'anklel'), 'RightFoot': ('rightfoot', 'footr', 'ankler'),
    'LeftToeBase': ('lefttoebase', 'balll', 'toel'),
    'RightToeBase': ('righttoebase', 'ballr', 'toer'),
}
REQUIRED = (set(ALIASES) - {'LeftShoulder', 'RightShoulder', 'LeftToeBase', 'RightToeBase'}) | {'Chest'}
# Anatomical directions calibrate A/T poses without changing the user's bind rig.
CHILD = {'Hips': 'Chest', 'Spine1': 'Chest', 'Spine2': 'Chest', 'Chest': 'Head',
         'Neck1': 'Head', 'Neck2': 'Head'}
for _side in ('Left', 'Right'):
    CHILD.update({_side+'Shoulder': _side+'Arm', _side+'Arm': _side+'ForeArm',
                  _side+'ForeArm': _side+'Hand', _side+'Leg': _side+'Shin',
                  _side+'Shin': _side+'Foot', _side+'Foot': _side+'ToeBase'})


def _world(parents, pose):
    positions, rotations = [], []
    for i, parent in enumerate(parents):
        q = Rotation.from_quat(pose[i]['quaternion'])
        p = np.asarray(pose[i]['position'], dtype=float)
        positions.append(p if parent < 0 else positions[parent] + rotations[parent].apply(p))
        rotations.append(q if parent < 0 else rotations[parent] * q)
    return np.asarray(positions), rotations


def _mapping(rig):
    cleaned = [re.sub(r'^mixamorig\d*', '', re.sub('[^a-z0-9]', '', n.rsplit(':', 1)[-1].lower())) for n in rig['names']]
    rest_p, _ = _world(rig['parents'], rig['restPose'])
    result = {}

    def resolve(alias):
        found = [i for i, n in enumerate(cleaned) if n == alias]
        if len(found) > 1:
            # Some FBXs wrap a bone in a coincident same-named transform.
            last = max(found)
            ancestors, p = {last}, rig['parents'][last]
            while p >= 0:
                ancestors.add(p)
                p = rig['parents'][p]
            if not set(found) <= ancestors or any(np.linalg.norm(rest_p[i]-rest_p[last]) > 1e-5 for i in found):
                raise ValueError(f'MotionBricks found more than one {alias} joint. Rename the ambiguous joints first.')
            # Drive the ancestor that owns the branch. In FBX, the coincident
            # distal bone can be a leaf while the next limb hangs off its wrapper.
            return min(found)
        return found[0] if found else None

    for target, aliases in ALIASES.items():
        for alias in aliases:
            found = resolve(alias)
            if found is not None:
                result[NAMES.index(target)] = found
                break
    for pattern, targets in [(r'(spine\d*|chest|upperchest)', ['Spine1', 'Spine2', 'Chest']),
                             (r'neck\d*', ['Neck1', 'Neck2'])]:
        candidates = list(dict.fromkeys(resolve(n) for n in cleaned if re.fullmatch(pattern, n)))
        if candidates:
            destinations = targets if len(candidates) >= len(targets) else ([targets[0], targets[-1]] if len(candidates) == 2 else [targets[-1]])
            for name, index in zip(destinations, np.linspace(0, len(candidates)-1, len(destinations)).round().astype(int)):
                result[NAMES.index(name)] = candidates[index]
    missing = REQUIRED - {NAMES[i] for i in result}
    if missing:
        raise ValueError('MotionBricks needs a recognized humanoid rig. Missing joints: ' + ', '.join(sorted(missing)) + '. Use a Mixamo or Unreal humanoid rig.')
    if len(set(result.values())) != len(result):
        raise ValueError('MotionBricks could not resolve distinct humanoid joints.')
    # Mapping the wrong anatomy would still yield finite, unusable animation.
    for joint, source in result.items():
        ancestor = PARENTS[joint]
        while ancestor >= 0 and ancestor not in result:
            ancestor = PARENTS[ancestor]
        if ancestor >= 0:
            parent = rig['parents'][source]
            while parent >= 0 and parent != result[ancestor]:
                parent = rig['parents'][parent]
            if parent < 0:
                raise ValueError('MotionBricks needs a connected humanoid hierarchy. Check the torso, head and limb joint mapping.')
    return result


def _between(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    if min(np.linalg.norm(a), np.linalg.norm(b)) < 1e-6:
        raise ValueError('MotionBricks needs nonzero arm, leg and torso lengths.')
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    cross, dot = np.cross(a, b), float(np.clip(np.dot(a, b), -1, 1))
    if dot < -0.999999:
        axis = np.cross(a, [1, 0, 0] if abs(a[0]) < .9 else [0, 1, 0])
        return Rotation.from_rotvec(axis / np.linalg.norm(axis) * np.pi)
    return Rotation.from_quat([*cross, 1 + dot])


class Retargeter:
    def __init__(self, rig):
        self.rig, self.mapping = rig, _mapping(rig)
        self.rest_p, self.rest_q = _world(rig['parents'], rig['restPose'])
        self.native_p = np.asarray([sum((OFFSETS[k] for k in self._ancestors(i)), start=np.zeros(3)) for i in range(30)])
        m = self.mapping
        self.hips = m[0]
        height = np.linalg.norm(self.rest_p[m[6]] - (self.rest_p[m[24]] + self.rest_p[m[28]]) * .5)
        native_height = np.linalg.norm(self.native_p[6] - (self.native_p[24] + self.native_p[28]) * .5)
        if height < .05:
            raise ValueError('MotionBricks could not measure this humanoid’s height.')
        self.scale = native_height / height
        across = self.rest_p[m[22]] - self.rest_p[m[26]]
        across[1] = 0
        if np.linalg.norm(across) < 1e-6:
            raise ValueError('MotionBricks could not measure this humanoid’s hip direction.')
        facing = Rotation.from_rotvec([0, math.atan2(-across[2], across[0]), 0])
        self.calibration = []
        for i, name in enumerate(NAMES):
            child = NAMES.index(CHILD[name]) if name in CHILD else None
            correction = facing
            if i in m and child in m:
                correction = _between(facing.apply(self.native_p[child]-self.native_p[i]), self.rest_p[m[child]]-self.rest_p[m[i]]) * facing
            # The ONNX API uses SOMA's native joint frames. Its wrapper converts
            # these to the learned capture frames internally; identity quaternions
            # here would describe a contorted body, even in a geometric T pose.
            self.calibration.append(correction * NEUTRAL_ROTATIONS[i])

    @staticmethod
    def _ancestors(i):
        while i >= 0:
            yield i
            i = PARENTS[i]

    def encode(self, pose):
        source_p, source_q = _world(self.rig['parents'], pose)
        positions, rotations = [], []
        for i, parent in enumerate(PARENTS):
            s = self.mapping.get(i)
            q = source_q[s] * self.rest_q[s].inv() * self.calibration[i] if s is not None else (rotations[parent] * NEUTRAL_ROTATIONS[parent].inv() * NEUTRAL_ROTATIONS[i] if parent >= 0 else NEUTRAL_ROTATIONS[i])
            p = self.native_p[0] + (source_p[self.hips] - self.rest_p[self.hips]) * self.scale if i == 0 else positions[parent] + (rotations[parent] * NEUTRAL_ROTATIONS[parent].inv()).apply(OFFSETS[i])
            positions.append(p)
            rotations.append(q)
        return np.asarray(positions), Rotation.concatenate(rotations)

    def decode(self, pose, native_root, native_rotations):
        output = copy.deepcopy(pose)
        source_p, source_q = _world(self.rig['parents'], pose)
        root = self.hips
        while self.rig['parents'][root] >= 0:
            root = self.rig['parents'][root]
        if root != self.hips:
            # Carry generated heading on an outer gameplay root. The pelvis's
            # local rotation then retains only its relative body articulation.
            desired = native_rotations[0] * self.calibration[0].inv() * self.rest_q[self.hips]
            delta = (desired * source_q[self.hips].inv()).as_quat()
            twist = np.array([0., delta[1], 0., delta[3]])
            if np.linalg.norm(twist) > 1e-8:
                output[root]['quaternion'] = (Rotation.from_quat(twist) * source_q[root]).as_quat().tolist()
        inverse = {s: n for n, s in self.mapping.items()}
        world_q = []
        for i, parent in enumerate(self.rig['parents']):
            n = inverse.get(i)
            local = Rotation.from_quat(output[i]['quaternion'])
            q = native_rotations[n] * self.calibration[n].inv() * self.rest_q[i] if n is not None else (world_q[parent] * local if parent >= 0 else local)
            output[i]['quaternion'] = (world_q[parent].inv() * q if parent >= 0 else q).as_quat().tolist()
            world_q.append(q)
        # Move the outer skeleton root even when Hips has an Armature/Root parent.
        desired_hips = self.rest_p[self.hips] + (native_root - self.native_p[0]) / self.scale
        # FK with the new rotations accounts for intermediate root-to-pelvis offsets.
        new_p, _ = _world(self.rig['parents'], output)
        output[root]['position'] = (source_p[root] + desired_hips - new_p[self.hips]).tolist()
        return output


def _heading(positions):
    across = positions[26] - positions[22]
    forward = np.cross([0, 1, 0], across)
    return math.atan2(forward[0], forward[2])


def _inputs(guides, target_count, tokens):
    origin = guides[3][0][0].copy()
    origin[1] = 0
    alignment = Rotation.from_rotvec([0, _heading(guides[3][0]) - np.pi / 2, 0])
    positions = [alignment.inv().apply(p-origin) for p, _ in guides]
    rotations = [alignment.inv() * q for _, q in guides]
    headings = [_heading(p) for p in positions]
    roots, velocities, poses = [], [], []
    for i in range(8):
        nxt = i if i == 3 else min(i+1, 7)
        hips = positions[i][0]
        roots.append([*hips, math.cos(headings[i]), math.sin(headings[i])])
        delta = math.atan2(math.sin(headings[nxt]-headings[i]), math.cos(headings[nxt]-headings[i]))
        velocity = (positions[nxt][0]-hips)*30
        velocities.append([delta*30, velocity[0], velocity[2], hips[1]])
        ground = hips.copy(); ground[1] = 0
        # 6D rotations are two complete matrix columns, not interleaved rows.
        columns = rotations[i].as_matrix()[:, :, :2].transpose(0, 2, 1).reshape(-1)
        poses.append(np.concatenate([(positions[i][1:]-ground).reshape(-1), columns]))
    given = np.zeros((1, 8), dtype=np.int32); given[:, :4+target_count] = 1
    derivatives = given.copy(); derivatives[:, [3, 3+target_count]] = 0
    allowed = np.zeros((1, 11), dtype=np.int32); allowed[0, tokens-6] = 1
    return {'global_root_values': np.asarray([roots], dtype=np.float32), 'has_global_root_values': given,
            'local_root_values': np.asarray([velocities], dtype=np.float32), 'has_local_root_values': derivatives,
            'local_poses': np.asarray([poses], dtype=np.float32), 'has_local_poses': given.copy(),
            'allowed_pred_num_tokens': allowed}, (origin, alignment)


def _prediction(session, guides, target_count, seconds):
    tokens = int(np.clip(round((seconds*30+7)/4), 6, 16))
    inputs, (origin, alignment) = _inputs(guides, target_count, tokens)
    raw, count = session.run(['pred_global_motions', 'pred_num_tokens'], inputs)
    if int(count[0]) != tokens or raw.shape != (1, 64, 366) or not np.isfinite(raw).all():
        raise RuntimeError('MotionBricks returned an invalid motion. Your poses were kept.')
    features = raw[0, 3:4*tokens-3]
    root = alignment.apply(features[:, :3]) + origin
    axes = features[:, 92:272].reshape(-1, 30, 2, 3).astype(float)
    x = axes[:, :, 0]; x /= np.maximum(np.linalg.norm(x, axis=-1, keepdims=True), 1e-10)
    z = np.cross(x, axes[:, :, 1]); lengths = np.linalg.norm(z, axis=-1, keepdims=True)
    if np.any(lengths < 1e-6):
        raise RuntimeError('MotionBricks returned an invalid joint rotation. Your poses were kept.')
    z /= lengths
    matrices = np.stack([x, np.cross(z, x), z], axis=-1)
    q = (alignment * Rotation.from_matrix(matrices.reshape(-1, 3, 3))).as_quat().reshape(-1, 30, 4)
    return root, q


def _sample(frames, at):
    times = np.asarray([f['time'] for f in frames])
    hi = int(np.clip(np.searchsorted(times, at, side='right'), 1, len(frames)-1))
    lo = hi-1
    t = float(np.clip((at-times[lo])/(times[hi]-times[lo]), 0, 1))
    output = copy.deepcopy(frames[lo]['pose'])
    for i, bone in enumerate(output):
        for field in ('position', 'scale'):
            bone[field] = ((1-t)*np.asarray(bone[field])+t*np.asarray(frames[hi]['pose'][i][field])).tolist()
        bone['quaternion'] = Slerp([0, 1], Rotation.from_quat([bone['quaternion'], frames[hi]['pose'][i]['quaternion']]))([t]).as_quat()[0].tolist()
    return output


def generate_motion(request, progress):
    if request['rig'].get('kind') != 'humanoid':
        raise ValueError('MotionBricks supports humanoid bodies. Use another engine for this character.')
    if request.get('kind') != 'inbetween' or not 0 < request['duration'] <= 20:
        raise ValueError('MotionBricks generates humanoid clips up to 20 seconds.')
    anchors = request['anchors']
    if len(anchors) < 2 or abs(anchors[0]['time']) > 1e-6 or abs(anchors[-1]['time']-request['duration']) > 1e-5:
        raise ValueError('Add a pose at the beginning and end before generating with MotionBricks.')
    if any(b['time']-a['time'] < 1/30-1e-6 for a, b in zip(anchors, anchors[1:])):
        raise ValueError('Space your key poses at least one frame apart for MotionBricks.')
    # Still absorbs source scales into normalized world offsets before submission.
    # Refuse non-normalized external payloads instead of silently ignoring scale.
    poses = [request['rig']['restPose']] + [f['pose'] for f in request['frames']+anchors]
    if not np.allclose([[b['scale'] for b in pose] for pose in poses], 1., atol=1e-6, rtol=0):
        raise ValueError('MotionBricks needs normalized joint scales. Import this rig through Still before generating.')
    retargeter = Retargeter(request['rig'])
    model = Path(request.get('runtime', {}).get('modelPath', ''))
    if not model.is_file():
        raise RuntimeError('Install the human motion model with scripts/setup-motionbricks.ps1, then try again.')
    progress('Checking the human motion model…', .04)
    digest = hashlib.sha256()
    with model.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_SHA256:
        raise RuntimeError('The MotionBricks model is incomplete or changed. Reinstall Still or run scripts/setup-motionbricks.ps1 again.')
    ort = load_onnxruntime()
    started = time.monotonic()
    progress('Loading MotionBricks on this computer…', .1)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    # CPU inference is portable and avoids requiring a CUDA installation.
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    targets = []
    for a, b in zip(anchors, anchors[1:]):
        steps = max(1, math.ceil((b['time']-a['time'])/1.7))
        targets.extend(np.linspace(a['time'], b['time'], steps+1)[1:].tolist())
    generated = [{'time': 0., 'pose': copy.deepcopy(anchors[0]['pose'])}]
    boundary = 0.
    native_frames, retimed = 0, False
    for segment, end in enumerate(targets):
        progress(f'Animating transition {segment+1} of {len(targets)}…', .15+.75*segment/len(targets))
        source = request['frames']
        start_pose = generated[-1]['pose']
        end_pose = next((a['pose'] for a in anchors if abs(a['time']-end) < 1e-6), None)
        authored_end = end_pose is not None
        if end_pose is None:
            end_pose = _sample(source, end)
        context = [retargeter.encode(_sample(generated, max(0., boundary-(3-i)/30)) if len(generated)>1 else start_pose) for i in range(4)]
        # One target marks a stop at the last key; later source frames describe
        # velocity at an internal key, without inventing extra authored keys.
        target_count = 1 if abs(end-request['duration']) < 1e-6 else min(4, 1+int((request['duration']-end)*30))
        target_poses = [end_pose]+[_sample(source, min(request['duration'], end+i/30)) for i in range(1, target_count)]
        target = [retargeter.encode(p) for p in target_poses]
        target += [target[-1]]*(4-len(target))
        root, quats = _prediction(session, context+target, target_count, end-boundary)
        if not authored_end:
            # The next segment starts from the learned state, rather than forcing
            # a hard stop on an interpolated pose at every internal boundary.
            predicted_end = retargeter.decode(end_pose, root[-1], Rotation.from_quat(quats[-1]))
            # A soft guide limits accumulated drift without hard-pinning every
            # intermediate boundary to the interpolated source pose.
            end_pose = _sample([{'time': 0., 'pose': predicted_end}, {'time': 1., 'pose': end_pose}], .5)
        native_frames += len(root)
        retimed |= abs((len(root)-1)/30-(end-boundary)) > 4/30
        axis = np.linspace(0, 1, len(root))
        rotations = [Slerp(axis, Rotation.from_quat(quats[:, i])) for i in range(30)]
        # Correct after retargeting so exact source keys don't create a pop on
        # rigs with different proportions, rest poses or extra spine joints.
        endpoints = [retargeter.decode(_sample(source, at), root[k], Rotation.from_quat(quats[k])) for at, k in [(boundary, 0), (end, -1)]]
        corrections = [Slerp([0, 1], Rotation.from_quat([
            (Rotation.from_quat(pose[i]['quaternion'])*Rotation.from_quat(pred[i]['quaternion']).inv()).as_quat()
            for pose, pred in zip([start_pose, end_pose], endpoints)])) for i in range(len(start_pose))]
        outer = retargeter.hips
        while request['rig']['parents'][outer] >= 0:
            outer = request['rig']['parents'][outer]
        offsets = [np.asarray(pose[outer]['position'])-pred[outer]['position'] for pose, pred in zip([start_pose, end_pose], endpoints)]
        times = sorted(set([f['time'] for f in source if boundary+1e-7 < f['time'] < end-1e-7]+[end]))
        for at in times:
            fraction = float(np.clip((at-boundary)/(end-boundary), 0, 1))
            if abs(at-end) < 1e-7:
                output = copy.deepcopy(end_pose)
            else:
                native_root = np.asarray([np.interp(fraction, axis, root[:, i]) for i in range(3)])
                q = Rotation.concatenate([s(fraction) for s in rotations])
                output = retargeter.decode(_sample(source, at), native_root, q)
                for i, bone in enumerate(output):
                    bone['quaternion'] = (corrections[i](fraction)*Rotation.from_quat(bone['quaternion'])).as_quat().tolist()
                output[outer]['position'] = (np.asarray(output[outer]['position'])+(1-fraction)*offsets[0]+fraction*offsets[1]).tolist()
            generated.append({'time': at, 'pose': output})
        boundary = end
    progress('Your humanoid motion is ready…', .96)
    warnings = ['Body motion is retargeted through SOMA. Review foot contacts and unusual proportions; physics correction is a separate pass.']
    if retimed:
        warnings.append('Generated transitions were retimed to keep your authored key times.')
    return {'frames': generated, 'provider': PROVIDER, 'warnings': warnings,
            'metrics': {'engine': 'NVIDIA MotionBricks SOMA RP v1', 'modelSha256': MODEL_SHA256,
                        'runtime': 'ONNX Runtime CPU', 'seconds': round(time.monotonic()-started, 3),
                        'segments': len(targets), 'nativeFrames': native_frames, 'mappedJoints': len(retargeter.mapping),
                        'authoredPosesPreserved': True, 'keyTimesPreserved': True,
                        'deterministic': True, 'retimed': retimed}}
