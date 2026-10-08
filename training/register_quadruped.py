"""Register the locally trained quadruped model for the private worker service."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.quadruped import PROVIDER

base = ROOT / '.local/quadruped'
checkpoint = base / 'model'
metadata = json.loads((checkpoint / 'model.json').read_text(encoding='utf-8'))
digest = hashlib.sha256((checkpoint / 'model.safetensors').read_bytes()).hexdigest()
if digest != metadata['modelSha256'] or metadata.get('pretrainedWeightsUsed') is not False:
    raise RuntimeError('Checkpoint provenance validation failed.')
runtime = {'python': sys.executable,
           'requiredFiles': [str(checkpoint / 'model.safetensors'), str(checkpoint / 'model.json'), str(ROOT / 'backend/learned_motion.py')],
           'config': {'checkpointPath': str(checkpoint), 'modelSha256': digest, 'nativeFps': 20, 'maxDuration': 60},
           'limits': {'maxDuration': 60, 'quadrupedOnly': True}, 'provider': PROVIDER}
pending = base / 'runtime.pending.json'
pending.write_text(json.dumps(runtime, indent=2), encoding='utf-8')
pending.replace(base / 'runtime.json')
print(json.dumps({'ready': True, 'runtime': str(base / 'runtime.json'), 'modelSha256': digest}))
