# Learned quadruped motion — research and implementation, 2026-10-08

## Which pretrained animal models fit sparse-pose authoring and commercial use?

### Takeaway

Published models can generate animal motion and perform inbetweening, but the strongest directly usable checkpoints located here have explicit noncommercial restrictions or unresolved animal-data rights. We instead trained a fresh, small conditional model from Quaternius CC0 authored animations. [AnyTop checkpoint terms](https://huggingface.co/inbar2344/AnyTop/raw/main/LICENSE), [UniMate checkpoint terms](https://huggingface.co/Linzhan/UniMate/raw/main/LICENSE), [Quaternius pack](https://quaternius.com/packs/ultimateanimatedanimals.html)

### Cited Findings

- **AnyTop** supports diverse skeleton topologies and publishes motion editing/inpainting code. Its source code is MIT, but its checkpoint repository explicitly restricts model/data files to noncommercial research and identifies Truebones ZOO as the source. Therefore, MIT source code does not clear those weights for this app's commercial default. [Code](https://github.com/Anytop2025/Anytop), [checkpoint license](https://huggingface.co/inbar2344/AnyTop/raw/main/LICENSE)
- **UniMate** publishes arbitrary-keyframe replacement during flow sampling and examples for unseen quadruped rigs. Its released weights are explicitly CC BY-NC 4.0; its source code is separately MIT. [Author code and inbetweening documentation](https://github.com/Friedrich-M/UniMate), [weight license](https://huggingface.co/Linzhan/UniMate/raw/main/LICENSE)
- **SinMDM** publishes single-motion animal checkpoints and prefix/suffix inbetweening. The zoo checkpoints derive from Truebones animation; source code is MIT, but no independently verified commercial checkpoint grant was found here. [Author repository](https://github.com/SinMDM/SinMDM)
- **Quaternius Ultimate Animated Animal Pack** contains 12 animal assets and authored actions including walk, gallop, jump, idle and attacks. The author explicitly labels the pack CC0 and permits commercial use and modification. [Pack and author-linked downloads](https://quaternius.com/packs/ultimateanimatedanimals.html), [author FAQ](https://quaternius.com/faq.html)

### Inferences

- Training from the CC0 authored animation source provides a more clearly documented commercial path than redistributing research-only pretrained animal weights. This is a source-provenance conclusion, not a claim that the small replacement model matches those larger research systems. [Source terms](https://quaternius.com/faq.html), [fresh training implementation](../../training/train_motion_prior.py)

### Gaps

- No commercially cleared, high-quality pretrained animal inbetweening checkpoint was verified within this research scope. This is not a claim that none exists. The inspected alternatives remain documented for future evaluation. [AnyTop terms](https://huggingface.co/inbar2344/AnyTop/raw/main/LICENSE), [UniMate terms](https://huggingface.co/Linzhan/UniMate/raw/main/LICENSE)

## What model was actually trained and does it produce learned transitions?

### Takeaway

The implemented **Still Quadruped** provider is an 855,862-parameter neural transition model trained from random initialization on 126 CC0 authored animation clips. It performs seeded denoising conditioned on sparse poses; no pretrained weights, motion-capture research datasets, or procedural gait generator enter its training or inference path. [Training record](../../.local/quadruped/model/model.json), [network](../../backend/learned_motion.py), [corpus preparation](../../training/prepare_quadruped.py)

### Cited Findings

- Training sources: ten animals provide 126 clips; all 13 clips for Horse are held out. The Horse_White color variant is excluded entirely to prevent that duplicate entering training. Source GLTF files and their SHA-256 hashes are recorded; the author-linked download folder supplied them. [Corpus index](../../.local/quadruped/corpus/index.json), [source manifest](../../.local/quadruped/quaternius/provenance.json), [download implementation](../../training/download_quadruped_data.py)
- Features are 18 canonical world-space joint positions, normalized by rest hip height with the rest foot floor at zero. The network receives noisy residual motion, sparse-pose interpolation, an observation mask, and rest anatomy. Training samples two through eight key poses, learns missing-frame residuals, and includes a velocity loss. Inference begins with a seeded Gaussian latent and applies 40 learned denoising steps. [Fresh network](../../backend/learned_motion.py), [trainer](../../training/train_motion_prior.py)
- Training ran for 8,000 updates in approximately 135 seconds on the local RTX 4090. Train-only statistics, initialization seed, clip split, trainer/network hashes and checkpoint hash are saved with the model. [Training metadata](../../.local/quadruped/model/model.json)
- Across **39 windows covering all 13 held-out horse clips**, with six observations per window, normalized missing-frame position RMS fell from **0.064962** for interpolation to **0.022549** for learned output: approximately **65.3% lower error**. Seed 42 versus 43 changes unobserved output by **0.004669 RMS**. Observed feature error is exactly zero. [Executed validation](../../.local/quadruped/validation-proof.json)
- The actual app's 18-bone quadruped request produced 121 frames from six poses. Changing the seed changes unobserved world positions by **0.00624 m RMS**. Editing one front-leg key changes unobserved motion by **0.0180 m RMS**, including other legs by **0.01471 m RMS**. All six edited key poses remain exact, and maximum non-root bone-length error is **3.3e-16 m**. [App round-trip proof](../../.local/quadruped/validation-proof.json)
- A 12-second request passed through four overlapping windows into 361 output frames with all six anchors exact. A separate held-out CC0 Horse asset retained all 50 source bones and its five roots, with finite output, exact authored poses, and zero additional non-root bone-length changes. The source contains intentional animated translations on controls/body joints; those existing translations are preserved rather than compared incorrectly with a static rest pose. [Extended proof](../../.local/quadruped/extended-proof.json)
- A cold local provider call took about **2.1 seconds**, including **0.33 seconds** of sampling. A subsequent warm-process proof call took about **0.42 seconds**, including **0.18 seconds** of sampling. These are measured on this machine; PyTorch allocations were roughly **13–19 MiB**, excluding driver/runtime overhead and other applications. [Validation output](../../.local/quadruped/validation-proof.json), [provider](../../backend/quadruped.py)

### Inferences

- The seed and changed-condition experiments demonstrate genuine learned conditional generation rather than ordinary interpolation carrying an AI label. The held-out reconstruction improvement demonstrates useful behavior on this specific animation family. [Executed proof](../../.local/quadruped/validation-proof.json)
- The evaluation holds out one animal asset and its clips, but other animals in the pack share related authored action styles. It measures generalization within a stylized asset family, not broad real-animal biomechanics. [Corpus and split](../../.local/quadruped/corpus/index.json)

### Gaps

- The model is small and its source animation library is limited. No claim is supported for arbitrary animal anatomy, new species, realistic horse locomotion, novel complex actions, or Cascadeur-level quality. Its UI warning explicitly states this scope. [Provider warnings](../../backend/quadruped.py)
- A learned motion prior is not a physics solver. Foot contact, balance and collision constraints require the separate physics pass and visual inspection. [Provider behavior](../../backend/quadruped.py)

## How are source rigs, local operation, and rights preserved?

### Takeaway

The runtime operates locally in a separate environment, leaves the humanoid research engine unchanged, and retargets generated joint directions onto the existing character. The model's training provenance is auditable without borrowing third-party pretrained parameters. [Runtime manifest](../../.local/quadruped/runtime.json), [adapter](../../backend/quadruped.py)

### Cited Findings

- Provider ID is `quadruped`; worker entry point is `backend.quadruped.generate_motion(request, progress)`. The model and metadata remain under `.local/quadruped/model`; the dedicated interpreter is `.local/owned-motion/.venv/Scripts/python.exe`. Setup installs ordinary numerical dependencies and does not fetch research model weights. [Runtime setup](../../scripts/setup-owned-runtime.ps1), [quadruped setup](../../scripts/setup-owned-quadruped.ps1)
- Native model sampling is 20 fps with an 81-frame training context. Longer clips use 20-frame overlapping histories, with an app limit of 60 seconds. Authored times and transforms are restored exactly after output resampling. [Provider](../../backend/quadruped.py)
- Retargeting changes rotations and real root translations while preserving every non-root local bone offset. It handles the starter rig and recognized Quaternius animal names, including separate IK foot roots. Meshes, existing skeleton hierarchies and skin bindings are not replaced by the Python provider. [Retarget implementation](../../backend/quadruped.py)
- Checkpoint SHA-256 is `74990bcc8f6e25a424a387a302bd6c2435d22cf2e224e03ba810120c63751747`; runtime loading checks it against both the trusted server manifest and model metadata. Training metadata records `initializedFrom: random` and `pretrainedWeightsUsed: false`. [Model metadata](../../.local/quadruped/model/model.json), [runtime registration](../../training/register_quadruped.py)
- The author site's CC0 statements were verified. The separate Drive `License.txt` download failed, and that failure is recorded rather than silently treated as a retrieved license file. The pack page and FAQ provide the primary rights evidence. [Source manifest](../../.local/quadruped/quaternius/provenance.json), [pack page](https://quaternius.com/packs/ultimateanimatedanimals.html), [FAQ](https://quaternius.com/faq.html)

### Inferences

- Source asset hashes, train/test identities and code hashes make it possible to reproduce or audit the training chain. GPU-level exact reproducibility across different machines is not guaranteed merely by saving the random seed. [Training metadata](../../.local/quadruped/model/model.json)

### Gaps

- Unrecognized joint names still require mapping. Matching names alone cannot guarantee that unusual bone axes or anatomy behave well. [Mapping implementation](../../backend/quadruped.py)
- Long sequences use an application-level windowing extension. The 12-second boundary test verifies data integrity and exact constraints; it does not establish contact quality or global coherence for every 60-second sequence. [Extended proof](../../.local/quadruped/extended-proof.json), [windowing code](../../backend/quadruped.py)
