# Still — motion made simple

A local character animation editor with an installable Windows Electron app and a browser development version. Import rigged FBX/GLB files, drag joints, edit a few poses, generate transitions, correct contacts, and export animation for Unreal.

Release 0.2.21 makes the lower editor compact so the 3D viewer has more room. Essential keyframe, selection, timeline zoom and playback controls stay visible; Clip & position opens detailed tools. It includes part fitting, range speed, pointer zoom and the previous editing improvements.

## Install or develop

Download **Still-Motion-Studio-Setup-0.2.21.exe** from the [latest private GitHub release](https://github.com/mrchevyceleb/still-motion-studio/releases/latest). It includes CPU-capable Python, the validated animal motion model, MuJoCo, Blender, and local fonts. No Node/Python setup or GPU is needed. Editing works offline. For automatic updates, open **Updates → Connect GitHub** once using an account with repository access. See [desktop setup](docs/desktop.md).

For development, use Node 22.12+ and run `npm install` then `npm run dev`. Open [localhost:5173](http://127.0.0.1:5173). Development uses service port 5175; desktop uses stable origin `http://127.0.0.1:17175` so projects survive restarts. Character processing stays on this computer.

## Creature rigs and other libraries

The working version adds creature-chain rig fitting (hydra heads/jaws, serpent and tentacles), a Creature body category, BVH import, and explicit joint mapping for rotation/root-motion retargeting. Both import dialogs link to Mesh2Motion, Quaternius, ActorCore, Fab and Mixamo. Existing rigs stay intact. This is assisted geometry fitting and basic retargeting, not a bundled neural auto-rigger or universal animation compatibility. See [creature workflow and limits](docs/creature-animation.md).

## Animate

1. Import a rigged Mixamo FBX with skin, or try a built-in character. Existing joints, bindings, and skin weights are preserved.
2. For unrigged neutral-pose characters, choose **Add a rig**. Humanoids include hands and five fingers per hand by default. **Detect body & finger joints** opens a hand preview: inspect both hands, drag joints or enter coordinates, then **Bind hands & body**. Each finger has three bend joints and a tip; skin weights keep neighboring digits separate. Open, separated fingers improve detection. Estimated fingertips are flagged for correction; gloves or fused geometry need manual placement. Turn off the finger option for body-only fitting. Existing imported rigs stay intact. Inspect a small limb and finger bend before animating.
3. Simplify a dense clip to six poses if desired. Drag joints or type rotations. **W/E** switches move/rotate; **Space** plays; **K** saves a pose. Enable **Ripple** or **Shift-drag** a timeline diamond to move it and all later poses together; the clip length adjusts and one undo restores the entire edit.
4. Generate animal motion with the owned learned prior, or human motion with installed licensed Cascadeur, then apply MuJoCo contact correction or installed licensed Cascadeur engines. Authored poses stay exact during learned generation; physics can adjust them. Editing a pose clears an outdated generated take.
5. Export an editable `.still`, animated GLB, or **Unreal FBX package**. Unreal options include export onto your existing Unreal character, face morph curves, planar gameplay root motion, in-place movement, saving into a folder, and automatic Manny/MetaHuman body retargeting. [Import and validation](docs/unreal-export.md).

Open **Characters** to manage the permanent library on this device. Each character holds its own scenes. Use the character name in the header or **All scenes for this character** to return to its collection. Each scene autosaves independently; recent backups remain available for recovery. Use timeline **Select** to drag across multiple keyframes and delete them together. Physics passes offer a saved **Before/After** preview and a measurements report. Export a `.still` file for a portable backup before clearing local app data.

Open timeline **Position & property tools** to correct several poses together. Move one pose in the viewport or enter its model position (meters; Enter or leave the field to apply), select keyframes, choose X/Y/Z, and apply **Same correction** to preserve their movement. **Copy current values → Exact value** pastes only the chosen position or joint rotation axes. The source pose is never shifted twice. Each bulk edit is one Undo; editing authored poses clears an old generated take. **Move entire animation** offsets all authored and generated frames together, preserving the take and clearing outdated physics measurements. These edits save and export with the scene.

Open **Clip tools** in the motion panel to trim a take, change its speed, reverse it, or lock planar hip travel in place while retaining height and turns. **Close loop seam** blends the ending pose into the next cycle; **Repeat motion** extends the take while accumulating its position and heading. **Append selected clip** or **Append saved .still take** blends another animation onto the current trajectory. Saved takes must use the same character and bind rig. Each operation is one Undo and persists with the scene; GLB and Unreal exports use the edited motion. Blends are baked to editable frames. Review contacts after blending and rerun physics after clip edits to refresh its measurements.

To put a separate Mixamo animation on a loaded character, choose **Import animation** under **Your character**. Download the motion for that same Mixamo character; animation-only FBX (**Without Skin**) and FBX with skin both work. Choose a clip if the file contains several, then **Apply to character** to replace its motion or **Append after current motion** for an attack → recovery sequence. Append offers a transition duration; zero makes a cut. The loaded character, rig, materials, and skin stay intact. Compatible bone names tolerate Mixamo namespace differences, but different skeletons, proportions, bind poses, or coordinate transforms require retargeting first. These edits have one Undo, save with the scene, and export normally. **Import a character** opens a new scene instead.

Keyboard shortcuts: **S** toggles Select mode; **Esc** or **V** returns to regular mode. **R** toggles Ripple, **M** opens the selected keyframe’s move controls, **Home/End** jumps to the clip boundaries, and **Ctrl A** selects every keyframe. **?** or **F1** opens the complete shortcut sheet. Typing in fields keeps normal text-editing behavior.

## Agent scripting

The desktop app keeps scripting alive when closed to its tray; no browser tab is required. **Quit Still** stops the service. The browser development version still needs its tab open. Use **Still → Agent tools** for the local SDK and MCP server. Development commands: `node scripts/still-agent.mjs sessions` and `node scripts/still-agent.mjs schema`.

There are 35 authenticated commands for inspection, posing, generation, history, camera control, imports, and exports. Explicit sessions, revision checks, cancellation, and persisted command identities prevent accidental replay. See [agent scripting](docs/agent-scripting.md).

## Quality and rights

The shipped quadruped prior is a small learned curvature model trained from scratch on documented Quaternius CC0 motion. It is **not a deep generative model or a Cascadeur equivalent**. The revised benchmark predicts every interior frame across 13 held-out clips (520 source frames, 494 predicted frames), using overlapping windows and two six-key layouts. Its normalized-position RMS improves **1.86%** over interpolation; authored poses remain exact.

**The standalone humanoid AI gap remains open.** The previous 1.30% claim did not measure every interior frame. On the corrected benchmark the original candidate achieved only 0.94%, below the unchanged 1% release gate. Calibration and six-pose retraining did not pass either. Those candidates were rejected and the old runtime was backed up and disabled; no humanoid checkpoint ships in this release. Human animation still supports curve editing, physics correction and the installed licensed Cascadeur adapter.

CondMDI's unresolved weight/output rights have not been cleared. Its checkpoint is excluded from desktop builds and disabled by default. Only deliberate development opt-in (`STILL_ALLOW_UNCLEARED_MODELS=1`) exposes that research provider. Build-time checks verify owned model hashes and CC0 provenance; new training activates only complete, validated immutable bundles.

Contacts use time-based stance/liftoff handling and preserve airborne motion. Reaction's measured sliding dropped from 0.224 m/s to below 0.000001 m/s, but about 9.6 mm maximum penetration and significant inferred-force residuals remain. **Difficult acrobatics, hand/prop contacts, moving platforms, and arbitrary anatomy still require review.** Geometry fitting is not learned anatomical understanding.

Manny retargeting and root-motion assets were executed and reopened in Unreal 5.8. MetaHuman uses the same automated body-retarget pipeline but requires a body asset in the destination project; no MetaHuman asset was available for equivalent execution validation. Materials, facial rigs, cloth, collisions, and gameplay/network behavior need project-specific setup.

Cascadeur integration uses its installed licensed app and public scripting bridge. No vendor weights or Epic character assets are redistributed. [Native setup](docs/cascadeur-integration.md).

## Reliability and verification

Model training writes immutable candidates, validates full held-out coverage and provenance, then atomically switches one runtime manifest. Interrupted/rejected training preserves the active model. Native operations journal cleanup before starting; failed cleanup survives service restarts and is retried. Camera schema and runtime limits agree.

Run `npm run build` and `npm test`. See [the 0.2 validation report](reports/Release-0.2-validation.md). Development proofs are ignored local files, not a sprawling permanent test suite.
