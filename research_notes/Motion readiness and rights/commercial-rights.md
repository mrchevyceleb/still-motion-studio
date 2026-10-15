# Commercial model rights and the owned humanoid proof

> Historical development notes. Local verification artifacts are not distributed. See the current README and docs for supported behavior.

## Which CondMDI rights are actually established on October 8, 2026?

### Takeaway
CondMDI's MIT code grant is established; commercial rights for the exact author checkpoint and downstream generated motion are not. AMASS's public dataset license expressly restricts commercial-use model training, so public availability of an AMASS-trained checkpoint does not complete a commercial permission chain. [CondMDI scope](https://github.com/setarehc/diffusion-motion-inbetweening#license) · [AMASS terms](https://amass.is.tue.mpg.de/license.html)

### Cited Findings
- The deployed random-frames checkpoint is the authors' `model000750000.pt/model_avg`, converted to SafeTensors SHA-256 `ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361`. All 196 retained learned tensors match the original averaged state. [Author download](https://drive.google.com/file/d/15mYPp2U0VamWfu1SnwCukUUHczY9RPIP/view) · Local identity proof (local development artifact; not distributed)
- CondMDI states that all released models train on HumanML3D. Its README explicitly scopes MIT to code and requires following separate library and dataset licenses. The license names Setareh Cohan, Korrawe Karunratanakul, and Guy Tevet as code copyright holders. No distinct model license was found in the reviewed README or in the downloaded archive's license/README/terms entries. [README](https://github.com/setarehc/diffusion-motion-inbetweening) · [Code license](https://github.com/setarehc/diffusion-motion-inbetweening/blob/main/LICENSE) · Archived source responses (local development artifact; not distributed)
- HumanML3D originates from AMASS and HumanAct12 and says AMASS policy prevents direct redistribution of its motion data. Its code's MIT license does not replace AMASS terms. [HumanML3D README](https://github.com/EricGuo5513/HumanML3D) · [HumanML3D code license](https://github.com/EricGuo5513/HumanML3D/blob/main/LICENSE)
- AMASS names Max Planck as licensor, restricts commercial use and model training for commercial use, and prohibits dataset redistribution without permission. It offers a commercial licensing channel, `ps-license@tue.mpg.de`. [AMASS license](https://amass.is.tue.mpg.de/license.html)
- SMPL-Model has a non-commercial public grant and a separate commercial channel; SMPL-Body has CC-BY-4.0 terms. They are different assets/grants. The fresh local model does not load either model's parameters. [SMPL-Model](https://smpl.is.tue.mpg.de/modellicense.html) · [SMPL-Body](https://smpl.is.tue.mpg.de/bodylicense.html) · [Fresh model implementation](<../../backend/owned_humanoid.py>)
- Drafts request commercial checkpoint inference, conversion, redistribution/download, fine-tuning, end-user generated output, and clarification of upstream contributors' rights. They identify author contact Setareh Cohan and AMASS's licensing channel, with HumanML3D/SMPL routing when applicable. No request was sent. [Unsent requests](<../../docs/model-permission-requests.md>) · [Author contact](https://www.cs.ubc.ca/~setarehc/)

### Inferences
- The public AMASS language establishes restrictions on licensed dataset use. It does not, by itself, settle every downstream legal question for an end user who only obtains pretrained weights. Checkpoint scope, contractual applicability, generated outputs, and relevant contributor permissions require written clarification rather than an invented blanket answer.
- Keep the working CondMDI prototype separate from an independently documented commercial model path. Local downloads and file-format conversion do not create permissions.

### Gaps
- No written grant from the CondMDI checkpoint licensor or AMASS commercial licensing team has been obtained. No statement here certifies legality or non-infringement.
- The relevant original capture contributors and any separate permissions granted to CondMDI's authors are not fully documented in the reviewed sources.

## Is there a concrete independent commercial model path?

### Takeaway
Yes: start a new model from random parameters on the creator's CC0 motion, with a recorded source and training chain. This avoids carrying restricted pretrained weights or borrowed training statistics into the new provider; it does not make a small model production-quality. [Quaternius humanoid pack](https://quaternius.com/packs/universalanimationlibrary.html) · [Animal pack](https://quaternius.com/packs/ultimateanimatedanimals.html) · [CC0 text](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en)

### Cited Findings
- Quaternius publishes Universal Animation Library, Library 2, and Ultimate Animated Animal Pack as CC0 and expressly permits commercial use. The actual downloaded Standard archives include `License.txt` confirming CC0. [Library 1](https://quaternius.com/packs/universalanimationlibrary.html) · [Library 2](https://quaternius.com/packs/universalanimationlibrary2.html) · [Animal pack](https://quaternius.com/packs/ultimateanimatedanimals.html) · [Author FAQ](https://quaternius.com/faq.html) · Downloaded source record (local development artifact; not distributed)
- CC0 waives the affirmer's applicable copyright/database rights for commercial and other purposes, with a fallback license; it does not grant patents/trademarks or guarantee unrelated third-party rights. [CC0 legal text](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en)
- DART expressly grants Apache-2.0 for its own code and model but reserves AMASS/SMPL-family terms. It is not a verified blanket replacement for the rights problem. [DART license section](https://github.com/zkf1997/DART#license)
- AnyTop's model repository expressly makes checkpoints non-commercial research-only and excludes Truebones data rights. UniMate's model repository is CC-BY-NC-4.0 and excludes underlying Truebones, Mixamo, and Objaverse-XL rights. These model terms are separate from MIT code. [AnyTop model terms](https://huggingface.co/inbar2344/AnyTop/raw/main/LICENSE) · [UniMate model terms](https://huggingface.co/Linzhan/UniMate/raw/main/LICENSE) · Retrieved primary responses (local development artifact; not distributed)
- Adobe's Mixamo Additional Terms, effective June 23, 2021, restrict using service-derived material to create, train, test, or improve AI/ML. This rules out treating an ordinary animation download as permission to build our training corpus. [Adobe terms, section 1](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Mixamo-Addl-Terms-en_US-20210623.pdf)
- A commercial capture agreement is another practical route to more realistic data. Rokoko advertises an ML motion dataset and pre-agreement test samples, but its sales page does not itself grant a license. [Rokoko dataset offering](https://www.rokoko.com/mocap/motion-dataset)
- `backend/model-rights.json` separately records code, weights, data, and output scope. `get_model_rights` reports evidence; `assert_commercial_release` checks statuses, checkpoint hash, and recorded training/source artifacts. The gate passes the two exact fresh CC0-trained models and rejects CondMDI, DART, AnyTop, UniMate, and unknown providers for packaging. It does not gate local inference. [Manifest](<../../backend/model-rights.json>) · [Helper](<../../backend/model_rights.py>)

### Inferences
- Use the CC0-trained providers for an independently documented model-asset path, preserve dependency notices, and retain exact source/checkpoint receipts. Add commissioned motion only under terms expressly covering ML training, model distribution, and customer outputs.
- A new generation of weights must be reviewed against its own corpus and hash. Fine-tuning old research weights or using their generated motion as training data would defeat this clean provenance boundary.

### Gaps
- The source and model-asset checklist is not a complete package SBOM, patent analysis, or certification of rights in user-uploaded material.
- No commercially unrestricted, already-pretrained arbitrary-skeleton model with a completely established data chain was verified within this research scope.

## What does the freshly trained humanoid provider actually establish?

### Takeaway
The fresh model is runnable, learned, and preserves authored keys and rig structure, but its small stylized dataset did not yield better held-out reconstruction than interpolation. It is selectable as an experimental provider, with a review warning, and should not become the default on quality grounds. Training result (local development artifact; not distributed) · Broader diagnostic (local development artifact; not distributed) · Round-trip proof (local development artifact; not distributed)

### Cited Findings
- Downloaded directly from the author's free Standard distribution: UAL1 archive SHA-256 `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`; UAL2 `4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68`. GLB and included-license hashes are recorded. Acquisition manifest (local development artifact; not distributed)
- The usable corpus has 81 clips, split into 65 training and 16 entirely held-out clip identities. Training contains 2,136 original frames, approximately 107 seconds at 20 fps. Features are 21 named joint world positions normalized by rest height; statistics come only from training clips. No AMASS statistics, SMPL model parameters, or third-party pretrained weights are used. Dataset index (local development artifact; not distributed) · [Preparation](<../../training/prepare_humanoid_features.py>)
- Shared project-authored denoising network: 860,479 parameters, random initialization, 8,000 steps, 135.2 seconds on the RTX 4090. The checkpoint is 3.45 MB, SHA-256 `9cf001f219c4200d143122734da2839e01301f7e2135aebfe2d04b61f14732f7`. Model/training receipt (local development artifact; not distributed) · [Network](<../../backend/learned_motion.py>)
- Initial six-key held-out test: target RMS error 0.02959 for interpolation and 0.05873 for learned output, in rest-height-normalized feature units. Seed difference RMS was 0.03298; observations remained exact. Expanded diagnostic over all 16 held-out clips/48 windows again showed worse reconstruction: 0.04298 baseline versus 0.06728 learned. These are source-clip holdouts from training, not a blind external benchmark. Initial validation (local development artifact; not distributed) · Expanded diagnostic (local development artifact; not distributed)
- Application-shaped requests passed on the CC0 65-bone character (41 frames) and the 21-bone demo (121 frames). Each preserves six authored poses exactly and all non-root local offsets; maximum quaternion normalization error was 2.23e-16. Warm calls took approximately 0.9 and 0.5 seconds. Round-trip proof (local development artifact; not distributed)
- The independent runtime uses `.local/owned-motion/.venv`, with no research model source checkout or weights required. `backend.owned_humanoid.generate_motion` accepts the standard virtual-rig request, supports humanoids up to 12 seconds, returns original bone slots, and always flags review. Setup reuses existing weights or reproduces the acquisition/import/training steps with `-Retrain`; extraction requires the local dev server and Playwright Chromium. [Adapter](<../../backend/owned_humanoid.py>) · [Setup](<../../scripts/setup-owned-humanoid.ps1>) · Runtime (local development artifact; not distributed)

### Inferences
- This closes the missing independent model/provenance implementation, not the broad humanoid quality gap. A larger properly licensed corpus, better proportional retargeting, and motion/contact-aware evaluation remain necessary.
- Keep the stronger separately installed learned engine available for current humanoid work while treating the owned humanoid model as a research-quality option.

### Gaps
- No claim of Cascadeur-level quality, broad realistic-human coverage, physical feasibility, or production readiness is supported by this small corpus.
- A separate deterministic conditional-regression experiment also failed to improve reconstruction and remains in ignored local experiment storage, outside the deployed provider.
