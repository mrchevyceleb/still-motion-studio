"""Evidence checks for commercial model packaging, never an inference switch.

This is an asset-provenance checklist, not legal advice or product certification.
It intentionally treats absent permissions and unknown models as unresolved.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path(__file__).with_name('model-rights.json')
PERMITTED = {'permitted', 'project_trained', 'not_applicable'}


def get_model_rights(provider_id: str) -> dict:
    """Read known evidence and compute readiness; does not change local access."""
    document = json.loads(MANIFEST.read_text(encoding='utf-8'))
    provider_id = document.get('aliases', {}).get(provider_id, provider_id)
    entry = document['providers'].get(provider_id)
    if entry is None:
        return {'id': provider_id, 'status': 'unassessed', 'commercialReleaseAllowed': False,
                'blockers': ['No rights record exists for this provider.'],
                'checkedAt': document['checkedAt'], 'scope': document['scope']}
    result = copy.deepcopy(entry)
    blockers = list(result.get('blockers', []))
    for category in ['code', 'weights', 'trainingData', 'outputs']:
        if result.get('rights', {}).get(category, {}).get('status') not in PERMITTED:
            blockers.append(f'{category}: commercial scope is not established.')
    model = result.get('model')
    if model and model.get('checkpointPath'):
        path = (ROOT / model['checkpointPath']).resolve()
        if not path.is_relative_to(ROOT):
            blockers.append('Checkpoint path is outside this project.')
        elif not path.is_file():
            blockers.append('The reviewed checkpoint is missing.')
        elif not model.get('sha256'):
            blockers.append('The checkpoint hash has not been recorded.')
        elif hashlib.sha256(path.read_bytes()).hexdigest() != model['sha256']:
            blockers.append('The installed checkpoint differs from the reviewed artifact.')
    elif result.get('rights', {}).get('weights', {}).get('status') == 'project_trained':
        blockers.append('The project-trained model has no pinned checkpoint artifact.')
    blockers = list(dict.fromkeys(blockers))
    result.update(id=provider_id, checkedAt=document['checkedAt'], scope=document['scope'],
                  commercialReleaseAllowed=not blockers, blockers=blockers,
                  status='documented_asset_path' if not blockers else 'needs_clearance')
    return result


def assert_commercial_release(provider_id: str) -> dict:
    """Raise unless this exact model's documented asset permission chain passes."""
    rights = get_model_rights(provider_id)
    if not rights['commercialReleaseAllowed']:
        raise ValueError(f'Commercial model release is not cleared for {provider_id}: ' + ' '.join(rights['blockers']))
    for artifact in rights.get('evidenceArtifacts', []):
        path = (ROOT / artifact['path']).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
            raise ValueError(f'Commercial model release evidence changed or is missing: {artifact["path"]}')
    return rights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provider')
    parser.add_argument('--assert-release', action='store_true')
    args = parser.parse_args()
    try:
        rights = assert_commercial_release(args.provider) if args.assert_release else get_model_rights(args.provider)
    except ValueError as error:
        parser.exit(2, str(error) + '\n')
    print(json.dumps(rights, indent=2))


if __name__ == '__main__':
    main()
