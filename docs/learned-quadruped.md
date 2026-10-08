# Still Quadruped

Still Quadruped is a small local neural model trained from scratch on Quaternius CC0 animal animation. It generates transitions between authored quadruped poses. No research-only pretrained weights or procedural gait generator are used.

The initial model learns the stylized animation family represented by its training pack. It is experimental; it does not guarantee realistic horse biomechanics, arbitrary animal anatomy, or physical contacts.

## Setup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-owned-quadruped.ps1
```

Setup creates `.local/owned-motion/.venv`, downloads the author's CC0 animation assets only when training is needed, prepares the corpus, trains a new network if weights are absent, and registers `.local/quadruped/runtime.json`. Global Python and the CondMDI environment are unchanged. Add `-Retrain` to deliberately train fresh weights; update the release rights record with the new checkpoint hash afterward.

The corpus, weights and metadata remain local. Inference requires no network request and never uploads a user's model.

## Input and output

- Supported: the 18-bone quadruped starter rig and recognized Quaternius animal joint names.
- Two or more authored poses at distinct native 20 fps frames; six poses are supported.
- Output keeps exact authored poses, original non-root bone lengths, skeleton hierarchy and skin weights.
- The model samples 81-frame windows; longer clips use overlapping history, up to 60 seconds. Review long transitions for drift.
- This pass supplies learned transitions. Apply the separate physics pass for contact and balance work.

`backend.quadruped.generate_motion(request, progress)` follows the same local worker protocol as the humanoid provider. The service owns runtime paths and hashes. Provider ID is `quadruped`.

## Training and validation

The fresh 855,862-parameter denoiser trained for 8,000 updates on 126 CC0 clips. All 13 Horse clips were held out; the duplicate Horse_White variant was excluded. Across 39 held-out horse windows, missing-frame normalized position RMS was 0.02255 versus 0.06496 for interpolation. This is a test within one related animation family, not a broad animation-quality benchmark.

Changing either seed or one key pose changes unobserved output. The actual app round trip preserved all six authored poses and non-root bone lengths. Four-second generation measured about two seconds including cold loading on the RTX 4090.

A 12-second/four-window check also preserved every anchor. The original 50-bone CC0 horse rig passed a separate round trip, including its separate IK foot roots. Existing authored translations are retained; generation adds no non-root bone-length changes.

The source asset license is [CC0 according to Quaternius](https://quaternius.com/packs/ultimateanimatedanimals.html), with [commercial use confirmed by the author](https://quaternius.com/faq.html). Newly trained weights do not incorporate AnyTop, SinMDM, UniMate, CondMDI, or other pretrained parameters. Source hashes and training/code metadata are in `.local/quadruped/quaternius/provenance.json` and `.local/quadruped/model/model.json`.

See [the complete research and validation record](../research_notes/Motion%20readiness%20and%20rights/learned-quadrupeds.md).
