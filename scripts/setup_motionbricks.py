"""Install the pinned model separately from Still; publish only after real inference.

No NVIDIA evaluation sample data is downloaded. The model is covered by the
NVIDIA Open Model Agreement, linked in the accompanying MODEL-LICENSE.md.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time
import urllib.request

REVISION = '54fc563aeaaf819a753d72cc9fdc6713989cdd43'
SHA256 = '856419dc72aeb14e591eebf4dd0ea05734a2506ddb00bcd39dd6dac2ad60f4fb'
LICENSE_SHA256 = '76c05aa5f17327631284b865bf71d4b61d8aadd6737b6cc24c33752641f2ee71'
AGREEMENT_SHA256 = '679cc672f7c10322db9426b1e0f4b1dc48148438e3c9e9133228ab13c00ec13c'
FILENAME = 'mmm_v6_soma_fp32.onnx'


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--model-source', type=Path)
    args = parser.parse_args()
    folder = args.data_root.resolve() / '.local/motionbricks'
    folder.mkdir(parents=True, exist_ok=True)
    model = folder / FILENAME
    if not model.is_file() or digest(model) != SHA256:
        pending = folder / (FILENAME+'.pending')
        if args.model_source:
            print('Copying the human motion model...', flush=True)
            shutil.copyfile(args.model_source, pending)
        else:
            print('Downloading MotionBricks SOMA (723 MiB)...', flush=True)
            url = f'https://media.githubusercontent.com/media/NVlabs/motionbricks/{REVISION}/motionbricks/assets/onnx/soma/{FILENAME}'
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url, timeout=120) as response, pending.open('wb') as output:
                        shutil.copyfileobj(response, output, length=1024*1024)
                    if digest(pending) != SHA256:
                        raise OSError('The downloaded model is truncated or changed.')
                    break
                except (OSError, TimeoutError):
                    pending.unlink(missing_ok=True)
                    if attempt == 3:
                        raise
                    print('The download was interrupted. Trying again...', flush=True)
                    time.sleep(2 ** attempt)
        if digest(pending) != SHA256:
            pending.unlink(missing_ok=True)
            raise RuntimeError('MotionBricks download hash mismatch. Setup did not register the model.')
        pending.replace(model)
    license_path = folder / 'MODEL-LICENSE.md'
    license_source = Path(__file__).resolve().parents[1] / 'backend/assets/motionbricks-MODEL-LICENSE.md'
    license_pending = folder / 'MODEL-LICENSE.pending.md'
    license_text = license_source.read_text(encoding='utf-8').encode('utf-8')
    if hashlib.sha256(license_text).hexdigest() != LICENSE_SHA256:
        raise RuntimeError('The bundled model license notice changed. Restore the pinned notice before setup.')
    license_pending.write_bytes(license_text)
    license_pending.replace(license_path)
    agreement_source = license_source.with_name('NVIDIA-Open-Model-Agreement.pdf')
    if digest(agreement_source) != AGREEMENT_SHA256:
        raise RuntimeError('The bundled NVIDIA Open Model Agreement changed. Restore the pinned agreement before setup.')
    agreement_path = folder / agreement_source.name
    agreement_pending = agreement_path.with_suffix('.pending.pdf')
    shutil.copyfile(agreement_source, agreement_pending)
    agreement_pending.replace(agreement_path)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import numpy as np
    from backend.motionbricks import OFFSETS, PARENTS, NEUTRAL_ROTATIONS, _prediction, load_onnxruntime
    ort = load_onnxruntime()
    # Run the downloaded graph, rather than advertising a merely present file.
    print('Checking real model inference...', flush=True)
    options = ort.SessionOptions(); options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    positions = []
    for i, parent in enumerate(PARENTS):
        positions.append(OFFSETS[i] if parent < 0 else positions[parent]+OFFSETS[i])
    guide = (np.asarray(positions), NEUTRAL_ROTATIONS)
    roots, rotations = _prediction(session, [guide]*8, 1, 1.)
    if not np.isfinite(roots).all() or not np.isfinite(rotations).all():
        raise RuntimeError('The model did not produce usable motion.')
    runtime = {'python': sys.executable, 'requiredFiles': [str(model), str(license_path), str(agreement_path)],
               'config': {'modelPath': str(model), 'modelSha256': SHA256, 'modelSize': model.stat().st_size, 'revision': REVISION},
               'limits': {'maxDuration': 20, 'humanoidOnly': True},
               'provider': {'id': 'motionbricks', 'name': 'MotionBricks', 'learned': True,
                            'description': 'Local NVIDIA humanoid inbetweening with exact authored poses.'}}
    pending_config = folder / 'runtime.pending.json'
    pending_config.write_text(json.dumps(runtime, indent=2)+'\n', encoding='utf-8')
    pending_config.replace(folder / 'runtime.json')
    print('MotionBricks is ready. Open Still > Motion > AI in-betweening.', flush=True)


if __name__ == '__main__':
    main()
