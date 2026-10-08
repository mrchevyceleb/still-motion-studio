"""Prepare canonical quadruped joints from Quaternius' CC0 animal animations."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gltf_motion import GltfMotion

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / '.local/quadruped/quaternius'
OUTPUT = ROOT / '.local/quadruped/corpus'
NAMES = ['Hips', 'Spine', 'Neck', 'Head', 'Tail', 'TailTip'] + [f'{pair}{side}{joint}' for side in ['Left', 'Right'] for pair in ['Front', 'Hind'] for joint in ['UpperLeg', 'LowerLeg', 'Foot']]
PARENTS = [-1, 0, 1, 2, 0, 4, 1, 6, 7, 0, 9, 10, 1, 12, 13, 0, 15, 16]


def canonical_indices(names):
    tails = sorted([name for name in names if name.startswith('Tail')], key=lambda name: int(name[4:]))
    selected = ['Back', 'Torso2', 'Neck2', 'Head', tails[min(1, len(tails) - 1)], tails[-1]]
    for side in ['L', 'R']:
        selected += [f'FrontUpperLeg.{side}', f'FrontLowerLeg.{side}', f'FF.{side}',
                     f'BackLeg.{side}', f'BackUpperLeg.{side}', f'FFB.{side}']
    return [names.index(name) for name in selected]


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    clips = []
    provenance = json.loads((SOURCE / 'provenance.json').read_text(encoding='utf-8'))
    if provenance.get('source') != 'https://quaternius.com/packs/ultimateanimatedanimals.html' or provenance.get('license') != 'CC0-1.0':
        raise ValueError('Unrecognized animal acquisition provenance.')
    verified = {}
    for record in provenance['files']:
        if not record.get('sha256'): continue
        path = (SOURCE / record['file']).resolve()
        if not path.is_relative_to(SOURCE.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
            raise ValueError('Acquired animal source hash mismatch: ' + record['file'])
        verified[path] = record['sha256']
    for path in sorted(p for p in verified if p.suffix.lower() == '.gltf'):
        if path.stem == 'Horse_White':
            continue  # Color variant duplicates the held-out horse animation.
        content = json.loads(path.read_text(encoding='utf-8'))
        for buffer in content.get('buffers', []):
            uri = buffer.get('uri', '')
            if not uri.startswith('data:') and (path.parent / uri).resolve() not in verified:
                raise ValueError('Animation buffer is not in verified acquisition manifest: ' + uri)
        asset = GltfMotion(path)
        mapping = canonical_indices(asset.names)
        _, all_rest, _ = asset.world()
        rest = all_rest[0, mapping].copy()
        origin = rest[0] * np.array([1, 0, 1])
        floor = float(rest[[8, 11, 14, 17], 1].min())
        origin[1] = floor
        scale = 1 / max(rest[0, 1] - floor, .1)
        rest = (rest - origin) * scale
        for animation in asset.data['animations']:
            _, world, _ = asset.world(animation)
            positions = (world[:, mapping] - origin) * scale
            label = f'{path.stem}-{animation["name"]}'
            name = label + '.npz'
            np.savez_compressed(OUTPUT / name, features=positions.reshape(len(positions), -1).astype(np.float32),
                                rest=rest.reshape(-1).astype(np.float32), fps=np.float32(20))
            clips.append({'id': label, 'file': name, 'split': 'test' if path.stem == 'Horse' else 'train',
                          'source': str(path.relative_to(ROOT)), 'sourceSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                          'action': animation['name'], 'frames': len(positions), 'license': 'CC0-1.0'})
        print(path.stem, len(asset.data['animations']), 'animations', flush=True)
    manifest = {'author': 'Quaternius', 'license': 'CC0-1.0',
                'source': 'https://quaternius.com/packs/ultimateanimatedanimals.html',
                'names': NAMES, 'parents': PARENTS,
                'featureRepresentation': '18 canonical world joint XYZ values; rest hip height=1, rest foot floor=0',
                'heldOutPolicy': 'All Horse animations held out; Horse_White duplicate excluded entirely.', 'clips': clips}
    (OUTPUT / 'index.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'clips': len(clips), 'training': sum(c['split'] == 'train' for c in clips), 'heldOut': sum(c['split'] == 'test' for c in clips)}))


if __name__ == '__main__':
    main()
