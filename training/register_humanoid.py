"""Verify fresh training provenance, then register the experimental local model."""
import hashlib
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.owned_humanoid import PROVIDER
base = ROOT / '.local/owned-humanoid'
model = base / 'model'
metadata = json.loads((model / 'model.json').read_text(encoding='utf-8'))
digest = hashlib.sha256((model / 'model.safetensors').read_bytes()).hexdigest()
if metadata.get('modelSha256') != digest or metadata.get('initializedFrom') != 'random' or metadata.get('pretrainedWeightsUsed') is not False:
    raise ValueError('The checkpoint does not match the recorded fresh-training provenance.')
if set(metadata['trainingClipIds']) & set(metadata['heldOutClipIds']):
    raise ValueError('Training and held-out clips overlap.')
runtime = {'python': sys.executable, 'requiredFiles': [str(model / 'model.safetensors'), str(model / 'model.json'), str(ROOT / 'backend/learned_motion.py')],
           'config': {'checkpointPath': str(model), 'modelSha256': digest, 'nativeFps': 20, 'maxDuration': 12},
           'limits': {'maxDuration': 12, 'humanoidOnly': True}, 'provider': PROVIDER}
pending = base / 'runtime.pending.json'
pending.write_text(json.dumps(runtime, indent=2), encoding='utf-8'); pending.replace(base / 'runtime.json')
print(json.dumps({'ready': True, 'runtime': str(base / 'runtime.json'), 'modelSha256': digest}))
