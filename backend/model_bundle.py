"""Portable verification for complete, approved motion model bundles."""
from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_bundle(directory, approved_data_hash=None, require_improvement=True, approved_files_hash=None):
    directory = Path(directory).resolve()
    complete = json.loads((directory / 'complete.json').read_text(encoding='utf-8-sig'))
    required = {'model.safetensors', 'model.json', 'validation.json', 'provenance/data-index.json', 'provenance/dataset-files.json', 'provenance/trainer.py', 'provenance/network.py'}
    if not required.issubset(complete.get('files', {})):
        raise ValueError('Candidate is incomplete; no installed model was changed.')
    for relative, expected in complete['files'].items():
        path = (directory / relative).resolve()
        if not path.is_relative_to(directory) or not path.is_file() or sha(path) != expected:
            raise ValueError('Candidate content or provenance hash mismatch: ' + relative)
    metadata = json.loads((directory / 'model.json').read_text(encoding='utf-8-sig'))
    proof = json.loads((directory / 'validation.json').read_text(encoding='utf-8-sig'))
    if metadata.get('initializedFrom') != 'random' or metadata.get('pretrainedWeightsUsed') is not False:
        raise ValueError('Only freshly trained project weights may be activated.')
    if metadata.get('modelSha256') != sha(directory / 'model.safetensors') or proof.get('modelSha256') != metadata['modelSha256'] or complete.get('modelSha256') != metadata['modelSha256']:
        raise ValueError('Candidate model identities disagree.')
    if metadata.get('dataIndexSha256') != sha(directory / 'provenance/data-index.json'):
        raise ValueError('Training data provenance is not bound to this checkpoint.')
    if approved_data_hash and metadata['dataIndexSha256'] != approved_data_hash:
        raise ValueError('This corpus has not been cleared by the project rights registry.')
    if metadata.get('dataFilesSha256') != sha(directory / 'provenance/dataset-files.json') or (approved_files_hash and metadata.get('dataFilesSha256') != approved_files_hash):
        raise ValueError('The exact feature files used for training are not approved.')
    if metadata.get('trainerSha256') != sha(directory / 'provenance/trainer.py') or metadata.get('networkSha256') != sha(directory / 'provenance/network.py'):
        raise ValueError('Training implementation provenance is not bound to the checkpoint.')
    index = json.loads((directory / 'provenance/data-index.json').read_text(encoding='utf-8-sig'))
    entries = {entry['id']: entry for entry in index['clips']}
    train, calibration, test = (set(metadata.get(key, [])) for key in ('trainingClipIds', 'calibrationClipIds', 'heldOutClipIds'))
    if not train or not test or train & test or calibration & test or train & calibration:
        raise ValueError('Training, calibration and held-out identities must be disjoint.')
    if train | calibration != {entry['id'] for entry in index['clips'] if entry['split'] == 'train'} or test != {entry['id'] for entry in index['clips'] if entry['split'] == 'test'}:
        raise ValueError('Checkpoint split identities disagree with the approved dataset.')
    if any(entries[key].get('license') != 'CC0-1.0' for key in train | calibration | test):
        raise ValueError('The recorded training dataset contains an uncleared clip.')
    baseline, learned = proof.get('baselineTargetRms', -1), proof.get('learnedTargetRms', -1)
    per_clip = proof.get('perClip', [])
    expected_frames = sum(entries[key]['frames'] for key in test)
    expected_predictions = sum(entries[key]['frames'] - 2 for key in test)
    complete_test = (
        len(per_clip) == len(test)
        and {entry.get('id') for entry in per_clip} == test
        and proof.get('heldOutSourceFrames') == expected_frames
        and proof.get('predictedFrames') == expected_predictions
        and proof.get('conditioningPasses') == 2
        and all(
            item.get('sourceFrames') == entries[item['id']]['frames']
            and item.get('predictionEligibleFrames') == entries[item['id']]['frames'] - 2
            and item.get('predictedFrames') == item.get('predictionEligibleFrames')
            and item.get('minimumInteriorPredictions', 0) >= 1
            and item.get('unknownValues', 0) > 0
            for item in per_clip
        )
    )
    numeric_gain = isinstance(baseline, (int, float)) and isinstance(learned, (int, float)) and math.isfinite(baseline) and math.isfinite(learned) and 0 <= learned < baseline * .99
    if require_improvement and (proof.get('protocol') != 'all-interior-frames-overlap-two-key-phases-v3' or not proof.get('finite') or not proof.get('beatsInterpolation') or not numeric_gain or not complete_test or proof.get('heldOutClips') != len(test) or proof.get('maxObservedFeatureError', 1) > 1e-6):
        raise ValueError('Candidate failed complete held-out quality/anchor gates; the installed model was preserved.')
    return metadata, proof, complete
