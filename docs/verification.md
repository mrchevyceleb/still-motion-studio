# Build verification — October 8, 2026

The app runs locally at http://127.0.0.1:5173. Launch later with `Start Still.cmd`, or `npm run dev`.

## Checks

| Check | Result |
| --- | --- |
| TypeScript + production Vite build | Passed |
| Focused motion tests | 5 passed |
| Core browser workflows | 9 passed |
| Imported FBX, starter rig, physics, export workflows | 4 passed |
| Browser runtime errors | None in the verified workflows |
| npm dependency audit | 0 vulnerabilities |

The browser checks exercise real joint dragging and saved pose changes; exact undo/redo; adding/deleting poses; animation playback; interpolation/camera/ghost/rig controls; project download/import; IndexedDB recovery; previous-scene recovery after New and import; animated GLB export/reimport; source clip identity through undo and saving; mobile joint/clip/warning controls; and retention of the original rest pose after exporting from a bent frame.

Desktop was checked at 1440×1000 and 1024×850; mobile controls at 390×844. Browser artifacts and downloaded round-trip files are in ignored `.local/smoke` and `.local/smoke-import`. The real Mixamo FBX fixture retained 119 bones. The generated starter rig was verified to deform its mesh, serialize skin weights, and survive GLB reimport.

The production build reports one large JavaScript bundle warning (roughly 1.09 MB uncompressed / 298 KB gzip); it completes successfully.

## Code review

**Backend:** automated review, medium effort for both passes. Read-only reviewers used the complete supplied diff; their local shell tool was unavailable, so browser/build verification was performed separately.

**Scope:** large tier. Review 1 covered 24 files / 3,786 changed lines. Verification covered 25 files / 3,995 changed lines, including the native integration findings. No pre-existing code was present; the base was Git's empty tree.

**Result:** 2 reviews, 1 fix pass, **limited** success exit under the review stopping rule. No P0/P1 remained in verification. Review 1 reported three P1 findings and one P2; all were fixed:

| Finding | Fix |
| --- | --- |
| P1: Import could replace the only recoverable scene | Transactional archives retain the last five replaced scenes; recovery UI is in New scene. |
| P1: GLB base pose depended on the playhead | Export temporarily applies the original rest pose and restores the displayed pose in `finally`. |
| P1: Mobile hid functional controls | Added a mobile disclosure for clips, warnings, joint selection, rotation, and reset. |
| P2: Source clip labels became false after undo/restore | Clip identity is stored with history/projects; edits explicitly become “Edited motion.” |

Verification reported two new P2 notes. Per the review process, these were recorded without another fix/review loop:

- The layout has a 360px minimum width, so narrower 320px views overflow.
- An error alert can remain visible after some subsequent successful operations until dismissed.

Reviewed files: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `public/favicon.svg`, `Start Still.cmd`, `README.md`, `docs/imports.md`, `docs/motion.md`, `docs/cascadeur-integration.md`, `src/main.tsx`, `src/types.ts`, `src/App.tsx`, `src/styles.css`, `src/engine/character.ts`, `src/engine/motion.ts`, `src/engine/motion.test.ts`, `src/engine/project.ts`, `src/components/Viewport.tsx`, `src/components/Viewport.css`, `src/components/PoseThumbnail.tsx`, `scripts/smoke.mjs`, and `scripts/smoke-import.mjs`.

## Follow-up: real motion engines

The earlier procedural-only scope limit is superseded. Genuine CondMDI inference, installed Cascadeur learned inference, and independent MuJoCo dynamics are now connected to the editor. Native FBX quick-rig is bypassed using an isolated inference proxy; original character skin and bone offsets remain in Still.

- Both learned providers completed the 4-second/6-pose mannequin and 18.2-second/119-bone Mixamo clip. Exact source anchors and original bone lengths were verified.
- CondMDI primary-author weights are tensor-identical to the author checkpoint. Its six-pose Mixamo run returned 547 frames in about 16 seconds on this RTX 4090. Seed and conditioning sensitivity were measured.
- Real browser runs passed generation, unchanged authored poses, separate baked playback frames, cancellation during a submitted job, undo/redo, save/reload, and pose edits invalidating old generated frames. Both learned providers were exercised.
- Real physics through the browser reduced the demo root-force residual from 686.7 N to approximately 4 N. Full Mixamo dynamics improved force/torque but retained contact defects and is explicitly marked for review.
- Production build, 7 focused numerical checks, and all 13 existing browser workflows pass. The large-bundle warning remains.

Proofs and browser screenshots are retained in ignored `.local/engine-verification`, `.local/ai-motion`, `.local/physics-proof`, and `.local/cascadeur-proof`. Full research, provenance, metrics, and remaining limitations are in [the report](../reports/Real%20motion%20engines.md).

The follow-up code review found three practical issues: asynchronous shutdown/worker cleanup, bounded diagnostic retention, and a missing root-torque regression gate. All three were fixed. Final medium verification confirmed all three resolved, with no P0/P1 findings. The native IPC shutdown was then verified against an actual running proxy scene: worker terminated, temporary scene closed, and exact previous scene state restored in 2.07 seconds.

Follow-up review: automated, medium effort; large tier, 2 reviews and 1 fix pass. Scope was the explicit 28-file contribution manifest against the snapshot before this follow-up (2,464 changed lines after fixes). No third pass was warranted. One new P2 note remains under the review stopping rule: a CRC-corrupt cached checkpoint ZIP, or an already-corrupt extracted checkpoint with the expected size, can require removing those cached downloads before rerunning setup. The verified installed checkpoint is unaffected. Interrupted downloads/extraction use temporary files and resume safely for ordinary incomplete files.

The final physics rerun still passed: root force 686.7336→4.3074 N and root torque 10.1914→1.4251 Nm, with `requiresReview=false`. Raw review findings are archived in `.local/verification/` (not in Git).


Follow-up scope: `.gitignore`, `package.json`, `vite.config.ts`, `README.md`, `src/types.ts`, `src/App.tsx`, `src/styles.css`, `src/engine/project.ts`, `src/engine/assistance.ts`, `src/engine/assistance.test.ts`, `server/engine.mjs`, `scripts/dev.mjs`, `scripts/motion-fixture.mjs`, `scripts/smoke-engines.mjs`, `scripts/smoke.mjs`, `scripts/smoke-import.mjs`, `backend/__init__.py`, `backend/worker.py`, `backend/inbetween.py`, `backend/install_model.py`, `backend/physics.py`, `backend/cascadeur.py`, `backend/cascadeur_runtime.py`, `scripts/setup-ai-motion.ps1`, `scripts/setup-physics.ps1`, `docs/motion.md`, `docs/neural-motion.md`, `docs/cascadeur-integration.md`.

## Motion gaps and supplied characters — October 8, 2026

- `Reaction.fbx`: 38 original joints, 56 sampled frames, 1.817 seconds. Import, numeric joint edit, undo, MuJoCo correction, GLB export and reimport passed. `Bear T-pose.fbx`: 33 original joints, no source clip, humanoid/biped skeleton. The same workflow passed with a 121-frame static pose. Export/reimport preserved rest transforms within 1e-9 and retained each file's original joint count.
- Reaction's detected support-foot sliding fell from 0.22855 to 0.00003595 m/s; proxy penetration fell from 122.38 to 4 mm. Large force/torque residuals remain and the result is flagged for review. The static bear's root-force residual fell from 686.7 to 0.823 N, with 0.612 mm proxy penetration and no review flag. These are inferred proxy measurements, not mesh-contact guarantees.
- The longer source dance was rechecked with the new contact pass: sliding 0.09173 to 0.00000496 m/s, root-force residual 2239.8 to 954.7 N, root-torque residual 1800.0 to 550.4 Nm. Ground penetration 3.42 to 4 mm. High residual force/torque remains explicitly flagged. This was a numerical physics test, not an ML benchmark.
- Real quadruped UI generation produced 121 frames with six exactly preserved keys and survived autosave/reload. The new humanoid provider passed generation, undo/redo, cancellation, reload and editing invalidation. It remains experimental because held-out interpolation accuracy did not improve. The same browser run's physics pass reduced the demo residual from 686.7 to 2.5 N.
- TypeScript compilation, all seven existing numerical checks and all nine general browser workflows passed. Screenshots at 1440 and compact desktop widths were inspected. No new permanent test suite was added.
- Two additional contact probes passed: a 0.7-second airborne segment keeps its interior foot motion unchanged, while a left-to-right stance transition transfers support without pinning the swing foot. Strength zero retains the exact original animation. Evidence: `.local/physics-proof/contact-edge-proof.json`.

Evidence: `.local/user-fixtures/`, `.local/contact-refinement/final-result.json`, `.local/engine-verification/`, `.local/quadruped/validation-proof.json`, `.local/quadruped/extended-proof.json`, `.local/owned-humanoid/model/model.json`, and `.local/autophysics-proof/`. See [the research report](../reports/Motion%20readiness%20and%20rights.md) for model provenance, native bake measurements, and permission limits. The supplied FBX files were not added to model training data.

### Code review for the motion gaps

Large tier: 40 explicitly transferred files, 2,668 changed lines at final review. Automated review produced three passes (medium, medium, then the allowed high-effort review for a new practical P1). Four P1 findings and one P2 were fixed: native setup registration; allowlisted/hash-verified training inputs; body-type history and stale-take invalidation; failed native cleanup/recovery reporting; and preserving per-provider physics preferences. Fresh setup, source tampering/unlisted-file checks, body-type Undo, native preference switching, and fault-injected cleanup/recovery all passed. The final real native browser run passed as well. Raw reviews and the scope manifest are in `.local/verification/` (not in Git).

The allowed third review ended with no P0, and these notes remain under the review stopping rule:

- P1: If the native bridge fails during server shutdown, recovery state is not persisted across restart and shutdown still exits zero. A later native attempt can require cleanup/retry. Ordinary running-service failures now surface a recovery action correctly.
- P1: Interrupting `-Retrain` between writing weights and metadata can leave an inconsistent local checkpoint set. Existing verified installations are unaffected; retraining does not yet atomically swap a complete model directory with rollback.
- P2: The research report intentionally uses links to local evidence files. They do not travel to other clones, and ignored `.local` proof files are not bundled.

This was a third-loop, success-with-notes exit; no fourth review was run. No commits or pushes were made.

## Unreal export — October 8, 2026

The later Unreal request is a separate change set, reviewed against the snapshot after the motion-gap work. **Export → Unreal Engine · FBX** now performs local GLB-to-FBX conversion and downloads a ZIP containing the character, animation, textures, manifest, and import guide/script. The original FBX files remain unchanged.

- Actual Unreal **5.8.2** imported Reaction's 38 bones and Bear's 33 bones with matching names/hierarchy, valid normalized skin weights, unit bone scale, +X facing, +Z up, and +Y right. Both match Still's 240 cm preview height. Reaction retains 1.816667 seconds at 60 fps; Bear's static corrected take retains four seconds at 30 fps.
- First, middle and last imported animation poses match the export reference. Maximum joint-position difference: Reaction **0.000203 cm**, Bear **0.00921 cm**. CPU skinning of Unreal's imported mesh and weights at these poses gives mesh-bound differences of **0.000115 cm** and **0.00152 cm** respectively. This is numerical validation at sampled poses, not a claim about every Unreal version or complex material appearance.
- Enabling root-motion extraction with first-frame root lock produced zero sampled root drift in both imports; the test restored the original settings. Packages preserve the original pelvis/root motion and leave **Enable Root Motion off** because a pelvis root is not a dedicated gameplay trajectory.
- Blender checks all source vertices at three poses before producing the package; supplied-character conversion errors were below **0.0004 cm**. The rigid-mesh demo, texture extraction, and external-resource rejection were also checked.
- A real browser run exported and downloaded the built-in animated demo with its playhead unchanged. Six additional browser checks covered warnings, cancellation during conversion and pending submission, converter failure, missing-converter fallback, and 390px layout. A generated Reaction project sent the current generated poses and chosen frame rate. The service passed both real supplied-character exports, malformed input, cross-origin rejection, concurrent-job rejection, and cancellation with no unfinished download.
- TypeScript compilation and all seven existing numerical tests passed. Frontend production build passed; the existing large-bundle warning remains. No new broad regression suite was added.

Evidence: `.local/unreal-proof/final-legacy-1.json`, `.local/unreal-export/`, and `.local/verification/unreal-service.json`. Ready-to-import packages are `.local/user-fixtures/reaction-Unreal.zip` and `.local/user-fixtures/bear-Unreal.zip`. See [the import workflow and limits](unreal-export.md).

The Unreal review fix pass also verified cancellation before upload acknowledgement (about 300 ms in the browser), immediate server cleanup on connection loss, client-allocated job IDs with a real ZIP download, and the disabled export option for unrigged imports. Archive validation rejected a truncated central directory, corrupt entry CRC, and missing required files. An actual Unreal fault injection failed after the character was saved: only its new `/Game/Still/Bear_1` folder was removed, the existing Bear remained, and the importer setting was restored. Evidence: `.local/verification/unreal-review-fixes.json`, `unreal-zip-integrity.json`, and `.local/unreal-proof/import-failure-proof.json`. The optional default-Interchange comparison stalled before reaching Python or importing assets; it supplies no compatibility evidence, and the packaged helper remains the verified route.

### Code review for Unreal export

Large tier: **12 files, 1,274 changed lines at verification**, scoped against the separate before-Unreal snapshot. **Two automated medium-effort reviews** ran, with one fix pass. The final reviewer returned **NO FINDINGS**; this is a verified exit with no remaining review findings for this change set. No commits or pushes were made.

Found and fixed: **one P1**, upload cancellation waiting for a server acknowledgement (`src/engine/unrealExport.ts`, `server/unreal-export.mjs`); **three P2s**, missing complete ZIP integrity validation (`backend/unreal_export.py`), offering export before rigging (`src/App.tsx`), and leaving saved partial Unreal imports after failure (`scripts/unreal_import.py`). The targeted checks above exercised each fix. No findings were deliberately skipped. Review outputs and the exact scope list are archived under `.local/verification/` (not in Git).

Reviewed files: `README.md`, `docs/verification.md`, `docs/unreal-export.md`, `src/App.tsx`, `src/engine/unrealExport.ts`, `src/unreal-export.css`, `server/engine.mjs`, `server/unreal-export.mjs`, `vite.config.ts`, `backend/unreal_export.py`, `scripts/unreal_import.py`, and `scripts/unreal_validate.py`.

## Background agent scripting — October 8, 2026

Still now exposes 35 discoverable scene commands through a loopback authenticated service, browser dispatcher, dependency-free Node SDK/CLI, and an eight-tool MCP stdio server. The **Agent** panel displays the current tab's session and copies setup instructions. The editor tab must remain open; it may stay in the background.

- The executable six-pose example ran against a real browser, authored distinct poses, used Undo/Redo, and exported `.still`, animated GLB, and an Unreal ZIP containing the required character, animation, manifest and import files. Actual MCP initialization, discovery and scene/skeleton inspection passed.
- Additional live commands covered world-space IK with unchanged joint offsets, key insertion/movement/deletion/reduction, exact Undo restoration, atomic rejection of an invalid pose batch, revision conflicts, duplicate command IDs, timing/FPS, settings, camera control, viewport PNG capture, playback, scene save/restore and recent-scene archives.
- The supplied `Reaction.fbx` imported with all 38 original joints, selected its clip, changed and undid its body category, and exported a GLB. Saved-project reimport and template rigging of an unrigged GLB also passed. This check found and fixed parsing of UTF-8 filenames in staged-file response headers.
- Real learned quadruped generation produced 121 frames. Cancelling the next generation preserved the previous revision. Clearing generated motion, quick ground assistance, a real 121-frame MuJoCo correction and the recovery command passed. These generation checks used starter characters, not the supplied Mixamo file as training or benchmark data.
- Isolated transport checks covered authentication/bootstrap restrictions, strict schemas, session ambiguity, idempotency/restart uncertainty, staged-file access, cancellation and acknowledgement/poll races. Browser checks covered StrictMode, acknowledgement retry without repeated execution, disconnect cleanup, and rejection of external file URLs. SDK checks included refusal to overwrite downloads. These were focused, ignored proof scripts rather than a new permanent test suite.
- Desktop and 390px Agent dialogs were inspected; live browser runs reported no page errors. TypeScript compilation and all seven existing numerical tests passed.

Evidence: `.local/agent-live-verify.json`, `.local/agent-operation-proof.json`, `.local/agent-api-proof-result.json`, `.local/agent-sdk-smoke.json`, `.local/agent-ui/`, and `.local/agent-operation-output/`. See [the scripting guide](agent-scripting.md) and [the executable example](../examples/agent-wave.mjs). The SDK never replays uncertain mutations automatically; scripts should inspect state after conflicts or connection loss. Scene replacement uses the existing five-scene archive and resets scene Undo history.

### Code review for agent scripting

Large tier: **15 files, 2,782 changed lines at verification**, against the separate before-agent snapshot. **Two automated medium-effort reviews** ran. This is a limited, success-with-notes exit under the review stopping rule; no third review was warranted. No commits or pushes were made.

- Fixed the first review's P2 concurrency concern by rejecting `skeleton.inspect` during UI generation/export while allowing immutable snapshot and pose reads. A real browser check held a generation request, verified that rejection, then verified inspection resumed afterward.
- Three unique P1 findings were disputed with code evidence: generated-motion invalidation, body-category synchronization, and disposal after asset replacement already occur in the existing App callbacks/effect. No duplicate implementations were added. Targeted live checks confirmed invalidation for eight named mutations, both scene and skeleton category inspection, and category Undo/Redo. App's asset effect disposes the previous root only when its ownership changes, preserving shared resources during template rigging.
- A separate live check exposed a long-poll timeout racing the journal write. The service now clears the idle timer before persisting a leased command. An isolated test deliberately delayed that write across the deadline, failed before the fix, and passed afterward. All nine transport checks passed again, and the running service was updated while idle.
- One new **P2 note remains**, as required by the review stopping rule: camera schema limits are wider than runtime limits. Runtime accepts FOV **10–100 degrees**, coordinates within **±10,000**, and the viewport's orbit-distance bounds. Requests outside those limits return explicit errors without changing the camera. The published schema still allows FOV up to 120 and generic vectors up to ±100,000.

No P0 findings were raised. Final TypeScript compilation passed. Review reports, exact scope, callback context, and focused checks are archived under `.local/verification/` (not in Git).

Reviewed files: `README.md`, `docs/verification.md`, `docs/agent-scripting.md`, `src/App.tsx`, `src/agent-scripting.css`, `src/engine/agentCommands.ts`, `src/engine/agentBridge.ts`, `src/engine/agentPose.ts`, `src/components/Viewport.tsx`, `server/engine.mjs`, `server/agent-api.mjs`, `shared/agent-schema.json`, `scripts/still-agent.mjs`, `scripts/still-mcp.mjs`, and `examples/agent-wave.mjs`.
