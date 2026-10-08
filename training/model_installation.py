"""Validate and atomically activate immutable, provenance-bound motion bundles."""
from __future__ import annotations
import hashlib
import json
import os
import shutil
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.environ.get('STILL_DATA_ROOT', ROOT)).resolve()
BASES = {'owned_humanoid': 'owned-humanoid', 'quadruped': 'quadruped'}


from backend.model_bundle import sha, verify_bundle


def activate(provider, candidate, python=None):
    base = DATA_ROOT / '.local' / BASES[provider]
    registry = json.loads((ROOT / 'backend/model-rights.json').read_text(encoding='utf-8'))['providers'][provider]
    approved = registry['approvedCorpusSha256']
    approved_files = registry['approvedCorpusFilesSha256']
    metadata, proof, complete = verify_bundle(candidate, approved, approved_files_hash=approved_files)
    candidate = Path(candidate).resolve()
    from safetensors.torch import load_file
    import torch
    from backend.learned_motion import create_model
    network = create_model(metadata)
    weights = load_file(str(candidate / 'model.safetensors'))
    if any(not torch.isfinite(value).all() for value in weights.values()):
        raise ValueError('Candidate contains non-finite learned parameters.')
    network.load_state_dict(weights, strict=True)
    if sum(value.numel() for value in network.parameters()) != metadata.get('parameters'):
        raise ValueError('Candidate parameter count does not match its architecture.')
    # Copy into an immutable directory before switching the one authoritative
    # pointer. A crash during the copy leaves the old runtime fully usable.
    versions = base / 'versions'; versions.mkdir(parents=True, exist_ok=True)
    # Identical weights may be revalidated with a stronger protocol. Preserve
    # that evidence as a distinct immutable bundle instead of reusing old proof.
    version = versions / (metadata['modelSha256'] + '-' + sha(candidate / 'complete.json')[:16])
    if version.exists():
        verify_bundle(version, approved, approved_files_hash=approved_files)
    else:
        pending = versions / ('.pending-' + uuid.uuid4().hex)
        shutil.copytree(candidate, pending)
        verify_bundle(pending, approved, approved_files_hash=approved_files)
        try:
            os.replace(pending, version)
        except OSError:
            if not version.exists(): raise
            verify_bundle(version, approved, approved_files_hash=approved_files)
    from backend.owned_humanoid import PROVIDER as HUMAN
    from backend.quadruped import PROVIDER as QUAD
    runtime = {'python': python or sys.executable,
               'requiredFiles': [str(version / key) for key in ('model.safetensors', 'model.json', 'validation.json', 'complete.json')],
               'config': {'checkpointPath': str(version), 'modelSha256': metadata['modelSha256'], 'nativeFps': 20, 'maxDuration': 12 if provider == 'owned_humanoid' else 60},
               'limits': {'maxDuration': 12 if provider == 'owned_humanoid' else 60, 'humanoidOnly' if provider == 'owned_humanoid' else 'quadrupedOnly': True},
               'provider': HUMAN if provider == 'owned_humanoid' else QUAD,
               'installation': {'version': 1, 'provider': provider, 'bundleManifestSha256': sha(version / 'complete.json'),
                                'modelSha256': metadata['modelSha256'], 'approvedCorpusSha256': approved}}
    base.mkdir(parents=True, exist_ok=True)
    temporary = base / ('runtime.pending-' + uuid.uuid4().hex + '.json')
    with temporary.open('w', encoding='utf-8') as handle:
        json.dump(runtime, handle, indent=2); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, base / 'runtime.json')
    return {'ready': True, 'runtime': str(base / 'runtime.json'), 'checkpointPath': str(version), 'modelSha256': metadata['modelSha256'], 'quality': proof}
