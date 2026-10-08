"""Atomically activate a complete, tested CC0 quadruped candidate."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.model_installation import activate
parser = argparse.ArgumentParser()
parser.add_argument('--candidate', type=Path, required=True)
args = parser.parse_args()
print(json.dumps(activate('quadruped', args.candidate)))
