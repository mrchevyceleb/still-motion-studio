"""One isolated engine job. The loopback service owns its input/output paths."""
from __future__ import annotations

import argparse
import importlib
import json
import math
import pathlib
import sys
import traceback

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def validate_request(data):
    if not isinstance(data, dict) or data.get('version') != 1:
        raise ValueError('Unsupported motion request format.')
    rig = data.get('rig', {})
    names, parents, rest = rig.get('names'), rig.get('parents'), rig.get('restPose')
    if not isinstance(names, list) or not 1 <= len(names) <= 512 or not all(isinstance(n, str) for n in names):
        raise ValueError('Choose a rig with between 1 and 512 joints.')
    if not isinstance(parents, list) or len(parents) != len(names):
        raise ValueError('The skeleton hierarchy is incomplete.')
    for index, parent in enumerate(parents):
        if not isinstance(parent, int) or parent < -1 or parent >= index:
            raise ValueError('The skeleton must list parents before their children.')
    duration = data.get('duration')
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 120:
        raise ValueError('Choose an animation between 0 and 120 seconds.')
    if data.get('fps') not in [20, 24, 30, 60]:
        raise ValueError('Unsupported animation frame rate.')

    def validate_pose(pose):
        if not isinstance(pose, list) or len(pose) != len(names):
            raise ValueError('A pose does not match the current skeleton.')
        for bone in pose:
            for field, count in [('position', 3), ('quaternion', 4), ('scale', 3)]:
                values = bone.get(field) if isinstance(bone, dict) else None
                if not isinstance(values, list) or len(values) != count or not all(isinstance(v, (int, float)) and math.isfinite(v) and abs(v) < 1e6 for v in values):
                    raise ValueError('The motion contains invalid joint transforms.')
            if sum(v*v for v in bone['quaternion']) < 1e-10:
                raise ValueError('The motion contains an invalid joint rotation.')

    validate_pose(rest)
    for field in ['frames', 'anchors']:
        frames = data.get(field)
        if not isinstance(frames, list) or not 1 <= len(frames) <= 7201:
            raise ValueError('The motion request needs valid frames and key poses.')
        previous = -1.0
        for frame in frames:
            time = frame.get('time') if isinstance(frame, dict) else None
            if not isinstance(time, (int, float)) or not math.isfinite(time) or time < 0 or time > duration + 1e-5 or time <= previous:
                raise ValueError('Motion frame times must be unique and increasing.')
            validate_pose(frame.get('pose'))
            previous = time
    settings = data.get('settings', {})
    for field, maximum in [('gravity', 30), ('strength', 1)]:
        value = settings.get(field)
        if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError('The motion settings are invalid.')
    return data


def progress(message, fraction=0):
    print(json.dumps({'event': 'progress', 'message': str(message), 'progress': max(0, min(1, float(fraction)))}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--provider', required=True, choices=['inbetween', 'physics', 'owned_humanoid', 'quadruped'])
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        request = validate_request(json.loads(pathlib.Path(args.input).read_text(encoding='utf-8')))
        progress('Starting the local motion engine…', 0.02)
        module = importlib.import_module(f'backend.{args.provider}')
        function = module.correct_motion if args.provider == 'physics' else module.generate_motion
        result = function(request, progress)
        if not isinstance(result, dict) or not result.get('frames'):
            raise ValueError('The engine returned no animation frames.')
        validate_request({**request, 'frames': result['frames']})
        pathlib.Path(args.output).write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
        progress('Motion ready.', 1)
    except Exception as error:
        print(json.dumps({'event': 'error', 'message': str(error) or error.__class__.__name__}), flush=True)
        traceback.print_exc(file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
