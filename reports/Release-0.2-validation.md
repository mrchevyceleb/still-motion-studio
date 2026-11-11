# Still 0.2 validation

Validated on this Windows computer, 2026-10-08. This record supersedes earlier partial-window model quality claims.

| Area | Implemented and checked | Limit |
| --- | --- | --- |
| Desktop | Electron; bundled CPU Python/models/physics/Blender/fonts; tray background commands | App must run; unsigned Windows x64 release |
| Models | CC0 animal curvature prior; every interior held-out frame predicted; exact observed poses | 108 learned parameters, 1.86% gain. Humanoid failed the unchanged 1% gate and is excluded; standalone humanoid AI remains open |
| Training | Immutable candidates; hash-bound corpus/code; atomic runtime pointer; failed candidates preserve active model | New datasets need provenance approval |
| Contacts | Stance/liftoff transitions; airborne protection; Reaction slide 0.224 m/s → <0.000001 m/s | 9.6 mm penetration and force/torque issues remain flagged; flat ground only |
| Rigging | Geometry landmarks, limb-aware weights, bind/bend checks; original Reaction/Bear preserved | Neutral upright pose; unusual anatomy needs inspection |
| Unreal | Planar root/in-place, automatic IK retarget and baked Manny animation; saved/reopened in UE 5.8 | MetaHuman body required and not executed here; vertical travel remains on pelvis |
| Native recovery | Durable journal; two failed service restarts retained cleanup obligation; clear checked | Native cleanup needs installed Cascadeur bridge |
| Camera | Schema/runtime coordinate, FOV, orbit limits aligned and discoverable | Distance 1.2–15 world units |

Actual Unreal all-frame root-motion source-pose preservation measured maximum 0.000076 cm error. Manny passed with Reaction and a turning/traveling fixture; both source and target animations remained valid after reopening. This is asset validation, not gameplay/CharacterMovement/network testing.

Local proofs: `.local/desktop-proof/proof.json`, `.local/native-journal-proof/proof.json`, `.local/verification/{training-activation-v3,motion-cpu-inference-v3,motion-contact-v2,rig-fit-proof}.json`, and `.local/readiness-unreal/{measure,reopen-proof,service-proof}.json`.

Distribution no longer depends on CondMDI: it is disabled by default and excluded from desktop builds. Its rights remain unresolved. Owned packaging verifies approved corpus and artifact hashes. Sources: [Quaternius humanoid animations](https://quaternius.com/packs/universalanimationlibrary.html), [Quaternius animals](https://quaternius.com/packs/ultimateanimatedanimals.html).

Architecture references: [Electron window behavior](https://www.electronjs.org/docs/latest/api/browser-window), [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process), [Epic IK retarget scripting](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-python-to-create-and-edit-ik-retargeter-assets-in-unreal-engine).

## Revised model evaluation

Protocol `all-interior-frames-overlap-two-key-phases-v3` covers all interior source frames; only the first and last boundary poses are excluded from prediction. Overlapping full-context windows avoid fully conditioned short tails, shifted key layouts hide each interior frame at least once, and frame errors are averaged across overlapping predictions. Coverage checks passed for 222 clip lengths (3–224), including the former six-frame tail case.

The animal model predicts 494 of 520 frames over 13 clips, improving RMS 1.86497%. The original humanoid candidate predicts 595 of 627 frames over 16 clips but improves only 0.94476%, below the unchanged 1% release gate. Calibration selected zero residual for both the original sampling and a six-pose retraining attempt. All three humanoid candidates were rejected; the prior runtime was preserved during each rejection, then backed up and disabled deliberately. No humanoid model is packaged. This is an unresolved quality gap, not a successful replacement for Cascadeur AI.

The packaging recovery check rejected the outdated model, preserved the previous bundle's catalog hash, and removed incomplete staging. Successful builds use a new directory, exact Python dependency synchronization, and only files listed in the approved model manifest; removed files cannot survive from a previous bundle.

## Final packaged verification

This is a **fresh-install preview**, not a completed production release. The Windows x64 NSIS installer is unsigned. Its size is 709,440,019 bytes and SHA-256 is `05B6006AFE16399FF3BF04FC714A1092E5B76A59088B2066946D5721D436BE42`. The packaged executable was tested; the installer wizard itself was not installed over an existing user's workspace.

The final hidden-window test passed with a PATH containing only Windows system folders: CPU animal inference, Reaction FBX import (38 original bones), physics correction, a 10,157,805-byte Unreal export, viewport PNG export, project save/restart, and stable port 17175. No page errors occurred. CondMDI and the failed humanoid provider were absent. The licensed native Cascadeur providers were available on this computer through its running bridge.

All 37 checked packaged source/build files matched the final source. Python, NumPy and Torch resolved inside the packaged runtime, and the relocated animal bundle passed its provenance/rights checks. The stale-file rebuild test passed. Build/type checking, all 7 existing tests, 222-length prediction coverage checks and interrupted/incomplete-bundle rejection checks passed. These checks ran on this Windows computer, not a second clean Windows machine.

Final proof files: `.local/packaged-v3-proof/proof.json`, `.local/verification/packaged-source.json`, `.local/verification/packaged-runtime-paths.json`, `.local/verification/packaged-model-rights.json`, `.local/verification/desktop-fresh-bundle.json`, `.local/verification/desktop-build-recovery.json`, `.local/verification/coverage-v3.json`, `.local/verification/bundle-rejection-v3.json`, and `.local/verification/installer.json`.

## Code review result

Scope: **55 files, 6,600 changed lines at the final review snapshot, large tier**. Three automated review passes ran: medium, medium, high. The reviewer inspected the supplied complete diff; its separate shell attempts failed with a local DPAPI error. Each review returned findings successfully. Exit: **third-loop, limit reached; no P0 findings; two new P1 issues remain**. This is not a clean-review claim.

| Finding | Result |
| --- | --- |
| P1 geometry sharing in `src/engine/character.ts` | Disputed: existing `cloneMaterials` copies each geometry and clones materials/textures before rig edits. Original assets remained intact in verification. |
| P2 Unreal target-path schema mismatch | Fixed: schema and UI use the same 512-character limit and service path pattern. |
| P1 stale files in desktop bundle | Fixed: fresh staging, exact dependency sync, model-manifest allowlist, copied-model validation, publish rollback. Recovery and stale-file checks passed. |
| P1 unmeasured short animation tails | Fixed: overlapping windows, shifted key layouts, explicit interior-frame prediction counts, strengthened promotion gates. Failed humanoid candidates were rejected and excluded. |
| P2 sparse-frame airborne warning threshold | Not fixed: dense active frames are compared with sparse input count; this can over-report airborne review warnings. New P2 on verify is a note under the workflow. |
| P1 stale runtime manifests after desktop upgrade | Open: existing data can retain an omitted/rejected humanoid provider or old bundled Python paths. App-managed runtime migration and bundle verification before advertising are needed. Fresh-install test data had no previous runtime. |
| P1 pending native cleanup after moving/reinstalling app | Open: recovery records contain absolute Python paths. If the old path disappears, cleanup remains blocked. Recovery must resolve the current packaged runtime. |

The review process stops after three reviews, so no further fix/review cycle ran. The two final P1 findings are recorded above rather than described as resolved. Raw review outputs remain in `.local/gap-review/review1.txt`, `review2.txt`, and `review3.txt`.

<details>
<summary>Reviewed file manifest</summary>

- `backend/cascadeur.py`
- `backend/cascadeur_physics.py`
- `backend/learned_motion.py`
- `backend/model-rights.json`
- `backend/model_rights.py`
- `backend/model_bundle.py`
- `backend/owned_humanoid.py`
- `backend/physics.py`
- `backend/quadruped.py`
- `backend/unreal_export.py`
- `training/model_installation.py`
- `training/train_motion_prior.py`
- `training/register_humanoid.py`
- `training/register_quadruped.py`
- `scripts/setup-owned-humanoid.ps1`
- `scripts/setup-owned-quadruped.ps1`
- `scripts/prepare-desktop.mjs`
- `scripts/still-agent.mjs`
- `scripts/unreal_import.py`
- `scripts/unreal_retarget.py`
- `server/agent-api.mjs`
- `server/engine.mjs`
- `server/native-recovery.mjs`
- `server/unreal-export.mjs`
- `shared/agent-schema.json`
- `src/App.tsx`
- `src/components/Viewport.tsx`
- `src/engine/agentCommands.ts`
- `src/engine/character.ts`
- `src/engine/anatomicalRig.ts`
- `src/engine/unrealExport.ts`
- `src/styles.css`
- `src/unreal-export.css`
- `desktop/main.cjs`
- `electron-builder.json`
- `package.json`
- `package-lock.json`
- `requirements-desktop.txt`
- `README.md`
- `docs/desktop.md`
- `docs/agent-scripting.md`
- `docs/unreal-export.md`
- `reports/Release-0.2-validation.md`
- `public/fonts/DM-Sans-OFL.txt`
- `public/fonts/fonts.css`
- `public/fonts/Manrope-OFL.txt`
- `public/fonts/still-font-0.woff2`
- `public/fonts/still-font-1.woff2`
- `public/fonts/still-font-2.woff2`
- `public/fonts/still-font-3.woff2`
- `public/fonts/still-font-4.woff2`
- `public/fonts/still-font-5.woff2`
- `public/fonts/still-font-6.woff2`
- `public/fonts/still-font-7.woff2`
- `public/fonts/still-font-8.woff2`

</details>

The existing browser development server was not restarted: that process-stop action was not permitted in the validation environment. The separately packaged desktop executable was verified instead.
