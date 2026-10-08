"""Freshly trained humanoid prior; uses only documented CC0 authored motion.

All geometry below is ordinary forward kinematics and directional retargeting.
No third-party body model, pretrained weights, or dataset statistics are used.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
import re
import time
from pathlib import Path
import numpy as np
from scipy.spatial.transform import Rotation

PROVIDER = {'id': 'owned_humanoid', 'name': 'Still humanoid (experimental)', 'learned': True,
            'description': 'Fresh CC0-trained humanoid network. Limited training coverage; no demonstrated quality gain over interpolation.'}
FPS = 20
JOINTS = [
    ('hips', 'pelvis', 'root'), ('spine', 'spine01'), ('chest', 'spine03', 'spine2', 'spine1'),
    ('neck', 'neck01'), ('head',), ('leftshoulder', 'claviclel'), ('leftarm', 'upperarml'),
    ('leftforearm', 'lowerarml'), ('lefthand', 'handl'), ('rightshoulder', 'clavicler'),
    ('rightarm', 'upperarmr'), ('rightforearm', 'lowerarmr'), ('righthand', 'handr'),
    ('leftupleg', 'leftthigh', 'thighl'), ('leftleg', 'leftshin', 'calfl'), ('leftfoot', 'footl'),
    ('lefttoebase', 'lefttoe', 'balll'), ('rightupleg', 'rightthigh', 'thighr'),
    ('rightleg', 'rightshin', 'calfr'), ('rightfoot', 'footr'), ('righttoebase', 'righttoe', 'ballr')]


def mapping(rig):
    names = [re.sub('[^a-z0-9]', '', re.sub(r'^mixamorig\d*[:_]*', '', name, flags=re.I).lower()) for name in rig['names']]
    parents = rig['parents']
    result = []
    for aliases in JOINTS:
        candidates = next(([i for i, name in enumerate(names) if name == alias] for alias in aliases if alias in names), [])
        if not candidates:
            result.append(None)
            continue
        # FBX can repeat the same named joint along a coincident helper chain.
        def ancestor(a, b):
            while b >= 0:
                if b == a: return True
                b = parents[b]
            return False
        if any(not ancestor(a, b) and not ancestor(b, a) for a in candidates for b in candidates):
            raise ValueError('Ambiguous humanoid mapping: ' + aliases[0])
        result.append(max(candidates, key=lambda b: sum(ancestor(a, b) for a in candidates)))
    required = [0, 1, 2, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19]
    missing = [JOINTS[i][0] for i in required if result[i] is None]
    if missing: raise ValueError('Still humanoid needs recognizable body joints: ' + ', '.join(missing))
    return result


def arrays(frames):
    times = np.asarray([frame['time'] for frame in frames], dtype=float)
    p = np.asarray([[bone['position'] for bone in frame['pose']] for frame in frames], dtype=float)
    q = np.asarray([[bone['quaternion'] for bone in frame['pose']] for frame in frames], dtype=float)
    scale = np.asarray([[bone.get('scale', [1, 1, 1]) for bone in frame['pose']] for frame in frames])
    if not np.isfinite(p).all() or not np.isfinite(q).all() or np.any(np.linalg.norm(q, axis=-1) < 1e-8):
        raise ValueError('Invalid humanoid transforms.')
    if np.max(np.abs(scale - 1)) > 1e-4: raise ValueError('Normalize joint scales before neural generation.')
    return times, p, q / np.linalg.norm(q, axis=-1, keepdims=True)


def sample(frames, times):
    source, p, q = arrays(frames)
    if len(source) == 1: return np.repeat(p, len(times), axis=0), np.repeat(q, len(times), axis=0)
    r = np.searchsorted(source, times, side='right').clip(1, len(source) - 1); l = r - 1
    a = ((times - source[l]) / np.maximum(source[r] - source[l], 1e-8)).clip(0, 1)[:, None, None]
    first, last = q[l], q[r]
    dot = np.sum(first * last, axis=-1, keepdims=True)
    last = np.where(dot < 0, -last, last); angle = np.arccos(np.abs(dot).clip(0, 1))
    sine = np.sin(angle)
    rotation = (np.sin((1 - a) * angle) * first + np.sin(a * angle) * last) / np.maximum(sine, 1e-8)
    rotation = np.where(sine < 1e-6, first * (1 - a) + last * a, rotation)
    return p[l] * (1 - a) + p[r] * a, rotation / np.linalg.norm(rotation, axis=-1, keepdims=True)


def fk(p, q, parents):
    wp, wq = np.empty_like(p), np.empty_like(q)
    for i, parent in enumerate(parents):
        if parent < 0: wp[:, i], wq[:, i] = p[:, i], q[:, i]
        else:
            rot = Rotation.from_quat(wq[:, parent])
            wp[:, i] = wp[:, parent] + rot.apply(p[:, i]); wq[:, i] = (rot * Rotation.from_quat(q[:, i])).as_quat()
    return wp, wq


def canonical(world, indices):
    out = np.zeros((len(world), len(JOINTS), 3))
    for i, index in enumerate(indices):
        if index is not None: out[:, i] = world[:, index]
    if indices[3] is None: out[:, 3] = out[:, 2] * .35 + out[:, 4] * .65
    for clavicle, arm in [(5, 6), (9, 10)]:
        if indices[clavicle] is None: out[:, clavicle] = out[:, 2] * .55 + out[:, arm] * .45
    for toe, foot in [(16, 15), (20, 19)]:
        if indices[toe] is None: out[:, toe] = out[:, foot] + [0, 0, .08]
    return out


def features(request, times=None):
    rig = request['rig']; indices = mapping(rig); parents = rig['parents']
    if times is None: times = np.linspace(0, request['duration'], round(request['duration'] * FPS) + 1)
    p, q = sample(request['frames'], times)
    world = canonical(fk(p, q, parents)[0], indices)
    _, rp, rq = arrays([{'time': 0, 'pose': rig['restPose']}])
    rest = canonical(fk(rp, rq, parents)[0], indices)[0]
    height = float(rest[4, 1] - min(rest[15, 1], rest[19, 1]))
    if height < .1: raise ValueError('The humanoid rest pose must be upright and use meters with Y up.')
    across = rest[17] - rest[13]
    yaw = math.atan2(across[2], across[0]) - math.pi
    rotation = Rotation.from_euler('y', yaw)
    origin = np.array([world[0, 0, 0], min(rest[15, 1], rest[19, 1]), world[0, 0, 2]])
    rest_origin = np.array([rest[0, 0], origin[1], rest[0, 2]])
    encoded = rotation.apply((world - origin).reshape(-1, 3)).reshape(len(world), -1) / height
    encoded_rest = rotation.apply(rest - rest_origin).reshape(-1) / height
    return encoded.astype(np.float32), encoded_rest.astype(np.float32), (indices, height, rotation, origin)


def align(a, b):
    valid = (np.linalg.norm(a, axis=1) > 1e-8) & (np.linalg.norm(b, axis=1) > 1e-8)
    a, b = a[valid], b[valid]
    if not len(a): return Rotation.identity()
    a = a / np.linalg.norm(a, axis=1, keepdims=True); b = b / np.linalg.norm(b, axis=1, keepdims=True)
    if len(a) == 1 or np.linalg.matrix_rank(a) < 2:
        dot = float(a[0] @ b[0])
        if dot < -.999999:
            axis = np.cross(a[0], [1, 0, 0])
            if np.linalg.norm(axis) < 1e-6: axis = np.cross(a[0], [0, 1, 0])
            return Rotation.from_rotvec(axis / np.linalg.norm(axis) * math.pi)
        return Rotation.from_quat(np.r_[np.cross(a[0], b[0]), 1 + dot])
    u, _, vh = np.linalg.svd(b.T @ a)
    return Rotation.from_matrix(u @ np.diag([1, 1, np.linalg.det(u @ vh)]) @ vh)


def retarget(p, q, parents, indices, learned):
    original, original_q = fk(p, q, parents)
    driven = {source: slot for slot, source in enumerate(indices) if source is not None}
    children = {source: [] for source in driven}
    for child in driven:
        parent = parents[child]
        while parent >= 0 and parent not in driven: parent = parents[parent]
        if parent >= 0: children[parent].append(child)
    roots = [i for i, parent in enumerate(parents) if parent < 0]
    if len(roots) != 1: raise ValueError('Still humanoid requires one connected skeleton.')
    out_p, out_q = p.copy(), q.copy()
    out_p[:, roots[0]] += learned[:, 0] - original[:, indices[0]]
    for t in range(len(p)):
        rotations = []
        for i, parent in enumerate(parents):
            parent_rot = Rotation.identity() if parent < 0 else rotations[parent]
            local = Rotation.from_quat(q[t, i])
            if i in driven and children[i]:
                ids = children[i]
                a = original[t, ids] - original[t, i]
                b = learned[t, [driven[j] for j in ids]] - learned[t, driven[i]]
                local = parent_rot.inv() * align(a, b) * Rotation.from_quat(original_q[t, i])
            out_q[t, i] = local.as_quat(); rotations.append(parent_rot * local)
    return out_p, out_q


def generate_motion(request, progress=lambda message, fraction: None):
    import torch
    from safetensors.torch import load_file
    from backend.learned_motion import PoseDenoiser, sample_motion
    started = time.perf_counter()
    if request['rig'].get('kind') != 'humanoid': raise ValueError('This model was trained only on humanoids.')
    parents = request['rig']['parents']
    if not 1 <= len(parents) <= 256 or any(parent >= i or parent < -1 for i, parent in enumerate(parents)):
        raise ValueError('The humanoid hierarchy must be parent-first and contain at most 256 joints.')
    duration = float(request['duration'])
    if not 0 < duration <= 12: raise ValueError('Still humanoid currently supports clips up to 12 seconds.')
    anchors = sorted(request['anchors'], key=lambda frame: frame['time'])
    if len(anchors) < 2: raise ValueError('Add at least two authored poses.')
    if any(not math.isfinite(frame['time']) or frame['time'] < 0 or frame['time'] > duration for frame in anchors):
        raise ValueError('Authored pose times must stay within the animation.')
    config = request.get('runtime', {}).get('config', request.get('runtime', {}))
    directory = Path(config['checkpointPath'])
    metadata = json.loads((directory / 'model.json').read_text(encoding='utf-8'))
    checkpoint = directory / 'model.safetensors'
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if digest != metadata['modelSha256'] or (config.get('modelSha256') and digest != config['modelSha256']):
        raise ValueError('Owned humanoid checkpoint hash mismatch.')
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    torch.set_num_threads(4)
    model = PoseDenoiser(**metadata['architecture']).to(device)
    model.load_state_dict(load_file(str(checkpoint))); model.eval()
    times = np.linspace(0, duration, round(duration * FPS) + 1)
    observed_indices = np.asarray([round(frame['time'] / duration * (len(times) - 1)) for frame in anchors])
    if len(set(observed_indices)) != len(anchors): raise ValueError('Move authored poses at least 1/20 second apart.')
    p, q = sample(anchors, times)
    baseline_request = dict(request, frames=[{'time': float(t), 'pose': [{'position': pos.tolist(), 'quaternion': rot.tolist(), 'scale': [1, 1, 1]} for pos, rot in zip(pp, qq)]} for t, pp, qq in zip(times, p, q)])
    baseline, rest, geometry = features(baseline_request, times)
    # Use linear observations in feature space, matching training exactly.
    for d in range(baseline.shape[1]): baseline[:, d] = np.interp(np.arange(len(times)), observed_indices, baseline[observed_indices, d])
    mean, std = np.asarray(metadata['mean']), np.asarray(metadata['std'])
    mask = np.zeros((len(times), 1), np.float32); mask[observed_indices] = 1
    tensor = lambda x: torch.as_tensor(x, dtype=torch.float32, device=device)
    progress('Generating with the freshly trained CC0 humanoid model…', .2)
    with torch.inference_mode():
        conditioned = tensor((baseline - mean) / std)[None]
        mask_tensor, rest_tensor = tensor(mask)[None], tensor((rest - mean) / std)[None]
        result = sample_motion(model, conditioned, mask_tensor, rest_tensor, seed=int(request.get('seed', 42)), steps=40)
    learned = result[0].cpu().numpy() * std + mean
    learned[observed_indices] = baseline[observed_indices]
    if not np.isfinite(learned).all(): raise ValueError('The neural model returned invalid motion.')
    indices, height, rotation, origin = geometry
    world = rotation.inv().apply((learned * height).reshape(-1, 3)).reshape(len(times), len(JOINTS), 3) + origin
    output_times = np.unique(np.r_[[frame['time'] for frame in request['frames']], [frame['time'] for frame in anchors], [0, duration]])
    sampled_world = np.stack([np.interp(output_times, times, world.reshape(len(times), -1)[:, d]) for d in range(len(JOINTS) * 3)], axis=1).reshape(len(output_times), len(JOINTS), 3)
    op, oq = sample(request['frames'], output_times)
    op, oq = retarget(op, oq, request['rig']['parents'], indices, sampled_world)
    output = []
    for t, pp, qq in zip(output_times, op, oq):
        authored = next((frame for frame in anchors if abs(frame['time'] - t) < 1e-7), None)
        pose = copy.deepcopy(authored['pose']) if authored else [{'position': a.tolist(), 'quaternion': b.tolist(), 'scale': [1, 1, 1]} for a, b in zip(pp, qq)]
        output.append({'time': float(t), 'pose': pose})
    return {'frames': output, 'provider': PROVIDER, 'metrics': {'modelSha256': digest, 'trainingData': 'Quaternius CC0 authored motion',
            'authoredPosesPreserved': True, 'learnedVsInterpolationRmsMeters': float(np.sqrt(np.mean((learned - baseline) ** 2)) * height),
            'seconds': time.perf_counter() - started, 'quality': {'requiresReview': True, 'reasons': ['Small training corpus; review generated poses and contact.']}},
            'warnings': ['This experimental humanoid prior did not outperform interpolation on the held-out motion test. Review the result; it is not a physics solver.']}
