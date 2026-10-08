"""Fetch only CC0 animation source files linked by Quaternius' author page."""
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gdown

BASE = Path(__file__).resolve().parent.parent / '.local' / 'quadruped' / 'quaternius'
SOURCE = 'https://quaternius.com/packs/ultimateanimatedanimals.html'
FOLDER = 'https://drive.google.com/drive/folders/1uJ3N5HfB7jKTseJUNQr3N4YaN0UuEtHk'


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    listing = gdown.download_folder(FOLDER, output=str(BASE), skip_download=True, quiet=True)
    files = [item for item in listing if item.path.startswith('glTF') or item.path == 'License.txt']
    manifest_path = BASE / 'provenance.json'
    previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.is_file() else {}
    known = {item['driveId']: item.get('sha256') for item in previous.get('files', [])}

    def download(item):
        path = Path(item.local_path).resolve()
        if not path.is_relative_to(BASE.resolve()): raise ValueError('Unsafe acquisition path.')
        path.parent.mkdir(parents=True, exist_ok=True)
        # Never bless an arbitrary pre-existing cache as an author download.
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != known.get(item.id):
            try:
                pending = path.with_suffix(path.suffix + '.pending')
                if not gdown.download(id=item.id, output=str(pending), quiet=True):
                    raise RuntimeError('Author source download did not complete.')
                pending.replace(path)
            except Exception as error:
                print(f'Unavailable source file: {item.path}: {type(error).__name__}', flush=True)
                return {'file': item.path, 'driveId': item.id, 'unavailable': str(error)}
        result = {'file': str(path.relative_to(BASE)), 'driveId': item.id,
                  'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        print(result['file'], result['bytes'], flush=True)
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(download, files))
    manifest = {'author': 'Quaternius', 'pack': 'Ultimate Animated Animal Pack',
                'source': SOURCE, 'folder': FOLDER, 'license': 'CC0-1.0', 'files': records}
    (BASE / 'provenance.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
