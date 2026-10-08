"""Prepare authored CC0 clips, reserving complete clip identities for evaluation."""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.owned_humanoid import features

base = ROOT / '.local/owned-humanoid'
out = base / 'dataset'; out.mkdir(parents=True, exist_ok=True)
clips = []
source_bytes = (base / 'sources.json').read_bytes()
sources = json.loads(source_bytes)
acquired = {(s['id'], f['file']): f['sha256'] for s in sources['sources'] if s['license'] == 'CC0-1.0' for f in s['files']}
requests = json.loads((base / 'requests/index.json').read_text(encoding='utf-8'))
if requests.get('sourcesSha256') != hashlib.sha256(source_bytes).hexdigest():
    raise ValueError('The CC0 acquisition record changed. Re-extract verified source clips.')
for record in requests['files']:
    path = (base / 'requests' / record['file']).resolve()
    source = (base / record['sourceFile']).resolve()
    expected = acquired.get((record['sourceId'], record['sourceFile']))
    if not path.is_relative_to((base / 'requests').resolve()) or not source.is_relative_to(base.resolve()):
        raise ValueError('A training source is outside its acquired directory.')
    if not expected or expected != record['sourceSha256'] or hashlib.sha256(source.read_bytes()).hexdigest() != expected:
        raise ValueError('Acquired humanoid source hash mismatch.')
    if hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
        raise ValueError('Extracted humanoid clip hash mismatch: ' + record['file'])
    item = json.loads(path.read_text(encoding='utf-8'))
    if item['sourceId'] != record['sourceId']: raise ValueError('Extracted source identity mismatch.')
    identity = item['sourceId'] + '/' + item['clip']
    # All variants of a source animation remain in one split.
    split = 'test' if int(hashlib.sha256(identity.encode()).hexdigest()[:8], 16) % 6 == 0 else 'train'
    motion, rest, _ = features(item['request'])
    if len(motion) < 8: continue
    file = path.stem + '.npz'
    np.savez_compressed(out / file, features=motion, rest=rest, fps=np.float32(20))
    clips.append({'id': identity, 'file': file, 'split': split, 'source': item['sourceId'],
                  'frames': len(motion), 'sourceRequest': str(path.relative_to(ROOT)),
                  'requestSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'license': 'CC0-1.0'})
index = {'representation': '21 named humanoid joint world positions, rest-height normalized, 63 features',
         'fps': 20, 'pretrainedWeightsUsed': False, 'sources': json.loads((base / 'sources.json').read_text()), 'clips': clips}
(out / 'index.json').write_text(json.dumps(index, indent=2), encoding='utf-8')
print('Prepared', len(clips), 'clips:', sum(c['split'] == 'train' for c in clips), 'training;', sum(c['split'] == 'test' for c in clips), 'held out.')
print('Training frames:', sum(c['frames'] for c in clips if c['split'] == 'train'))
