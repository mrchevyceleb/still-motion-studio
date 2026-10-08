"""Download and verify the local inference bundle; run only during setup."""
import hashlib
import json
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / '.local' / 'ai-motion'
MODEL_HASH = 'ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361'
AUTHOR_REVISION = '0c58473066ef582b9464a66d5542e0d1b6ae66c8'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    checkpoint = BASE / 'checkpoint'
    checkpoint.mkdir(parents=True, exist_ok=True)
    import torch
    model_path = checkpoint / 'model.safetensors'
    if not model_path.is_file() or sha256(model_path) != MODEL_HASH:
        import gdown
        from safetensors.torch import save_file
        archive = BASE / 'condmdi_random_frames.zip'
        if not archive.is_file() or not zipfile.is_zipfile(archive):
            print('Downloading the author’s 3.49 GB checkpoint archive; optimizer data will not be extracted.')
            pending_archive = BASE / 'condmdi_random_frames.pending.zip'
            gdown.download(id='15mYPp2U0VamWfu1SnwCukUUHczY9RPIP', output=str(pending_archive), resume=True)
            if not zipfile.is_zipfile(pending_archive):
                raise RuntimeError('The checkpoint download is incomplete. Rerun setup to resume it.')
            pending_archive.replace(archive)
        primary = BASE / 'primary'
        primary.mkdir(exist_ok=True)
        trained = primary / 'model000750000.pt'
        with zipfile.ZipFile(archive) as bundle:
            if not trained.is_file() or trained.stat().st_size != bundle.getinfo('model000750000.pt').file_size:
                pending_trained = primary / 'model000750000.pending.pt'
                with bundle.open('model000750000.pt') as source, pending_trained.open('wb') as target:
                    shutil.copyfileobj(source, target, 8 * 1024 * 1024)
                pending_trained.replace(trained)
            (primary / 'args.json').write_bytes(bundle.read('args.json'))
        state = torch.load(trained, map_location='cpu', weights_only=True)['model_avg']
        weights = {name: value.contiguous() for name, value in state.items() if not name.startswith('clip_model.') and 'sequence_pos_encoder.pe' not in name}
        pending_model = checkpoint / 'model.pending.safetensors'
        save_file(weights, str(pending_model))
        del state, weights
        if sha256(pending_model) != MODEL_HASH:
            raise RuntimeError('The author checkpoint failed SHA-256 verification after conversion.')
        pending_model.replace(model_path)
    for name in ['Mean_abs_3d.npy', 'Std_abs_3d.npy']:
        url = f'https://raw.githubusercontent.com/setarehc/diffusion-motion-inbetweening/{AUTHOR_REVISION}/dataset/HumanML3D_abs/{name}'
        pending_stats = checkpoint / (name + '.pending')
        urllib.request.urlretrieve(url, pending_stats)
        pending_stats.replace(checkpoint / name)
    if sha256(model_path) != MODEL_HASH:
        raise RuntimeError('Downloaded model failed SHA-256 verification.')
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable. Install a compatible NVIDIA driver before using this engine.')
    source = BASE / 'molab' / 'models' / 'condmdi'
    manifest = {
        'python': sys.executable,
        'requiredFiles': [str(checkpoint / name) for name in ['model.safetensors', 'Mean_abs_3d.npy', 'Std_abs_3d.npy']] + [str(source / 'molab_condmdi/model/mdm_unet.py')],
        'config': {'sourcePath': str(source), 'checkpointPath': str(checkpoint), 'modelSha256': MODEL_HASH, 'nativeFps': 20, 'maxDuration': 60, 'maxWindowFrames': 196},
        'limits': {'maxDuration': 60, 'humanoidOnly': True},
        'provider': {'id': 'condmdi', 'name': 'CondMDI', 'learned': True, 'description': '235M-parameter pretrained motion diffusion model running locally on your NVIDIA GPU.'},
    }
    pending_manifest = BASE / 'runtime.pending.json'
    pending_manifest.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    pending_manifest.replace(BASE / 'runtime.json')
    print(f'CondMDI ready on {torch.cuda.get_device_name(0)}. Runtime: {BASE / "runtime.json"}')


if __name__ == '__main__':
    main()
