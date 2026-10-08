"""Train a fresh small motion prior from an explicitly split local NPZ corpus.

Input index.json: {clips:[{id,file,split:'train'|'test',source,...}]}; each file
stores features[T,D], rest[D], fps=20. No pretrained checkpoint is accepted.
"""
import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from safetensors.torch import save_file

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.learned_motion import PoseDenoiser, alpha_bar, sample_motion


def load_corpus(directory):
    index = json.loads((directory / 'index.json').read_text(encoding='utf-8'))
    clips = []
    for entry in index['clips']:
        with np.load(directory / entry['file'], allow_pickle=False) as file:
            features = np.asarray(file['features'], dtype=np.float32)
            rest = np.asarray(file['rest'], dtype=np.float32)
            fps = float(file['fps'])
        if features.ndim != 2 or rest.shape != features.shape[1:] or not np.isfinite(features).all():
            raise ValueError(f'Invalid clip: {entry["file"]}')
        if abs(fps - 20) > 1e-6:
            raise ValueError('Resample the input corpus to 20 fps before training.')
        clips.append((entry, features, rest))
    if not any(c[0]['split'] == 'test' for c in clips):
        raise ValueError('A held-out test split is required.')
    return index, clips


def make_windows(clips, split, frames, seed):
    rng = np.random.default_rng(seed)
    windows, rests = [], []
    for entry, clip, rest in clips:
        if entry['split'] != split:
            continue
        for _ in range(24 if split == 'train' else 3):
            # Vary window start and playback rate; no cross-clip concatenation.
            span = min(len(clip) - 1, (frames - 1) * rng.uniform(.65, 1.4))
            start = rng.uniform(0, max(0, len(clip) - 1 - span))
            indices = np.linspace(start, start + span, frames)
            value = np.stack([np.interp(indices, np.arange(len(clip)), clip[:, k]) for k in range(clip.shape[-1])], axis=-1)
            windows.append(value.astype(np.float32))
            rests.append(rest)
    return np.stack(windows), np.stack(rests)


def condition(target, generator, count=None):
    batch, frames, _ = target.shape
    count = count or int(torch.randint(2, 9, (), generator=generator, device=target.device))
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--steps', type=int, default=8000)
    parser.add_argument('--width', type=int, default=128)
    parser.add_argument('--depth', type=int, default=8)
    parser.add_argument('--frames', type=int, default=81)
    parser.add_argument('--seed', type=int, default=20261008)
    args = parser.parse_args()
    torch.set_num_threads(4)
    torch.manual_seed(args.seed)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is required for this training job.')
    index, clips = load_corpus(args.data)
    train_features = np.concatenate([clip for entry, clip, _ in clips if entry['split'] == 'train'])
    mean, std = train_features.mean(axis=0), train_features.std(axis=0).clip(.04, None)
    windows, rests = make_windows(clips, 'train', args.frames, args.seed)
    inputs = torch.from_numpy((windows - mean) / std).cuda()
    rest = torch.from_numpy((rests - mean) / std).cuda()
    validation, validation_rest = make_windows(clips, 'test', args.frames, args.seed + 1)
    validation = torch.from_numpy((validation - mean) / std).cuda()
    validation_rest = torch.from_numpy((validation_rest - mean) / std).cuda()
    model = PoseDenoiser(inputs.shape[-1], args.width, args.depth).cuda()
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
    generator = torch.Generator(device='cuda').manual_seed(args.seed)
    started = time.perf_counter()
    losses = []
    for step in range(args.steps):
        indices = torch.randint(len(inputs), (32,), device='cuda', generator=generator)
        target, body = inputs[indices], rest[indices]
        baseline, mask = condition(target, generator)
        residual = (target - baseline) * (1 - mask)
        times = torch.rand(32, device='cuda', generator=generator) * .995
        a = alpha_bar(times)[:, None, None]
        noise = torch.randn(residual.shape, device='cuda', generator=generator)
        noisy = (a.sqrt() * residual + (1 - a).sqrt() * noise) * (1 - mask)
        predicted = model(noisy, times, baseline, mask, body)
        denominator = (1 - mask).sum() * inputs.shape[-1]
        loss = ((predicted - residual).square() * (1 - mask)).sum() / denominator
        velocity = ((predicted[:, 1:] - predicted[:, :-1]) - (residual[:, 1:] - residual[:, :-1])).square().mean()
        loss = loss + .1 * velocity
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1)
        optimizer.step()
        losses.append(float(loss.detach()))
        if (step + 1) % 200 == 0:
            print(json.dumps({'step': step + 1, 'loss': float(np.mean(losses[-200:])), 'seconds': round(time.perf_counter() - started, 1)}), flush=True)
    model.eval()
    args.output.mkdir(parents=True, exist_ok=True)
    pending = args.output / 'model.pending.safetensors'
    save_file({name: value.detach().cpu().contiguous() for name, value in model.state_dict().items()}, str(pending))
    digest = hashlib.sha256(pending.read_bytes()).hexdigest()
    pending.replace(args.output / 'model.safetensors')
    config = {'architecture': {'features': inputs.shape[-1], 'width': args.width, 'depth': args.depth},
              'mean': mean.tolist(), 'std': std.tolist(), 'nativeFps': 20, 'windowFrames': args.frames,
              'trainingSteps': args.steps, 'trainingSeed': args.seed, 'initializedFrom': 'random',
              'pretrainedWeightsUsed': False, 'modelSha256': digest,
              'parameters': sum(parameter.numel() for parameter in model.parameters()),
              'trainingSeconds': time.perf_counter() - started, 'finalLoss': float(np.mean(losses[-200:])),
              'trainingClipIds': [c[0]['id'] for c in clips if c[0]['split'] == 'train'],
              'heldOutClipIds': [c[0]['id'] for c in clips if c[0]['split'] == 'test'],
              'dataIndexSha256': hashlib.sha256((args.data / 'index.json').read_bytes()).hexdigest(),
              'trainerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'networkSha256': hashlib.sha256((Path(__file__).resolve().parent.parent / 'backend/learned_motion.py').read_bytes()).hexdigest()}
    (args.output / 'model.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
    with torch.no_grad():
        batch = min(len(validation), 12)
        target, body = validation[:batch], validation_rest[:batch]
        baseline, mask = condition(target, generator, 6)
        first = sample_motion(model, baseline, mask, body, 42)
        second = sample_motion(model, baseline, mask, body, 43)
        scale = torch.from_numpy(std).cuda()
        unknown = 1 - mask
        def rms(value):
            return float(((value * scale * unknown).square().sum() / (unknown.sum() * inputs.shape[-1])).sqrt())
        proof = {'heldOutClipWindows': batch, 'sixPoseConditioning': True,
                 'baselineTargetRms': rms(baseline - target), 'learnedTargetRms': rms(first - target),
                 'learnedVsBaselineRms': rms(first - baseline), 'seedDifferenceRms': rms(first - second),
                 'maxObservedFeatureError': float(((first - baseline) * mask).abs().max()),
                 'finite': bool(torch.isfinite(first).all()), 'modelSha256': digest}
    (args.output / 'validation.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
    print(json.dumps({'complete': True, **proof}), flush=True)


if __name__ == '__main__':
    main()
