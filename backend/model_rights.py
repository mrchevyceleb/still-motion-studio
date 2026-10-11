"""Evidence checks for commercial model packaging, never an inference switch.

This is an asset-provenance checklist, not legal advice or product certification.
It intentionally treats absent permissions and unknown models as unresolved.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(os.environ.get('STILL_DATA_ROOT', ROOT)).resolve()
MANIFEST = Path(__file__).with_name('model-rights.json')
PERMITTED = {'permitted', 'project_trained', 'not_applicable'}


def get_model_rights(provider_id: str, runtime_override: dict | None = None) -> dict:
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
    runtime_base = {'owned_humanoid': 'owned-humanoid', 'quadruped': 'quadruped'}.get(provider_id)
    runtime_file = DATA_ROOT / '.local' / runtime_base / 'runtime.json' if runtime_base else None
    if runtime_override is not None or (runtime_file and runtime_file.is_file()):
        try:
            runtime = runtime_override if runtime_override is not None else json.loads(runtime_file.read_text(encoding='utf-8-sig'))
            installation = runtime.get('installation')
            if runtime_override is not None and not installation:
                raise ValueError('Desktop models require a complete verified installation manifest.')
            if installation:
                from backend.model_bundle import sha, verify_bundle
                directory = Path(runtime['config']['checkpointPath']).resolve()
                if not directory.is_relative_to(DATA_ROOT):
                    raise ValueError('Installed model must remain within the application data directory.')
                if directory.is_file() or (directory / 'complete.json').is_dir():
                    raise ValueError('Installed model paths have an invalid file/directory shape.')
                metadata, validation, bundle = verify_bundle(directory, entry.get('approvedCorpusSha256'), approved_files_hash=entry.get('approvedCorpusFilesSha256'))
                if installation.get('provider') != provider_id or installation.get('modelSha256') != metadata['modelSha256'] or runtime['config'].get('modelSha256') != metadata['modelSha256'] or installation.get('bundleManifestSha256') != sha(directory / 'complete.json') or installation.get('approvedCorpusSha256') != metadata['dataIndexSha256']:
                    raise ValueError('Installed runtime and provenance bundle identities disagree.')
                result['model'] = {'checkpointPath': str(directory / 'model.safetensors'), 'sha256': metadata['modelSha256'],
                                   'initializedFrom': 'random', 'pretrainedWeightsUsed': False, 'parameters': metadata['parameters']}
                result['evidenceArtifacts'] = [{'path': str(directory / relative), 'sha256': digest} for relative, digest in bundle['files'].items() if relative != 'model.safetensors']
                result['qualityValidation'] = validation
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            blockers.append('Installed model bundle verification failed: ' + str(error))
        except OSError as error:
            if runtime_override is not None and not isinstance(error, (FileNotFoundError, IsADirectoryError, NotADirectoryError)):
                raise  # A temporary I/O failure must not reject an installed model.
            blockers.append('Installed model bundle verification failed: ' + str(error))
    for category in ['code', 'weights', 'trainingData', 'outputs']:
        if result.get('rights', {}).get(category, {}).get('status') not in PERMITTED:
            blockers.append(f'{category}: commercial scope is not established.')
    model = result.get('model')
    if model and model.get('checkpointPath'):
        path = (DATA_ROOT / model['checkpointPath']).resolve()
        if not path.is_relative_to(DATA_ROOT):
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


def assert_commercial_release(provider_id: str, runtime_override: dict | None = None) -> dict:
    """Raise unless this exact model's documented asset permission chain passes."""
    rights = get_model_rights(provider_id, runtime_override)
    if not rights['commercialReleaseAllowed']:
        raise ValueError(f'Commercial model release is not cleared for {provider_id}: ' + ' '.join(rights['blockers']))
    for artifact in rights.get('evidenceArtifacts', []):
        path = (DATA_ROOT / artifact['path']).resolve()
        if not path.is_relative_to(DATA_ROOT) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
            raise ValueError(f'Commercial model release evidence changed or is missing: {artifact["path"]}')
    return rights


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('provider')
    parser.add_argument('--assert-release', action='store_true')
    parser.add_argument('--runtime', type=Path, help='Verify this candidate desktop runtime before activation.')
    args = parser.parse_args()
    try:
        runtime = json.loads(args.runtime.read_text(encoding='utf-8-sig')) if args.runtime else None
        if args.runtime and not isinstance(runtime, dict):
            raise ValueError('The candidate runtime must be a JSON object.')
        rights = assert_commercial_release(args.provider, runtime) if args.assert_release else get_model_rights(args.provider, runtime)
    except ValueError as error:
        parser.exit(2, str(error) + '\n')
    except OSError as error:
        parser.exit(3, 'Model verification could not read its files: ' + str(error) + '\n')
    print(json.dumps(rights, indent=2))


if __name__ == '__main__':
    main()
