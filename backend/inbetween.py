"""Local pretrained CondMDI inference, with a source-skeleton-preserving bridge.

The network and feature codecs are imported from a pinned, MIT-licensed MoLab
checkout installed by setup-ai-motion.ps1. Weights remain local, never bundled.
This module does not replace a character's skeleton or skin bindings.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
import time
import warnings as python_warnings
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

MODEL_FPS = 20
MODEL_FRAMES = 196
MODEL_HASH = 'ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361'
PROVIDER = {
    'id': 'condmdi', 'name': 'CondMDI', 'learned': True,
    'description': '235M-parameter pretrained motion diffusion model, sampled locally on your NVIDIA GPU.',
}

# HumanML3D/SMPL-22 ordering. None entries are synthesized from neighboring joints.
ALIASES = [
    ('hips', 'pelvis', 'root'),
    ('leftupleg', 'leftthigh', 'thighl'), ('rightupleg', 'rightthigh', 'thighr'),
    ('spine', 'spine01', 'spine1'),
    ('leftleg', 'leftcalf', 'calfl', 'leftknee'), ('rightleg', 'rightcalf', 'calfr', 'rightknee'),
    ('spine1', 'spine02'),
    ('leftfoot', 'footl', 'leftankle'), ('rightfoot', 'footr', 'rightankle'),
    ('spine2', 'spine03', 'chest', 'upperchest'),
    ('lefttoebase', 'lefttoe', 'balll'), ('righttoebase', 'righttoe', 'ballr'),
    ('neck', 'neck01'),
    ('leftshoulder', 'claviclel', 'leftclavicle'), ('rightshoulder', 'clavicler', 'rightclavicle'),
    ('head',),
    ('leftarm', 'upperarml', 'leftupperarm'), ('rightarm', 'upperarmr', 'rightupperarm'),
    ('leftforearm', 'lowerarml', 'leftlowerarm', 'leftelbow'), ('rightforearm', 'lowerarmr', 'rightlowerarm', 'rightelbow'),
    ('lefthand', 'handl', 'leftwrist'), ('righthand', 'handr', 'rightwrist'),
]


def _name(value):
    value = re.sub(r'^mixamorig\d*[:_]*', '', value, flags=re.IGNORECASE)
    return re.sub(r'[^a-z0-9]', '', value.rsplit(':', 1)[-1].lower())


def _mapping(rig):
    normalized = [_name(name) for name in rig['names']]
    found = []
    for candidates in ALIASES:
        found.append(next((normalized.index(name) for name in candidates if name in normalized), None))
    required = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 18, 19, 20, 21]
    missing = [ALIASES[index][0] for index in required if found[index] is None]
    if missing:
        raise ValueError('The neural model needs a recognizable humanoid body. Missing joint mappings: ' + ', '.join(missing) + '. Use a standard Mixamo or UE humanoid rig.')
    # The built-in mannequin has two spine segments; SMPL has three.
    if found[9] is None:
        found[9] = found[6] if found[6] is not None and found[6] != found[3] else found[3]
        found[6] = None
    if found[6] in [found[3], found[9]]:
        found[6] = None
    return found


def _arrays(frames):
    times = np.asarray([frame['time'] for frame in frames], dtype=np.float64)
    positions = np.asarray([[bone['position'] for bone in frame['pose']] for frame in frames], dtype=np.float64)
    quaternions = np.asarray([[bone['quaternion'] for bone in frame['pose']] for frame in frames], dtype=np.float64)
    scales = np.asarray([[bone['scale'] for bone in frame['pose']] for frame in frames], dtype=np.float64)
    if np.max(np.abs(scales - 1)) > 1e-4:
        raise ValueError('The neural motion bridge requires normalized joint transforms with unit scale.')
    quaternions /= np.linalg.norm(quaternions, axis=-1, keepdims=True)
    return times, positions, quaternions


def _sample(frames, times):
    source_times, positions, quaternions = _arrays(frames)
    if len(source_times) == 1:
        return np.repeat(positions, len(times), axis=0), np.repeat(quaternions, len(times), axis=0)
    right = np.searchsorted(source_times, times, side='right').clip(1, len(source_times) - 1)
    left = right - 1
    amount = ((times - source_times[left]) / (source_times[right] - source_times[left])).clip(0, 1)[:, None, None]
    output_pos = positions[left] * (1 - amount) + positions[right] * amount
    first, last = quaternions[left].copy(), quaternions[right].copy()
    dot = np.sum(first * last, axis=-1, keepdims=True)
    last = np.where(dot < 0, -last, last)
    dot = np.abs(dot).clip(0, 1)
    angle = np.arccos(dot)
    sine = np.sin(angle)
    denominator = np.maximum(sine, 1e-8)
    output_rot = (np.sin((1 - amount) * angle) * first + np.sin(amount * angle) * last) / denominator
    output_rot = np.where(sine < 1e-6, first * (1 - amount) + last * amount, output_rot)
    output_rot /= np.linalg.norm(output_rot, axis=-1, keepdims=True)
    return output_pos, output_rot


def _fk(positions, quaternions, parents):
    world_pos = np.empty_like(positions)
    world_rot = np.empty_like(quaternions)
    for joint, parent in enumerate(parents):
        if parent < 0:
            world_pos[:, joint] = positions[:, joint]
            world_rot[:, joint] = quaternions[:, joint]
        else:
            parent_rotation = Rotation.from_quat(world_rot[:, parent])
            world_pos[:, joint] = world_pos[:, parent] + parent_rotation.apply(positions[:, joint])
            world_rot[:, joint] = (parent_rotation * Rotation.from_quat(quaternions[:, joint])).as_quat()
    return world_pos, world_rot


def _canonical(world, mapping):
    canonical = np.zeros((len(world), 22, 3), dtype=np.float64)
    for index, source in enumerate(mapping):
        if source is not None:
            canonical[:, index] = world[:, source]
    if mapping[6] is None:
        canonical[:, 6] = (canonical[:, 3] + canonical[:, 9]) * .5
    if mapping[12] is None:
        canonical[:, 12] = canonical[:, 9] * .35 + canonical[:, 15] * .65
    for clavicle, arm in [(13, 16), (14, 17)]:
        if mapping[clavicle] is None:
            canonical[:, clavicle] = canonical[:, 9] * .6 + canonical[:, arm] * .4
    for toe, ankle, hip in [(10, 7, 1), (11, 8, 2)]:
        if mapping[toe] is None:
            forward = np.cross(np.array([0., 1., 0.]), canonical[:, 2] - canonical[:, 1])
            forward /= np.maximum(np.linalg.norm(forward, axis=-1, keepdims=True), 1e-8)
            leg = np.linalg.norm(canonical[:, hip] - canonical[:, ankle], axis=-1, keepdims=True)
            canonical[:, toe] = canonical[:, ankle] + forward * leg * .17
    if not np.isfinite(canonical).all():
        raise ValueError('The mapped character has invalid joint positions.')
    return canonical


def _rotation_between(source, destination):
    source = source / max(np.linalg.norm(source), 1e-10)
    destination = destination / max(np.linalg.norm(destination), 1e-10)
    dot = float(np.dot(source, destination))
    if dot < -.999999:
        axis = np.cross(source, [1., 0., 0.])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(source, [0., 1., 0.])
        return Rotation.from_rotvec(axis / np.linalg.norm(axis) * math.pi)
    quaternion = np.r_[np.cross(source, destination), 1 + dot]
    if np.linalg.norm(quaternion) < 1e-9:
        return Rotation.identity()
    return Rotation.from_quat(quaternion)


def _align(source, destination):
    valid = (np.linalg.norm(source, axis=-1) > 1e-7) & (np.linalg.norm(destination, axis=-1) > 1e-7)
    source, destination = source[valid], destination[valid]
    if not len(source):
        return Rotation.identity()
    if len(source) == 1 or np.linalg.norm(np.cross(source[0], source[1])) < 1e-7:
        return _rotation_between(source[0], destination[0])
    source /= np.linalg.norm(source, axis=-1, keepdims=True)
    destination /= np.linalg.norm(destination, axis=-1, keepdims=True)
    u, _, vh = np.linalg.svd(destination.T @ source)
    correction = np.diag([1., 1., np.linalg.det(u @ vh)])
    return Rotation.from_matrix(u @ correction @ vh)


def _retarget(positions, quaternions, parents, mapping, learned):
    original_world, original_rot = _fk(positions, quaternions, parents)
    driven = {source: canonical for canonical, source in enumerate(mapping) if source is not None}
    children = {source: [] for source in driven}
    for child in driven:
        parent = parents[child]
        while parent >= 0 and parent not in driven:
            parent = parents[parent]
        if parent >= 0:
            children[parent].append(child)
    output_positions, output_quaternions = positions.copy(), quaternions.copy()
    for frame in range(len(positions)):
        world_positions = np.empty_like(positions[frame])
        world_rotations = []
        for joint, parent in enumerate(parents):
            parent_rotation = Rotation.identity() if parent < 0 else world_rotations[parent]
            if joint == mapping[0]:
                wanted = learned[frame, 0]
                output_positions[frame, joint] = wanted if parent < 0 else parent_rotation.inv().apply(wanted - world_positions[parent])
            local_rotation = Rotation.from_quat(quaternions[frame, joint])
            if joint in driven and children[joint]:
                targets = children[joint]
                source_vectors = original_world[frame, targets] - original_world[frame, joint]
                target_vectors = learned[frame, [driven[index] for index in targets]] - learned[frame, driven[joint]]
                delta = _align(source_vectors.copy(), target_vectors.copy())
                desired_world = delta * Rotation.from_quat(original_rot[frame, joint])
                local_rotation = parent_rotation.inv() * desired_world
            output_quaternions[frame, joint] = local_rotation.as_quat()
            world_rotations.append(parent_rotation * local_rotation)
            world_positions[joint] = output_positions[frame, joint] if parent < 0 else world_positions[parent] + parent_rotation.apply(output_positions[frame, joint])
    return output_positions, output_quaternions


def _load_engine(runtime, progress):
    import torch
    from safetensors.torch import load_file

    config = runtime.get('config', runtime)
    source = Path(config['sourcePath'])
    checkpoint = Path(config['checkpointPath'])
    sys.path.insert(0, str(source))
    from molab_condmdi.model.mdm_unet import MDM_UNET
    from molab_condmdi.diffusion import gaussian_diffusion as gd
    from molab_condmdi.diffusion.respace import SpacedDiffusion, space_timesteps

    if not torch.cuda.is_available():
        raise RuntimeError('The pretrained motion engine requires an available NVIDIA CUDA GPU.')
    free, _ = torch.cuda.mem_get_info()
    if free < 2 * 1024 ** 3:
        raise RuntimeError('The neural engine needs about 2 GB of free GPU memory. Close another GPU workload and try again.')
    torch.set_num_threads(4)
    torch.cuda.reset_peak_memory_stats()
    progress('Loading the pretrained motion network…', .10)
    digest = hashlib.sha256()
    with (checkpoint / 'model.safetensors').open('rb') as file:
        for block in iter(lambda: file.read(8 * 1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != MODEL_HASH:
        raise RuntimeError('The installed motion checkpoint does not match the verified model. Run setup-ai-motion.ps1 again.')

    class PoseOnlyModel(MDM_UNET):
        # Text dropout is part of CondMDI training. Supplying the null embedding
        # uses that learned condition; no language model or network request is needed.
        def load_and_freeze_clip(self, clip_version):
            return torch.nn.Identity()

        def encode_text(self, raw_text):
            return torch.zeros(len(raw_text), 512, device=next(self.parameters()).device)

    model = PoseOnlyModel(
        modeltype='', njoints=263, nfeats=1, num_actions=1, translation=True,
        pose_rep='rot6d', glob=True, glob_rot=True, latent_dim=512, dim_mults=(2, 2, 2, 2),
        data_rep='hml_vec', dataset='humanml', cond_mode='text', cond_mask_prob=.1,
        adagn=True, zero=True, keyframe_conditioned=True, keyframe_selection_scheme='random_frames', arch='unet',
    )
    state = load_file(str(checkpoint / 'model.safetensors'))
    missing, unexpected = model.load_state_dict(state, strict=False)
    if unexpected or any('sequence_pos_encoder.pe' not in key for key in missing):
        raise RuntimeError('The motion checkpoint and network architecture do not match.')
    del state
    # Upstream overrides _apply/train without returning self. Do not chain these calls.
    model.cuda()
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    diffusion = SpacedDiffusion(
        space_timesteps(1000, 'ddim100'),
        gd.DiffusionConfig(
            betas=gd.get_named_beta_schedule('cosine', 1000),
            model_mean_type=gd.ModelMeanType.START_X, model_var_type=gd.ModelVarType.FIXED_SMALL,
            loss_type=gd.LossType.MSE, clip_range=6., fp16=True, abs_3d=True,
        ),
    )
    mean = torch.from_numpy(np.load(checkpoint / 'Mean_abs_3d.npy'))
    std = torch.from_numpy(np.load(checkpoint / 'Std_abs_3d.npy'))
    return model, diffusion, mean, std


def _generate_window(engine, joints, observed, seed, progress):
    import torch
    from molab_condmdi.data_loaders.humanml.scripts.motion_process import (
        preprocess_motion, postprocess_motion, extract_features, recover_root_rot_pos, recover_from_ric,
    )
    from molab_condmdi.data_loaders.humanml.utils import paramUtil

    model, diffusion, mean, std = engine
    # Feature velocities need one look-ahead frame. Duplicate the last pose so
    # its real position/rotation survives conversion instead of losing a frame.
    padded = np.concatenate([joints, joints[-1:]], axis=0).copy()
    aligned, floor, origin, rotation = preprocess_motion(padded)
    with python_warnings.catch_warnings():
        python_warnings.simplefilter('ignore', RuntimeWarning)
        relative = extract_features(
            aligned.copy(), .002, torch.from_numpy(paramUtil.t2m_raw_offsets),
            paramUtil.t2m_kinematic_chain, [2, 1, 17, 16], [8, 11], [7, 10],
        )
    _, _, angle = recover_root_rot_pos(torch.from_numpy(relative), return_rot_ang=True)
    absolute = relative.copy()
    absolute[:, [1, 2]] = aligned[:-1, 0, [0, 2]]
    absolute[:, 0] = angle.numpy()
    if not np.isfinite(absolute).all():
        raise ValueError('The supplied poses contain collapsed limbs that cannot be encoded by the motion model.')
    features = torch.from_numpy(absolute).float()
    observation = ((features - mean) / std).T[None, :, None, :].cuda()
    mask = torch.zeros_like(observation, dtype=torch.bool)
    mask[..., observed] = True
    condition = {
        'obs_x0': observation, 'obs_mask': mask,
        'y': {
            'text': [''], 'uncond': True,
            'lengths': torch.tensor([len(joints)], device='cuda'),
            'mask': torch.ones(1, 1, 1, len(joints), device='cuda'),
            'imputate': True, 'stop_imputation_at': 0, 'replacement_distribution': 'conditional',
            'inpainted_motion': observation, 'inpainting_mask': mask, 'reconstruction_guidance': False,
        },
    }
    torch.manual_seed(seed)
    with torch.no_grad():
        result = None
        for index, result in enumerate(diffusion.ddim_sample_loop_progressive(
            model, observation.shape, clip_denoised=False, model_kwargs=condition, progress=False,
        )):
            if index % 10 == 0:
                progress(index / diffusion.num_timesteps)
    generated = result['sample'].cpu().permute(0, 2, 3, 1) * std + mean
    points = recover_from_ric(generated.float(), 22, abs_3d=True).reshape(len(joints), 22, 3).numpy()
    points = postprocess_motion(points, floor, origin, rotation)
    if not np.isfinite(points).all():
        raise RuntimeError('The neural sampler produced invalid motion; your existing animation has not been changed.')
    return points


def generate_motion(request, progress):
    """Return model-generated local bone animation using the local job protocol."""
    started = time.perf_counter()
    if request['rig']['kind'] != 'humanoid':
        raise ValueError('CondMDI was trained on human motion. Neural quadruped inbetweening is not available in this engine.')
    if len(request['anchors']) < 2:
        raise ValueError('Add at least two authored poses before generating inbetweens.')
    duration = float(request['duration'])
    if duration > 60:
        raise ValueError('The local neural engine currently supports clips up to 60 seconds.')
    rig, anchors = request['rig'], request['anchors']
    mapping = _mapping(rig)
    parents = rig['parents']
    model_count = int(round(duration * MODEL_FPS)) + 1
    model_times = np.arange(model_count, dtype=np.float64) / MODEL_FPS
    model_times[-1] = duration
    anchor_indices = np.asarray([int(round(frame['time'] * MODEL_FPS)) for frame in anchors], dtype=int).clip(0, model_count - 1)
    if len(set(anchor_indices.tolist())) != len(anchor_indices):
        raise ValueError('Two authored poses are closer than the model’s 1/20-second resolution. Space them at least 0.05 seconds apart.')
    progress('Mapping the original humanoid rig…', .05)
    reference_pos, reference_rot = _sample(anchors, model_times)
    # Key poses are observed at the closest native model frame; output restores
    # the original sub-frame timestamps exactly after resampling.
    for index, anchor in zip(anchor_indices, anchors):
        reference_pos[index] = [bone['position'] for bone in anchor['pose']]
        reference_rot[index] = [bone['quaternion'] for bone in anchor['pose']]
    reference_world, _ = _fk(reference_pos, reference_rot, parents)
    canonical = _canonical(reference_world, mapping)
    rest_pos = np.asarray([[bone['position'] for bone in rig['restPose']]])
    rest_rot = np.asarray([[bone['quaternion'] for bone in rig['restPose']]])
    rest_world, _ = _fk(rest_pos, rest_rot, parents)
    rest = _canonical(rest_world, mapping)[0]
    leg = np.linalg.norm(rest[1] - rest[4]) + np.linalg.norm(rest[4] - rest[7])
    if leg < 1e-4:
        raise ValueError('The rig’s leg has zero length. Check the character’s rest pose.')
    normalization = .8258041694 / leg
    normalized = canonical * normalization
    runtime = request.get('runtime')
    if not runtime:
        raise RuntimeError('No local model runtime is configured. Run scripts/setup-ai-motion.ps1 first.')
    engine = _load_engine(runtime, progress)
    import torch
    generated = normalized.copy()
    # Autoregressive overlapping windows keep clips such as an 18-second Mixamo
    # import usable without exceeding the model's trained temporal context.
    overlap = 40
    stride = MODEL_FRAMES - overlap
    starts = [0]
    while starts[-1] + MODEL_FRAMES < model_count:
        starts.append(starts[-1] + stride)
    sampling_start = time.perf_counter()
    for window, start in enumerate(starts):
        end = min(start + MODEL_FRAMES, model_count)
        incoming = normalized[start:end].copy()
        observed = [int(index - start) for index in anchor_indices if start <= index < end]
        if start:
            context = min(overlap, end - start)
            incoming[:context] = generated[start:start + context]
            observed += list(range(context))
        if not observed:
            observed = [0]
        observed = np.asarray(sorted(set(observed)), dtype=int)
        def step(fraction):
            progress(f'Neural inbetweening · section {window + 1} of {len(starts)}…', .22 + .64 * (window + fraction) / len(starts))
        generated[start:end] = _generate_window(engine, incoming, observed, int(request.get('seed', 42)) + window, step)
        # Pinning is explicit; it is separate from learned unobserved motion.
        for index in anchor_indices:
            if start <= index < end:
                generated[index] = normalized[index]
    sample_seconds = time.perf_counter() - sampling_start
    generated /= normalization
    unknown = np.ones(model_count, dtype=bool)
    unknown[anchor_indices] = False
    learned_rms = float(np.sqrt(np.mean((generated[unknown] - canonical[unknown]) ** 2))) if unknown.any() else 0.
    progress('Returning learned motion to your original skeleton…', .9)
    regular_times = [index / request['fps'] for index in range(int(math.floor(duration * request['fps'])) + 1)]
    authored_times = {float(anchor['time']) for anchor in anchors}
    candidates = sorted(regular_times + [duration] + list(authored_times))
    output_times = []
    for candidate in candidates:
        if output_times and abs(candidate - output_times[-1]) < 1e-6:
            # Imported float32 clip durations can differ from an exact frame
            # boundary by sub-microseconds. Prefer the exact authored time.
            if candidate in authored_times or output_times[-1] not in authored_times:
                output_times[-1] = candidate
        else:
            output_times.append(candidate)
    output_times = np.asarray(output_times)
    model_out = np.empty((len(output_times), 22, 3))
    for joint in range(22):
        for axis in range(3):
            model_out[:, joint, axis] = np.interp(output_times, model_times, generated[:, joint, axis])
    base_positions, base_rotations = _sample(request['frames'], output_times)
    positions, rotations = _retarget(base_positions, base_rotations, parents, mapping, model_out)
    frames = []
    for index, timestamp in enumerate(output_times):
        pinned = next((anchor for anchor in anchors if abs(anchor['time'] - timestamp) < 1e-8), None)
        pose = pinned['pose'] if pinned else [
            {'position': positions[index, joint].tolist(), 'quaternion': rotations[index, joint].tolist(), 'scale': [1., 1., 1.]}
            for joint in range(len(parents))
        ]
        frames.append({'time': float(timestamp), 'pose': pose})
    notes = ['Learned human motion prior; this pass does not run a rigid-body physics simulation. Original skin weights and authored poses are preserved.']
    if len(starts) > 1:
        notes.append(f'This clip uses {len(starts)} overlapping neural windows. Long transitions can drift; review the generated motion before exporting.')
    if any(abs(index / MODEL_FPS - anchor['time']) > 1e-6 for index, anchor in zip(anchor_indices, anchors)):
        notes.append('The model observes poses at 20 fps; exact authored timestamps are restored in the returned animation.')
    return {
        'frames': frames, 'provider': PROVIDER, 'warnings': notes,
        'metrics': {
            'model': 'CondMDI', 'modelSha256': MODEL_HASH, 'learnedParameters': 235122951,
            'nativeFps': MODEL_FPS, 'diffusionSteps': 100, 'seed': int(request.get('seed', 42)),
            'windows': len(starts), 'conditionedFrames': len(anchors), 'generatedFrames': len(frames),
            'learnedVsInterpolationRmsMeters': learned_rms, 'inferenceSeconds': sample_seconds,
            'totalSeconds': time.perf_counter() - started, 'peakGpuMemoryMiB': torch.cuda.max_memory_allocated() / 1024 ** 2,
        },
    }
