"""Acquire the author's free CC0 packs and record exact source hashes."""
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local' / 'owned-humanoid'
ARCHIVE_HASHES = {
    'universal-animation-library': 'cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724',
    'universal-animation-library-2': '4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68',
}


def main():
    BASE.mkdir(parents=True, exist_ok=True)
    sources = []
    for slug in ['universal-animation-library', 'universal-animation-library-2']:
        url = 'https://quaternius.itch.io/' + slug
        archive = BASE / (slug + '.zip')
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        page = opener.open(url, timeout=30).read().decode()
        (BASE / (slug + '.html')).write_text(page, encoding='utf-8')
        if not archive.is_file():
            csrf = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
            data = urllib.parse.urlencode({'csrf_token': csrf, 'source': 'view_game', 'as_props': '1'}).encode()
            reply = json.load(opener.open(urllib.request.Request(url + '/download_url', data=data), timeout=30))
            download = opener.open(reply['url'], timeout=30).read().decode()
            upload = re.search(r'data-upload_id="(\d+)"', download).group(1)
            data = urllib.parse.urlencode({'csrf_token': csrf}).encode()
            reply = json.load(opener.open(urllib.request.Request(url + '/file/' + upload + '?source=game_download&as_props=1', data=data), timeout=30))
            pending = archive.with_suffix('.pending.zip')
            pending.write_bytes(opener.open(reply['url'], timeout=90).read())
            if not zipfile.is_zipfile(pending):
                raise RuntimeError('Author download did not return a complete ZIP archive.')
            pending.replace(archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != ARCHIVE_HASHES[slug]:
            raise RuntimeError('The author archive differs from the reviewed CC0 source. Verify its origin/license before updating the pinned hash.')
        extracted = []
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.namelist():
                if not (member.lower().endswith('_rm.glb') or member.lower().endswith('license.txt')):
                    continue
                path = (BASE / 'source' / member).resolve()
                if not path.is_relative_to((BASE / 'source').resolve()):
                    raise ValueError('Unsafe archive path.')
                path.parent.mkdir(parents=True, exist_ok=True)
                content = bundle.read(member)
                path.write_bytes(content)
                extracted.append({'file': str(path.relative_to(BASE)), 'sha256': hashlib.sha256(content).hexdigest()})
        sources.append({'id': slug, 'author': 'Quaternius', 'source': url, 'retrievedAt': '2026-10-08',
                        'license': 'CC0-1.0', 'archive': archive.name,
                        'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'files': extracted})
        print(slug, sources[-1]['archiveSha256'], len(extracted), 'retained files', flush=True)
    (BASE / 'sources.json').write_text(json.dumps({'sources': sources}, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
