# Pretrained motion inbetweening — researched and executed 2026-10-08

## Which downloadable model actually accepts sparse authored poses?

### Takeaway

CondMDI is the best verified fit for this editor: its learned conditioning accepts sparse pose observations, and its authors publish checkpoints. We implemented local inference using the original **random-frames** checkpoint and MoLab's maintained feature codecs, then demonstrated both the built-in mannequin and an 18.2-second Mixamo character. [Author implementation](https://github.com/setarehc/diffusion-motion-inbetweening), [local implementation](../../backend/inbetween.py), [executed results](../../.local/ai-motion/roundtrip-proof.json)

### Cited Findings

| Candidate | Published assets and conditioning | Decision |
|---|---|---|
| CondMDI | Authors provide random-frames, random-frames-and-joints, and unconditional checkpoints; pose conditioning can run without text. | Selected: direct match to six full-body authored poses. [Source](https://github.com/setarehc/diffusion-motion-inbetweening) |
| MoLab | Maintained CondMDI integration with an inference worker and Windows setup; uses the HumanML3D joint representation. | Reuse its codecs and model implementation, with a separate source-skeleton adapter. [Repository](https://github.com/JasonNero/MoLab), [worker documentation](https://jasonnero.github.io/MoLab/api-reference/inference-worker/) |
| DART | Pretrained models and motion inbetweening optimization are published. Its SMPL-oriented inputs include root/body pose and shape parameters. | Strong follow-up candidate, but a larger integration than direct sparse-pose conditioning. Its advertised fast generation speed is not a measured inbetweening latency for this app. [Repository and examples](https://github.com/zkf1997/DART) |
| MoMask | Published weights and temporal motion editing through masked motion tokens. | Not selected for the first arbitrary full-pose hard-constraint adapter. [Author repository](https://github.com/EricGuo5513/momask-codes) |
| CAMDM | Published model and Unity demo for responsive character motion controlled through motion history and coarse controls. | Different interaction model from offline six-pose authoring. [Author repository](https://github.com/AIGAnimation/CAMDM) |
| Delta Interpolator | Published pretrained transition model and LaFAN1-focused implementation. | Viable transition research reference; not verified here as an arbitrary multi-pose editor engine. [Author repository](https://github.com/boreshkinai/delta-interpolator), [published weights](https://storage.googleapis.com/delta-interpolator/pretrained_model.zip) |
| PhaseBetweener | Learned motion inbetweening implementation; project use is limited to research/education, with separately restricted motion data. | Not the default for a potentially commercial application. [Author repository and terms](https://github.com/paulstarke/PhaseBetweener) |

### Inferences

- CondMDI's conditioning matches the required workflow more directly than text-first generation or online joystick control. This is an integration judgment, not an exhaustive quality ranking. [CondMDI paper](https://arxiv.org/abs/2405.11126)
- Other models were researched, not installed or benchmarked. The recommendation rests on an actual local CondMDI run rather than assuming every published checkpoint is runnable. [Local proof](../../.local/ai-motion/proof.json)

### Gaps

- No verified pretrained quadruped sparse-pose engine was found within this research scope. CondMDI is trained on human motion and the adapter explicitly rejects quadrupeds. [Training description](https://github.com/setarehc/diffusion-motion-inbetweening), [adapter](../../backend/inbetween.py)
- Numerical validation proves learned behavior and data preservation, not that every transition is aesthetically convincing or physically feasible. No claim of parity with Cascadeur is supported by these tests. [Test outputs](../../.local/ai-motion/roundtrip-proof.json)

## What was installed, measured, and preserved in the real inference path?

### Takeaway

The installed network has 235,122,951 learned parameters and runs on this Windows RTX 4090 through an isolated Python environment. A four-second six-key example takes about 3.6 seconds of diffusion and 10.1 seconds including cold loading; the 18.2-second Mixamo example takes approximately 9.2 seconds of diffusion and 16.4 seconds total. These are local measurements, not vendor benchmarks. [Proof](../../.local/ai-motion/proof.json), [round-trip measurements](../../.local/ai-motion/roundtrip-proof.json)

### Cited Findings

- Runtime: `.local/ai-motion/.venv/Scripts/python.exe`, Python 3.10, PyTorch 2.5.1/CUDA 12.4, pinned MoLab revision `669cb9ceec87dcdb9beae81e4aefd8ba63295a6e`. Setup leaves global Python packages unchanged. The script passed a complete rerun against this installation. [Setup script](../../scripts/setup-ai-motion.ps1), [runtime manifest](../../.local/ai-motion/runtime.json)
- Model representation: HumanML3D absolute-root features, 263 channels, 22 canonical body joints, native 20 fps. Source local transforms use xyzw quaternions and meter coordinates. A 100-step DDIM sampler starts from random noise and observes the authored pose features during denoising. [Network source](https://github.com/setarehc/diffusion-motion-inbetweening/blob/main/model/mdm_unet.py), [adapter and sampler](../../backend/inbetween.py)
- The network produces fresh unobserved motion: a public motion fixture differs from linear joint interpolation by **0.06964 m RMS**; seeds 42 and 43 differ by **0.01602 m RMS**. Observed canonical poses remain within **6.3e-8 m RMS**. Peak allocated VRAM is about **1,369 MiB**, excluding other applications and CUDA driver overhead. [Reproducible proof script](../../.local/ai-motion/prove_model.py), [proof result](../../.local/ai-motion/proof.json)
- Changing one authored elbow by 0.45 radians with the same seed changes unobserved world positions by **0.00701 m RMS**, other-body joints by **0.00234 m RMS**, and frames outside the adjacent key interval by **0.00136 m RMS**. This verifies contextual learned output instead of relabeling local interpolation. [Conditioning proof](../../.local/ai-motion/conditioning-proof.json)
- The production adapter preserves every authored pose exactly. The 21-bone mannequin and 119-bone Mixamo fixture retain source bone lengths within **7e-16 m** and produce finite, normalized rotations. Unmapped fingers/twist joints retain their existing local animation. The Python worker returns transforms; it does not replace the mesh, skeleton, or skin weights. [Round-trip proof](../../.local/ai-motion/roundtrip-proof.json), [implementation](../../backend/inbetween.py)
- Clips longer than the model's 196-frame context use overlapping windows: 40 frames of generated history condition the next window. The 18.2-second test uses three windows. App limit is 60 seconds; long-window coherence is an application extension, not a published CondMDI guarantee. [Window implementation](../../backend/inbetween.py)

### Inferences

- This machine has adequate spare GPU memory for the tested inference path; a 2 GB free-memory check protects against starting when another workload consumes most VRAM. Exact headroom and speed vary with concurrent workloads. [Runtime check](../../backend/inbetween.py), [measured peak](../../.local/ai-motion/roundtrip-proof.json)
- Name mapping plus directional retargeting avoids altering imported binding hierarchies, but unusual anatomy and axes may need explicit mapping or a better retarget solver. This is the principal quality risk for arbitrary imported rigs. [Mapping and retarget code](../../backend/inbetween.py)

### Gaps

- Model-native observations snap to 20 fps; exact authored times are restored after output resampling. Two keys mapping to the same native frame are rejected. [Timing implementation](../../backend/inbetween.py)
- Long Mixamo output differs from sparse interpolation by roughly 0.50 m RMS. That is evidence of substantial generated movement, not a quality score; long transitions can drift and need visual review. [Measured output](../../.local/ai-motion/roundtrip-proof.json)
- CondMDI supplies a learned human motion prior, not rigid-body dynamics or a guarantee of contact, balance, or collision correctness. Physics requires a separate validated pass. [Returned provider warnings](../../backend/inbetween.py)

## Are code, checkpoint provenance, and commercial rights established?

### Takeaway

Code provenance and actual checkpoint identity are established. Commercial clearance for pretrained weights and underlying training data is **not established** by an MIT code license or a mirror's metadata; model assets stay local and are not bundled with the app. [Author license statement](https://github.com/setarehc/diffusion-motion-inbetweening#license), [MoLab license](https://github.com/JasonNero/MoLab/blob/main/LICENSE)

### Cited Findings

- The deployed checkpoint comes directly from the authors' random-frames archive, linked in their README. Only its averaged model state is converted to SafeTensors; optimizer data is not extracted. Every one of the **196 learned tensors** matches the original `model_avg` bit-for-bit. Deterministic positional buffers and unused text-encoder weights are excluded. [Author download](https://drive.google.com/file/d/15mYPp2U0VamWfu1SnwCukUUHczY9RPIP/view), [provenance proof](../../.local/ai-motion/primary-provenance.json), [installer](../../backend/install_model.py)
- Deployed SHA-256: `ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361`. The runtime verifies this hash before loading. Checkpoint and manifest updates use temporary files and atomic replacement. [Manifest](../../.local/ai-motion/runtime.json), [installer](../../backend/install_model.py)
- An initially evaluated Hugging Face mirror labels its model as frames-and-joints while its config says random-frames. Its weights did not match the official random-frames checkpoint, so it is not the production source. This discrepancy does not establish that the mirror is invalid; it establishes that its identity was insufficiently clear for this build. [Mirror card](https://huggingface.co/ZeyuLing/motius-condmdi-humanml3d), [current primary-source verification](../../.local/ai-motion/primary-provenance.json)
- CondMDI states its **code** is MIT and explicitly requires respecting dependency and dataset licenses. MoLab also distributes its code under MIT. HumanML3D is a processed motion-language dataset based on underlying motion sources, rather than blanket rights to all upstream motion assets. [CondMDI license](https://github.com/setarehc/diffusion-motion-inbetweening/blob/main/LICENSE), [MoLab license](https://github.com/JasonNero/MoLab/blob/main/LICENSE), [HumanML3D source](https://github.com/EricGuo5513/HumanML3D)
- DART expressly covers its code and model under Apache 2.0, while separately identifying third-party assets with their own licenses. That is stronger model-license wording, but does not waive third-party SMPL/data terms. [DART license](https://github.com/zkf1997/DART/blob/main/LICENSE)

### Inferences

- Keep model downloads separate from distributable app assets, preserve upstream copyright notices, and resolve pretrained-model/training-data rights before commercial packaging. Local execution avoids transmitting a user's character files but does not itself resolve licensing. [Author terms](https://github.com/setarehc/diffusion-motion-inbetweening#license)

### Gaps

- No distinct, unambiguous commercial-use grant for this exact CondMDI checkpoint and all underlying training material was established. Obtaining author confirmation or choosing an explicitly cleared model remains a product-release requirement. [Published license scope](https://github.com/setarehc/diffusion-motion-inbetweening#license)
- DART and other candidates were not run, so their actual Windows installation cost, constrained inference latency, VRAM, and source-rig round-trip quality remain unmeasured here. [DART published environment](https://github.com/zkf1997/DART)
