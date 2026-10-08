# Still humanoid — experimental local model

This is a freshly trained 860,479-parameter neural motion prior. Its only training motions are Quaternius' CC0 Universal Animation Library Standard clips. It uses no CondMDI/AMASS weights or statistics. Six-pose tests preserve the exact authored poses and original non-root bone offsets.

**Its held-out reconstruction is worse than interpolation.** Across 16 held-out clips/48 windows, normalized missing-pose RMS was 0.06728 versus 0.04298 for interpolation. The model remains selectable for experimentation and always marks its output for review; it should not be promoted as a quality improvement or a physics solver.

With the trained local checkpoint present:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-owned-humanoid.ps1
```

To reproduce training, start `npm run dev`, ensure Playwright Chromium is installed (or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`), and add `-Retrain`. This downloads the author's free CC0 packs, samples them through Still's actual importer, splits complete clip identities, and trains random-initialized parameters for 8,000 updates. A new run may produce a different hash; review its provenance before updating the commercial model-assets manifest.

The runtime manifest is `.local/owned-humanoid/runtime.json`; the separate interpreter is `.local/owned-motion/.venv/Scripts/python.exe`. The worker calls `backend.owned_humanoid.generate_motion(request, progress)`. Recognized humanoids up to 12 seconds are supported, with model observations at 20 fps and exact source keys restored afterward. Unfamiliar anatomy, long sparse gaps, foot contact, and motion intent still need inspection.

See [source/permission evidence](motion-model-rights.md), [training notes](../research_notes/Motion%20readiness%20and%20rights/commercial-rights.md), and the local `.local/owned-humanoid/roundtrip-proof.json` and `model/model.json` receipts. No permission request was sent to obtain this independent CC0 model path.
