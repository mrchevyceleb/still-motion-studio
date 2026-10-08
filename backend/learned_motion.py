"""Fresh conditional motion model; no third-party pretrained parameters.

The generic network learns residual transitions around a sparse-pose baseline.
The baseline alone is ordinary interpolation; only the trained denoiser's
missing-frame predictions are described as learned motion.
"""
from __future__ import annotations

import math
import torch
from torch import nn


class TemporalBlock(nn.Module):
    def __init__(self, width, dilation):
        super().__init__()
        self.norm = nn.GroupNorm(8, width)
        self.time = nn.Linear(width, width * 2)
        self.conv = nn.Conv1d(width, width, 3, padding=dilation, dilation=dilation)
        self.finish = nn.Sequential(nn.GroupNorm(8, width), nn.SiLU(), nn.Conv1d(width, width, 1))

    def forward(self, value, time):
        scale, shift = self.time(time).chunk(2, dim=-1)
        hidden = self.norm(value) * (1 + scale[..., None]) + shift[..., None]
        hidden = self.conv(torch.nn.functional.silu(hidden))
        return (value + self.finish(hidden)) / math.sqrt(2)


class PoseDenoiser(nn.Module):
    def __init__(self, features, width=128, depth=8):
        super().__init__()
        self.features, self.width, self.depth = features, width, depth
        self.input = nn.Conv1d(features * 3 + 1, width, 1)
        self.time = nn.Sequential(nn.Linear(width, width), nn.SiLU(), nn.Linear(width, width))
        self.blocks = nn.ModuleList([TemporalBlock(width, 2 ** (index % 6)) for index in range(depth)])
        self.output = nn.Sequential(nn.GroupNorm(8, width), nn.SiLU(), nn.Conv1d(width, features, 1))
        nn.init.zeros_(self.output[-1].weight)
        nn.init.zeros_(self.output[-1].bias)

    def forward(self, noisy, step, baseline, mask, rest):
        half = self.width // 2
        frequencies = torch.exp(-math.log(10000) * torch.arange(half, device=noisy.device) / (half - 1))
        angles = step[:, None] * frequencies[None] * 1000
        time = self.time(torch.cat([angles.sin(), angles.cos()], dim=-1))
        context = rest[:, None].expand(-1, noisy.shape[1], -1)
        value = self.input(torch.cat([noisy, baseline, mask, context], dim=-1).transpose(1, 2))
        for block in self.blocks:
            value = block(value, time)
        return self.output(value).transpose(1, 2) * (1 - mask)


class CurvaturePrior(nn.Module):
    """A small learned conditional curvature model for a limited motion corpus.

    Sparse neighboring observations supply two candidate residual directions;
    their per-feature strengths are trained from motion, never hand-labelled as
    a deep generative model. Zero weights reproduce interpolation exactly.
    """
    def __init__(self, features):
        super().__init__()
        self.features = features
        self.curvature = nn.Parameter(torch.empty(2, features).normal_(0, .01))

    def forward(self, noisy, step, baseline, mask, rest):
        batch, frames, width = baseline.shape
        grid = torch.arange(frames, device=baseline.device)[None].expand(batch, -1)
        known = mask[..., 0] > .5
        left = torch.where(known, grid, 0).cummax(dim=1).values
        right = torch.where(known, grid, frames - 1).flip(1).cummin(dim=1).values.flip(1)
        previous = left.gather(1, (left - 1).clamp(min=0))
        following = right.gather(1, (right + 1).clamp(max=frames - 1))
        gather = lambda indices: baseline.gather(1, indices[..., None].expand(-1, -1, width))
        first, last = gather(left), gather(right)
        span = (right - left).clamp(min=1)[..., None]
        phase = (grid - left)[..., None] / span
        before, after = gather(previous), gather(following)
        tangent_first = (last - before) / (right - previous).clamp(min=1)[..., None]
        tangent_last = (after - first) / (following - left).clamp(min=1)[..., None]
        t2, t3 = phase.square(), phase.pow(3)
        spline = (2*t3 - 3*t2 + 1)*first + (t3 - 2*t2 + phase)*span*tangent_first + (-2*t3 + 3*t2)*last + (t3 - t2)*span*tangent_last
        ease = ((3*t2 - 2*t3) - phase) * (last - first)
        weights = self.curvature.clamp(-1, 1.5)
        return ((spline - baseline) * weights[0] + ease * weights[1]) * (1 - mask)


def alpha_bar(time):
    return torch.cos((time + .008) / 1.008 * math.pi / 2).square().clamp(1e-5, .9999)


@torch.no_grad()
def sample_motion(model, baseline, mask, rest, seed=42, steps=40, progress=None):
    """Denoise residual motion from a seeded Gaussian latent, preserving keys."""
    if getattr(model, 'objective', 'diffusion') == 'regression':
        clean = model(torch.zeros_like(baseline), torch.zeros(len(baseline), device=baseline.device), baseline, mask, rest)
        if progress:
            progress(1.)
        return baseline + clean * float(getattr(model, 'residual_scale', 1.))
    generator = torch.Generator(device=baseline.device).manual_seed(int(seed))
    residual = torch.randn(baseline.shape, device=baseline.device, generator=generator) * (1 - mask)
    times = torch.linspace(.995, 0, steps + 1, device=baseline.device)
    for index in range(steps):
        time = times[index].expand(len(baseline))
        a, following = alpha_bar(time)[:, None, None], alpha_bar(times[index + 1])
        clean = model(residual, time, baseline, mask, rest)
        clean = clean.clamp(-8, 8)
        epsilon = (residual - a.sqrt() * clean) / (1 - a).sqrt()
        residual = following.sqrt() * clean + (1 - following).sqrt() * epsilon
        residual *= 1 - mask
        if progress:
            progress((index + 1) / steps)
    return baseline + clean


def create_model(metadata):
    """Keep architecture and inference objective bound to the saved checkpoint."""
    architecture = dict(metadata['architecture'])
    family = architecture.pop('family', 'denoiser')
    if family not in ('curvature', 'denoiser'):
        raise ValueError('Unsupported motion model family.')
    model = CurvaturePrior(**architecture) if family == 'curvature' else PoseDenoiser(**architecture)
    model.objective = metadata.get('objective', 'diffusion')
    model.residual_scale = float(metadata.get('residualScale', 1.))
    if model.objective not in ('diffusion', 'regression') or not 0 <= model.residual_scale <= 1:
        raise ValueError('Unsupported motion objective or residual calibration.')
    return model
