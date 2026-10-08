# Local neural motion engine

The editor can run the pretrained CondMDI motion-diffusion model locally. It accepts sparse humanoid poses, generates the missing motion, and returns animation to the original skeleton. It does not replace imported skin weights. This pass uses a learned motion prior; physics is a separate engine.

## Install and run

On Windows with an NVIDIA CUDA GPU, `git` and `uv` available:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-ai-motion.ps1
npm run dev
```

Setup creates `.local/ai-motion/.venv`, installs pinned inference dependencies, fetches a pinned MIT-licensed MoLab checkout, downloads the authors' 3.49 GB checkpoint archive, and converts only the averaged network to a 940 MB SafeTensors file. Allow roughly 10 GB disk space including the archive, extracted source checkpoint, Python environment, and packages. Global Python packages are unchanged. Subsequent generation runs offline; user character files are never uploaded.

The server reads `.local/ai-motion/runtime.json`. Missing dependencies or weights produce an unavailable-engine message rather than procedural output marked as AI. The worker imports `backend.inbetween.generate_motion(request, progress)`. Runtime paths are server-owned and not supplied by the browser.

## Supported inputs and limits

- Humanoid rigs with recognized Mixamo, Unreal, or built-in mannequin joint names. Core head, spine, hip, leg, arm and hand mappings are required. Extra spine/clavicle/toe points can be synthesized for the model.
- At least two authored poses, with a distinct nearest 20 fps model frame for each. Six full-body poses are supported.
- Up to 60 seconds using overlapping 196-frame windows with 40-frame context. Long transitions can drift.
- Unit-scale local joint transforms in meters; returned rotations use xyzw quaternions. Output resamples to the requested frame rate and restores authored transforms and timestamps exactly.
- Quadrupeds are rejected because this checkpoint was trained on human motion.
- About 1.37 GB measured peak PyTorch allocation on this RTX 4090; the engine requires at least 2 GB free VRAM. Process startup and CUDA overhead are additional.

Retargeting preserves source local bone lengths and the existing finger/twist animation. It does not guarantee the quality of unfamiliar anatomy, full-body contacts, balance, or collisions. Review generated movement before export.

## Provenance and license scope

The checkpoint is the authors' [CondMDI random-frames model](https://github.com/setarehc/diffusion-motion-inbetweening), using `model000750000.pt` / `model_avg`. The installed network's 196 learned tensors were compared directly with that source and match exactly. The deployed SafeTensors SHA-256 is:

```text
ffc0429202d91043d0c96ca3473d506a9df17ab5486e442a11f46330f81db361
```

CondMDI and [MoLab](https://github.com/JasonNero/MoLab) code are MIT-licensed. Preserve their notices. **This does not establish commercial rights for pretrained weights or their training data.** The authors explicitly point to separate dependency and dataset terms. Weights remain in ignored local storage and are not redistributed with the app. Commercial packaging needs separate rights confirmation.

See [research and measured validation](../research_notes/Real%20motion%20engines/pretrained-motion.md) for alternatives, source links, stochastic/conditioning checks, and four-second/18.2-second round-trip results.
