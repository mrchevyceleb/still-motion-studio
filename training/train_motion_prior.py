"""Train a fresh motion prior into a complete immutable candidate directory.

No installed checkpoint is overwritten. Registration is a separate atomic step;
failed, interrupted, or below-baseline runs never change the active runtime.
"""
import argparse
import copy
import hashlib
import io
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import save_file

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.learned_motion import PoseDenoiser, CurvaturePrior, alpha_bar, sample_motion


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_corpus(directory):
    index_bytes = (directory / 'index.json').read_bytes()
    index = json.loads(index_bytes)
    index['_loadedIndexBytes'] = index_bytes
    clips = []
    for entry in index['clips']:
        if entry.get('license') != 'CC0-1.0':
            raise ValueError('Only explicitly documented CC0 motion may enter this trainer.')
        path = (directory / entry['file']).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError('Corpus entries must remain inside their dataset directory.')
        source_bytes = path.read_bytes()
        with np.load(io.BytesIO(source_bytes), allow_pickle=False) as file:
            features = np.asarray(file['features'], dtype=np.float32)
            rest = np.asarray(file['rest'], dtype=np.float32)
            fps = float(file['fps'])
        if features.ndim != 2 or len(features) < 3 or rest.shape != features.shape[1:] or not np.isfinite(features).all() or not np.isfinite(rest).all():
            raise ValueError(f'Invalid clip: {entry["file"]}')
        if abs(fps - 20) > 1e-6:
            raise ValueError('Resample the input corpus to 20 fps before training.')
        clips.append((dict(entry, _loadedFileSha256=hashlib.sha256(source_bytes).hexdigest()), features, rest))
    ids = [c[0]['id'] for c in clips]
    if len(ids) != len(set(ids)) or not all(any(c[0]['split'] == split for c in clips) for split in ('train', 'test')):
        raise ValueError('Unique clip identities and disjoint train/test splits are required.')
    return index, clips


def make_windows(clips, split, frames, seed):
    rng = np.random.default_rng(seed)
    windows, rests = [], []
    for entry, clip, rest in clips:
        if entry['split'] != split:
            continue
        for _ in range(24):
            span = min(len(clip) - 1, (frames - 1) * rng.uniform(.65, 1.4))
            start = rng.uniform(0, max(0, len(clip) - 1 - span))
            indices = np.linspace(start, start + span, frames)
            value = np.stack([np.interp(indices, np.arange(len(clip)), clip[:, k]) for k in range(clip.shape[-1])], axis=-1)
            windows.append(value.astype(np.float32))
            rests.append(rest)
    return np.stack(windows), np.stack(rests)


def condition(target, generator, count=None):
    batch, frames, _ = target.shape
    count = min(frames, count or int(torch.randint(2, 9, (), generator=generator, device=target.device)))
    random = torch.rand(batch, frames - 2, device=target.device, generator=generator)
    interior = random.argsort(dim=-1)[:, :count - 2] + 1
    indices = torch.cat([torch.zeros(batch, 1, device=target.device, dtype=torch.long), interior,
                         torch.full((batch, 1), frames - 1, device=target.device)], dim=-1).long().sort(dim=-1).values
    grid = torch.arange(frames, device=target.device)[None].expand(batch, -1).contiguous()
    right = torch.searchsorted(indices.contiguous(), grid, right=True).clamp(1, count - 1)
    left_index, right_index = indices.gather(1, right - 1), indices.gather(1, right)
    amount = ((grid - left_index) / (right_index - left_index)).unsqueeze(-1)
    width = target.shape[-1]
    first = target.gather(1, left_index[..., None].expand(-1, -1, width))
    last = target.gather(1, right_index[..., None].expand(-1, -1, width))
    mask = torch.zeros(batch, frames, 1, device=target.device)
    mask.scatter_(1, indices[..., None], 1)
    return first * (1 - amount) + last * amount, mask


def even_condition(target, count=6, phase=0):
    frames = target.shape[1]
    count = min(count, (frames + 1) // 2)
    indices = np.unique(np.round(np.linspace(0, frames - 1, count)).astype(int))
    if phase and len(indices) > 2:
        indices[1:-1] = 1 + (indices[1:-1] - 1 + phase) % (frames - 2)
        indices.sort()
    anchors = torch.as_tensor(indices, device=target.device)
    grid = torch.arange(frames, device=target.device)
    right = torch.searchsorted(anchors, grid, right=True).clamp(1, len(indices) - 1)
    first, last = anchors[right - 1], anchors[right]
    amount = ((grid - first) / (last - first))[None, :, None]
    baseline = target[:, first] * (1 - amount) + target[:, last] * amount
    mask = torch.zeros((len(target), frames, 1), device=target.device)
    mask[:, indices] = 1
    return baseline, mask


@torch.no_grad()
def evaluate(model, clips, mean, std, device, window_frames, fit_scale=False):
    """Predict every interior test frame using overlapping, shifted-key windows.

    Endpoints are the two required boundary observations. Every other frame
    must be hidden in at least one pass; duplicate predictions are averaged so
    overlap cannot over-weight convenient sections of a clip.
    """
    per_clip, total_base, total_model, total_values = [], 0., 0., 0
    max_observed_error = 0.
    scale_numerator, scale_denominator = 0., 0.
    tensor = lambda x: torch.as_tensor(x, dtype=torch.float32, device=device)
    for entry, clip, rest in clips:
        if entry['split'] != 'test':
            continue
        size = min(len(clip), window_frames)
        starts = list(range(0, len(clip) - size + 1, max(1, size // 2)))
        if starts[-1] != len(clip) - size:
            starts.append(len(clip) - size)
        coverage = np.zeros(len(clip), dtype=np.int64)
        base_errors = np.zeros(len(clip)); model_errors = np.zeros(len(clip))
        cross = np.zeros(len(clip)); energy = np.zeros(len(clip))
        for start in starts:
            piece = clip[start:start + size]
            target = tensor((piece - mean) / std)[None]
            body = tensor((rest - mean) / std)[None]
            for phase in (0, 1):
                baseline, mask = even_condition(target, phase=phase)
                result = sample_motion(model, baseline, mask, body, 42)
                if not torch.isfinite(result).all():
                    raise ValueError('Non-finite predictions in full held-out evaluation.')
                unknown = (1 - mask)[0, :, 0].cpu().numpy().astype(bool)
                base = (((baseline - target) * tensor(std)) ** 2).sum(dim=-1)[0].cpu().numpy()
                learned = (((result - target) * tensor(std)) ** 2).sum(dim=-1)[0].cpu().numpy()
                positions = np.arange(start, start + size)[unknown]
                coverage[positions] += 1
                base_errors[positions] += base[unknown]
                model_errors[positions] += learned[unknown]
                if fit_scale:
                    residual = (result - baseline) * tensor(std)
                    desired = (target - baseline) * tensor(std)
                    cross[positions] += (residual * desired).sum(dim=-1)[0].cpu().numpy()[unknown]
                    energy[positions] += residual.square().sum(dim=-1)[0].cpu().numpy()[unknown]
                max_observed_error = max(max_observed_error, float(((result - baseline) * mask).abs().max()))
        if np.any(coverage[1:-1] < 1):
            raise ValueError('Held-out evaluation left an interior frame without a prediction.')
        predicted = coverage > 0
        base_error = float((base_errors[predicted] / coverage[predicted]).sum())
        model_error = float((model_errors[predicted] / coverage[predicted]).sum())
        values = int(predicted.sum()) * clip.shape[-1]
        total_base += base_error; total_model += model_error; total_values += values
        if fit_scale:
            scale_numerator += float((cross[predicted] / coverage[predicted]).sum())
            scale_denominator += float((energy[predicted] / coverage[predicted]).sum())
        per_clip.append({'id': entry['id'], 'sourceFrames': len(clip), 'windows': len(starts),
                         'predictionEligibleFrames': len(clip) - 2, 'predictedFrames': int(predicted.sum()),
                         'minimumInteriorPredictions': int(coverage[1:-1].min()), 'unknownValues': values,
                         'baselineTargetRms': float(np.sqrt(base_error / values)),
                         'learnedTargetRms': float(np.sqrt(model_error / values))})
    baseline_rms, learned_rms = (float(np.sqrt(v / total_values)) for v in (total_base, total_model))
    report = {'protocol': 'all-interior-frames-overlap-two-key-phases-v3',
            'heldOutClips': len(per_clip), 'heldOutClipWindows': sum(p['windows'] for p in per_clip),
            'heldOutSourceFrames': sum(p['sourceFrames'] for p in per_clip), 'sixPoseConditioning': True,
            'predictedFrames': sum(p['predictedFrames'] for p in per_clip),
            'conditioningPasses': 2, 'baselineTargetRms': baseline_rms, 'learnedTargetRms': learned_rms,
            'improvementPercent': 100 * (1 - learned_rms / max(baseline_rms, 1e-12)),
            'maxObservedFeatureError': max_observed_error, 'finite': True, 'perClip': per_clip,
            'beatsInterpolation': learned_rms < baseline_rms * .99 and max_observed_error < 1e-6}
    if fit_scale:
        report['fittedResidualScale'] = float(np.clip(scale_numerator / max(scale_denominator, 1e-20), 0., 1.))
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Parent of immutable candidate directories; never an installed checkpoint.')
    parser.add_argument('--steps', type=int, default=8000)
    parser.add_argument('--width', type=int, default=128)
    parser.add_argument('--depth', type=int, default=8)
    parser.add_argument('--frames', type=int, default=81)
    parser.add_argument('--seed', type=int, default=20261008)
    parser.add_argument('--objective', choices=['diffusion', 'regression'], default='diffusion')
    parser.add_argument('--family', choices=['denoiser', 'curvature'], default='denoiser')
    args = parser.parse_args()
    if args.steps < 1 or args.frames < 9:
        raise ValueError('Training requires positive steps and at least nine temporal samples.')
    torch.set_num_threads(4)
    torch.manual_seed(args.seed)
    trainer_source = Path(__file__).read_bytes()
    network_source = (Path(__file__).resolve().parent.parent / 'backend/learned_motion.py').read_bytes()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    index, clips = load_corpus(args.data)
    dataset_files = {entry['file']: entry['_loadedFileSha256'] for entry, _, _ in clips}
    dataset_files_bytes = json.dumps(dataset_files, sort_keys=True, separators=(',', ':')).encode('utf-8')
    train_features = np.concatenate([clip for entry, clip, _ in clips if entry['split'] == 'train'])
    mean, std = train_features.mean(axis=0), train_features.std(axis=0).clip(.04, None)
    # Calibration uses a clip-disjoint split taken ONLY from training; external
    # held-out test clips cannot select checkpoints, scales, or hyperparameters.
    training = [c for c in clips if c[0]['split'] == 'train']
    calibration_ids = {c[0]['id'] for i, c in enumerate(sorted(training, key=lambda c: c[0]['id'])) if i % 7 == 0}
    fit_clips = [c for c in training if c[0]['id'] not in calibration_ids]
    calibration = [dict(c[0], split='test') for c in training if c[0]['id'] in calibration_ids]
    calibration_clips = [(entry, c[1], c[2]) for entry, c in zip(calibration, [c for c in training if c[0]['id'] in calibration_ids])]
    windows, rests = make_windows(fit_clips, 'train', args.frames, args.seed)
    inputs = torch.as_tensor((windows - mean) / std, device=device)
    rest = torch.as_tensor((rests - mean) / std, device=device)
    architecture = {'features': inputs.shape[-1], 'family': 'curvature'} if args.family == 'curvature' else {'features': inputs.shape[-1], 'width': args.width, 'depth': args.depth}
    model = (CurvaturePrior(inputs.shape[-1]) if args.family == 'curvature' else PoseDenoiser(inputs.shape[-1], args.width, args.depth)).to(device)
    model.objective = args.objective; model.residual_scale = 1.
    optimizer = torch.optim.AdamW(model.parameters(), lr=.01 if args.family == 'curvature' else 3e-4, weight_decay=1e-4)
    generator = torch.Generator(device=device).manual_seed(args.seed)
    started = time.perf_counter(); losses = []; best_score = float('inf'); best_state = None
    for step in range(args.steps):
        model.train()
        indices = torch.randint(len(inputs), (32,), device=device, generator=generator)
        target, body = inputs[indices], rest[indices]
        # Match the six-pose editing task for the small curvature model. The
        # general denoiser retains arbitrary-key training augmentation.
        baseline, mask = even_condition(target, phase=step % 2) if args.family == 'curvature' else condition(target, generator)
        residual = (target - baseline) * (1 - mask)
        if args.objective == 'diffusion':
            times = torch.rand(32, device=device, generator=generator) * .995
            a = alpha_bar(times)[:, None, None]
            noise = torch.randn(residual.shape, device=device, generator=generator)
            noisy = (a.sqrt() * residual + (1 - a).sqrt() * noise) * (1 - mask)
        else:
            times = torch.zeros(32, device=device); noisy = torch.zeros_like(residual)
        predicted = model(noisy, times, baseline, mask, body)
        denominator = (1 - mask).sum() * inputs.shape[-1]
        feature_weight = torch.as_tensor(std, device=device).square() if args.family == 'curvature' else 1.
        loss = ((predicted - residual).square() * (1 - mask) * feature_weight).sum() / denominator
        velocity = (((predicted[:, 1:] - predicted[:, :-1]) - (residual[:, 1:] - residual[:, :-1])).square() * feature_weight).mean()
        loss = loss + .1 * velocity
        optimizer.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1); optimizer.step()
        losses.append(float(loss.detach()))
        if (step + 1) % 200 == 0 or step + 1 == args.steps:
            model.eval()
            score = evaluate(model, calibration_clips, mean, std, device, args.frames)['learnedTargetRms']
            if score < best_score:
                best_score = score; best_state = copy.deepcopy(model.state_dict())
            print(json.dumps({'step': step + 1, 'loss': float(np.mean(losses[-200:])), 'calibrationRms': score,
                              'seconds': round(time.perf_counter() - started, 1)}), flush=True)
    model.load_state_dict(best_state); model.eval()
    # A simple scale calibration reduces overconfident residuals without looking
    # at test clips. Zero scale is never presented as a promoted learned model.
    if args.objective == 'regression':
        # Fit the single residual strength by least squares on calibration
        # clips only. A coarse grid can under/overshoot a useful small prior.
        model.residual_scale = evaluate(model, calibration_clips, mean, std, device, args.frames, fit_scale=True)['fittedResidualScale']
    proof = evaluate(model, clips, mean, std, device, args.frames)
    token = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
    candidate = args.output / token
    candidate.mkdir(parents=True, exist_ok=False)
    # Only the completion marker distinguishes usable candidates from remnants
    # of an interrupted run. Installed files are never touched by this process.
    save_file({name: value.detach().cpu().contiguous() for name, value in model.state_dict().items()}, str(candidate / 'model.safetensors'))
    config = {'architecture': architecture,
              'objective': args.objective, 'residualScale': model.residual_scale,
              'mean': mean.tolist(), 'std': std.tolist(), 'nativeFps': 20, 'windowFrames': args.frames,
              'trainingSteps': args.steps, 'trainingSeed': args.seed, 'initializedFrom': 'random',
              'pretrainedWeightsUsed': False, 'modelSha256': digest(candidate / 'model.safetensors'),
              'parameters': sum(parameter.numel() for parameter in model.parameters()),
              'trainingSeconds': time.perf_counter() - started, 'finalLoss': float(np.mean(losses[-200:])),
              'trainingClipIds': [c[0]['id'] for c in fit_clips], 'calibrationClipIds': sorted(calibration_ids),
              'heldOutClipIds': [c[0]['id'] for c in clips if c[0]['split'] == 'test'],
              'dataIndexSha256': hashlib.sha256(index['_loadedIndexBytes']).hexdigest(),
              'dataFilesSha256': hashlib.sha256(dataset_files_bytes).hexdigest(),
              'trainerSha256': hashlib.sha256(trainer_source).hexdigest(),
              'networkSha256': hashlib.sha256(network_source).hexdigest()}
    (candidate / 'model.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
    proof['modelSha256'] = config['modelSha256']
    (candidate / 'validation.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
    evidence = candidate / 'provenance'; evidence.mkdir()
    (evidence / 'data-index.json').write_bytes(index['_loadedIndexBytes'])
    (evidence / 'dataset-files.json').write_bytes(dataset_files_bytes)
    (evidence / 'trainer.py').write_bytes(trainer_source)
    (evidence / 'network.py').write_bytes(network_source)
    for filename in ('sources.json',):
        source = args.data.parent / filename
        if source.is_file(): (evidence / filename).write_bytes(source.read_bytes())
    bundle = {'version': 1, 'modelSha256': config['modelSha256'], 'files': {
        p.relative_to(candidate).as_posix(): digest(p) for p in sorted(candidate.rglob('*')) if p.is_file()}}
    pending = candidate / 'complete.pending.json'
    pending.write_text(json.dumps(bundle, indent=2), encoding='utf-8'); os.replace(pending, candidate / 'complete.json')
    print(json.dumps({'complete': True, 'candidate': str(candidate.resolve()), **{k: v for k, v in proof.items() if k != 'perClip'}}), flush=True)


if __name__ == '__main__':
    main()
