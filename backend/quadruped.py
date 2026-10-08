"""Local learned quadruped transitions trained from CC0 authored motion.

Only this project's randomly initialized, trained checkpoint is accepted. The
canonical joint adapter never replaces the source character or its skin weights.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import time
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from backend.inbetween import _sample, _fk, _align

PROVIDER = {
    'id': 'quadruped', 'name': 'Still Quadruped', 'learned': True,
    'description': 'Fresh local transition model trained on Quaternius CC0 animal animation; check the installed quality report.',
}
NAMES = ['Hips', 'Spine', 'Neck', 'Head', 'Tail', 'TailTip'] + [f'{pair}{side}{joint}' for side in ['Left', 'Right'] for pair in ['Front', 'Hind'] for joint in ['UpperLeg', 'LowerLeg', 'Foot']]
PARENTS = [-1, 0, 1, 2, 0, 4, 1, 6, 7, 0, 9, 10, 1, 12, 13, 0, 15, 16]


def _mapping(rig):
    names = rig['names']
    normalized = [re.sub(r'[^a-z0-9]', '', name.rsplit(':', 1)[-1].lower()) for name in names]
    candidates = [['hips', 'back', 'pelvis'], ['spine', 'torso2', 'chest'], ['neck', 'neck2', 'neck1'],
                  ['head'], ['tail', 'tail2', 'tail1'], ['tailtip']]
    for side, suffix in [('left', 'l'), ('right', 'r')]:
        candidates += [[f'front{side}upperleg', f'frontupperleg{suffix}'],
                       [f'front{side}lowerleg', f'frontlowerleg{suffix}'],
                       [f'front{side}foot', f'ff{suffix}', f'frontfoot{suffix}'],
                       [f'hind{side}upperleg', f'backleg{suffix}'],
                       [f'hind{side}lowerleg', f'backupperleg{suffix}'],
                       [f'hind{side}foot', f'ffb{suffix}', f'backfoot{suffix}']]
    found = [next((normalized.index(value) for value in options if value in normalized), None) for options in candidates]
    if found[5] is None:
        tails = [(int(match.group(1)), index) for index, value in enumerate(normalized) if (match := re.fullmatch(r'tail(\d+)', value))]
        if tails:
            found[5] = max(tails)[1]
    missing = [NAMES[index] for index, value in enumerate(found) if value is None]
    if missing:
        raise ValueError('The learned quadruped engine needs the four-legged starter rig or recognized animal joints. Missing: ' + ', '.join(missing))
    return found


def _retarget(positions, quaternions, parents, mapping, learned):
    """Align source bone directions and translate a true root; keep local lengths."""
    original_world, original_rotation = _fk(positions, quaternions, parents)
    driven = {source: canonical for canonical, source in enumerate(mapping)}
    children = {source: [] for source in driven}
    for canonical, parent in enumerate(PARENTS):
        if parent >= 0:
            children[mapping[parent]].append(mapping[canonical])
    body_root = mapping[0]
    while parents[body_root] >= 0:
        body_root = parents[body_root]
    output_positions, output_rotations = positions.copy(), quaternions.copy()
    output_positions[:, body_root] += learned[:, 0] - original_world[:, mapping[0]]
    # Some authored animal rigs have separate IK foot roots. Move those roots
    # to the generated foot while retaining every non-root local bone offset.
    translated_roots = {body_root}
    for canonical, joint in enumerate(mapping):
        root = joint
        while parents[root] >= 0:
            root = parents[root]
        if root not in translated_roots:
            output_positions[:, root] += learned[:, canonical] - original_world[:, joint]
            translated_roots.add(root)
    for frame in range(len(positions)):
        world_rotations = []
        for joint, parent in enumerate(parents):
            parent_rotation = Rotation.identity() if parent < 0 else world_rotations[parent]
            local = Rotation.from_quat(quaternions[frame, joint])
            if joint in driven and children[joint]:
                targets = children[joint]
                source_vectors = original_world[frame, targets] - original_world[frame, joint]
                destination = learned[frame, [driven[value] for value in targets]] - learned[frame, driven[joint]]
                delta = _align(source_vectors.copy(), destination.copy())
                local = parent_rotation.inv() * delta * Rotation.from_quat(original_rotation[frame, joint])
            output_rotations[frame, joint] = local.as_quat()
            world_rotations.append(parent_rotation * local)
    return output_positions, output_rotations


def _load(runtime, progress):
    import torch
    from safetensors.torch import load_file
    from backend.learned_motion import create_model

    config = runtime.get('config', runtime)
    directory = Path(config['checkpointPath'])
    metadata = json.loads((directory / 'model.json').read_text(encoding='utf-8'))
    validation = directory / 'validation.json'
    metadata['validation'] = json.loads(validation.read_text(encoding='utf-8')) if validation.is_file() else {}
    digest = hashlib.sha256((directory / 'model.safetensors').read_bytes()).hexdigest()
    if digest != config['modelSha256'] or digest != metadata['modelSha256']:
        raise RuntimeError('Quadruped checkpoint verification failed. Reinstall the trained local model.')
    if metadata.get('pretrainedWeightsUsed') is not False or metadata.get('initializedFrom') != 'random':
        raise RuntimeError('The local quadruped checkpoint has unverified training provenance.')
    torch.set_num_threads(4)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    if device.type == 'cuda':
        torch.cuda.reset_peak_memory_stats()
    progress('Loading the CC0-trained quadruped prior…', .12)
    model = create_model(metadata).to(device)
    model.load_state_dict(load_file(str(directory / 'model.safetensors')), strict=True)
    model.eval()
    return model, metadata


def generate_motion(request, progress):
    started = time.perf_counter()
    if request['rig']['kind'] != 'quadruped':
        raise ValueError('Still Quadruped accepts four-legged animal rigs. Choose the humanoid engine for people.')
    duration = float(request['duration'])
    if not .1 <= duration <= 60:
        raise ValueError('Learned quadruped clips must be between 0.1 and 60 seconds.')
    anchors, rig = request['anchors'], request['rig']
    if len(anchors) < 2:
        raise ValueError('Add at least two authored poses before generating quadruped motion.')
    mapping = _mapping(rig)
    count = max(3, int(round(duration * 20)) + 1)
    times = np.linspace(0, duration, count)
    key_indices = np.array([int(np.argmin(abs(times - anchor['time']))) for anchor in anchors])
    if len(set(key_indices)) != len(key_indices):
        raise ValueError('Quadruped poses must occupy distinct frames at the model’s 20 fps resolution.')
    progress('Mapping the original four-legged skeleton…', .06)
    local, rotations = _sample(anchors, times)
    for index, anchor in zip(key_indices, anchors):
        local[index] = [bone['position'] for bone in anchor['pose']]
        rotations[index] = [bone['quaternion'] for bone in anchor['pose']]
    world, _ = _fk(local, rotations, rig['parents'])
    canonical = world[:, mapping]
    rest_world, _ = _fk(np.array([[bone['position'] for bone in rig['restPose']]]),
                        np.array([[bone['quaternion'] for bone in rig['restPose']]]), rig['parents'])
    rest = rest_world[0, mapping]
    origin = rest[0] * np.array([1, 0, 1])
    origin[1] = rest[[8, 11, 14, 17], 1].min()
    height = rest[0, 1] - origin[1]
    if height < .01:
        raise ValueError('The quadruped rest pose must stand upright with its hips above its feet.')
    normalized = ((canonical - origin) / height).reshape(count, -1)
    normalized_rest = ((rest - origin) / height).reshape(-1)
    runtime = request.get('runtime')
    if not runtime:
        raise RuntimeError('No trained local quadruped runtime is configured.')
    model, metadata = _load(runtime, progress)
    import torch
    from backend.learned_motion import sample_motion

    mean, std = np.asarray(metadata['mean']), np.asarray(metadata['std'])
    if len(mean) != 54:
        raise RuntimeError('The quadruped model has an incompatible joint representation.')
    window_frames, overlap = int(metadata['windowFrames']), 20
    stride = window_frames - overlap
    starts = [0]
    while starts[-1] + window_frames < count:
        starts.append(starts[-1] + stride)
    generated = normalized.copy()
    sampling_start = time.perf_counter()
    for window, start in enumerate(starts):
        end = min(start + window_frames, count)
        observed = [int(value - start) for value in key_indices if start <= value < end]
        incoming = normalized[start:end].copy()
        if start:
            context = min(overlap, end - start)
            incoming[:context] = generated[start:start + context]
            observed += list(range(context))
        # Real authored observations take precedence over generated overlap.
        for index in key_indices:
            if start <= index < end:
                incoming[index - start] = normalized[index]
        observed = sorted(set(observed))
        if not observed:
            observed = [0]
        linear = np.stack([np.interp(np.arange(end - start), observed, incoming[observed, feature]) for feature in range(54)], axis=-1)
        device = next(model.parameters()).device
        baseline = torch.tensor((linear - mean) / std, dtype=torch.float32, device=device)[None]
        mask = torch.zeros((1, end - start, 1), device=device)
        mask[:, observed] = 1
        body = torch.tensor((normalized_rest - mean) / std, dtype=torch.float32, device=device)[None]
        def report(fraction):
            progress(f'Generating learned animal transitions · section {window + 1} of {len(starts)}…', .2 + .62 * (window + fraction) / len(starts))
        result = sample_motion(model, baseline, mask, body, int(request.get('seed', 42)) + window, 40, report)
        generated[start:end] = result[0].cpu().numpy() * std + mean
    for index in key_indices:
        generated[index] = normalized[index]
    if not np.isfinite(generated).all():
        raise RuntimeError('The learned quadruped model returned invalid motion. The existing animation is unchanged.')
    sample_seconds = time.perf_counter() - sampling_start
    generated = generated.reshape(count, 18, 3) * height + origin
    unknown = np.ones(count, dtype=bool)
    unknown[key_indices] = False
    learned_rms = float(np.sqrt(np.mean((generated[unknown] - canonical[unknown]) ** 2))) if unknown.any() else 0.
    authored_times = {float(anchor['time']) for anchor in anchors}
    candidates = sorted([index / request['fps'] for index in range(int(math.floor(duration * request['fps'])) + 1)] + list(authored_times) + [duration])
    output_times = []
    for timestamp in candidates:
        if output_times and timestamp - output_times[-1] < 1e-6:
            if timestamp in authored_times or output_times[-1] not in authored_times:
                output_times[-1] = timestamp
        else:
            output_times.append(timestamp)
    interpolated = np.stack([np.interp(output_times, times, generated.reshape(count, -1)[:, axis]) for axis in range(54)], axis=-1).reshape(len(output_times), 18, 3)
    progress('Returning motion to the original animal skeleton…', .9)
    positions, quaternions = _sample(request['frames'], output_times)
    positions, quaternions = _retarget(positions, quaternions, rig['parents'], mapping, interpolated)
    frames = []
    for index, timestamp in enumerate(output_times):
        anchor = next((anchor for anchor in anchors if abs(timestamp - anchor['time']) < 1e-8), None)
        pose = anchor['pose'] if anchor else [{'position': position.tolist(), 'quaternion': quaternion.tolist(), 'scale': [1., 1., 1.]}
                                             for position, quaternion in zip(positions[index], quaternions[index])]
        frames.append({'time': timestamp, 'pose': pose})
    warnings = ['This small learned animal prior was trained on stylized CC0 quadruped animation. Review unfamiliar animal proportions, rapid turns and physical contact. Original skin weights and authored poses are preserved.']
    if not metadata['validation'].get('beatsInterpolation'):
        warnings.append('The installed quadruped model has no demonstrated full held-out improvement over interpolation.')
    if len(starts) > 1:
        warnings.append('Long clips use overlapping motion windows; review transitions for drift.')
    return {'frames': frames, 'provider': PROVIDER, 'warnings': warnings,
            'metrics': {'model': 'Still Quadruped', 'modelSha256': metadata['modelSha256'],
                        'learnedParameters': metadata['parameters'], 'pretrainedWeightsUsed': False,
                        'trainingClips': len(metadata['trainingClipIds']), 'heldOutClips': len(metadata['heldOutClipIds']),
                        'nativeFps': 20, 'seed': int(request.get('seed', 42)), 'diffusionSteps': 40 if metadata.get('objective', 'diffusion') == 'diffusion' else 0,
                        'modelFamily': metadata['architecture'].get('family', 'denoiser'),
                        'heldOutValidation': metadata['validation'],
                        'quality': {'requiresReview': True, 'reasons': ['Limited stylized-animal corpus; review contacts and unfamiliar anatomy.']},
                        'windows': len(starts), 'conditionedFrames': len(anchors), 'generatedFrames': len(frames),
                        'learnedVsInterpolationRmsMeters': learned_rms, 'inferenceSeconds': sample_seconds,
                        'totalSeconds': time.perf_counter() - started,
                        'device': str(next(model.parameters()).device),
                        'peakGpuMemoryMiB': torch.cuda.max_memory_allocated() / 1024 ** 2 if next(model.parameters()).device.type == 'cuda' else 0}}
