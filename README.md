# Still — motion made simple

A local, browser-based character animation editor. Import a rigged Mixamo character, drag its joints, save a few poses, and preview the motion between them.

## Run

Requires Node.js 22.12+ (Node 24 recommended).

```sh
npm install
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173). The server binds to your own computer. Character import is parsed in the browser; motion assistance and Unreal conversion use the local service. No account or external character upload is required. The UI downloads its fonts from Google Fonts, with local font fallbacks.

## The workflow

1. Try the built-in human or quadruped, or import **FBX / GLB**. For Mixamo, choose **FBX Binary → With Skin**.
2. Imported skeletons, bind matrices, and skin weights are retained. Animation tracks are sampled at 30 fps, including the exact endpoint. Supported channels are bone translation, rotation, and scale.
3. For dense motion capture, choose **Simplify to 6 poses** before making broad pose changes. This is lossy and undoable; save a project first to keep a separate original.
4. Select a time and drag a joint. Inverse kinematics moves the limb without changing bone lengths. Edits create/update a pose automatically. **W** moves, **E** rotates, and the joint panel provides numeric rotation.
5. Choose **Generate motion** for learned in-betweening. **Still Quadruped** is trained from scratch on CC0 animal motion. Human choices include CondMDI, installed **Cascadeur AI**, and the new **Still humanoid (experimental)** model. Dense imports can go straight through **Find 6 poses & generate**. Your six poses stay exact. For imported animals, **Moves like** selects two or four legs without replacing the skeleton.
6. Choose **Correct with physics** and select **MuJoCo dynamics** or installed **Cascadeur AutoPhysics**. Enable **Keep feet planted** for the full-rate contact pass in MuJoCo. Native AutoPhysics uses Earth gravity and floor contacts. Corrections may adjust authored poses; unresolved constraints are marked for review. Undo restores the preceding motion.

Generated frames live separately from the editable pose timeline and are included in playback, saves, and exports. Editing a key clears the old generated take; click Generate motion again. The **Curve interpolation** section still offers Smooth, Direct, and Hold without running a model. **Space** previews, **K** saves a pose, and dragging timeline diamonds changes timing.
7. Choose **Export → Unreal Engine · FBX** for a ZIP containing a skeletal character, baked animation, textures, and import guide. Animated **GLB** and editable **.still** downloads are also available. **Ctrl/Cmd+S** saves a project file.

Changes automatically persist in IndexedDB for this browser and origin. Replacing a scene through import or New keeps a copy in **New scene → Recent scenes** (the last five replacements). Save a `.still` file for permanent storage or before clearing browser data. Undo/redo covers motion and settings within the current scene; importing or starting a new character resets that scene's undo history.

## Work with an AI agent

Click **Agent** to see this tab's connection and copy instructions for an assistant. Still provides **35 discoverable scripting commands**, a dependency-free Node SDK/CLI, and an MCP stdio server. An agent can inspect the rig, manipulate joints, author a complete pose sequence, run installed AI/physics tools, control the viewport, and save or export results without clicking through the UI.

```sh
node scripts/still-agent.mjs sessions
node scripts/still-agent.mjs schema
```

Give the agent [the scripting guide](docs/agent-scripting.md). It includes an executable six-pose example and MCP configuration. Keep the browser tab open; it can stay in the background. Access is authenticated and restricted to this computer. Commands target a specific tab, support revision checks and cancellation, and never replay uncertain mutations automatically. Exports refuse to overwrite files unless explicitly requested.

## What this version does—and its limits

- A working editor with two example characters, skeleton-preserving FBX/GLB input, direct posing, timeline editing, onion skin, camera presets, undo/redo, local recovery, animated GLB output, and local Unreal FBX packages.
- **Learned animal motion:** the fresh 856k-parameter Still Quadruped network supports the starter animal skeleton and recognized Quaternius joint names. Held-out Horse validation improves normalized position RMS by about 65% over interpolation; this is a dataset metric, not a guarantee for every animal. Source lengths and authored poses remain exact.
- **Human motion:** CondMDI (235M parameters) supports up to 60 seconds; native Cascadeur AI supports up to 20 seconds. Long native intervals are retimed with a warning. The independently trained CC0 humanoid model supports 12 seconds, but has not beaten interpolation on held-out clips and is explicitly experimental.
- **Dynamics and contacts:** MuJoCo evaluates gravity, inertia, joint torque, and frictional floor contacts. A full-rate contact pass holds detected stance centers and eases through nearby swing frames. Full-frame metrics reject major regressions and expose unresolved defects. Native Cascadeur AutoPhysics now runs its solver and applies **All Frames** through the installed application's public scripting/Qt interface, then retargets that baked result back to the source skeleton.
- Curve interpolation and **Quick ground pass** remain separate procedural options.
- Unrigged meshes can receive an approximate humanoid or quadruped template with distance-based skinning. Upright neutral T-pose humans and standing +Z-facing quadrupeds work best. It does not guarantee correct anatomical placement or production-quality weights on arbitrary models.
- Imported non-bone animation tracks (including morph animation) are rejected with a visible explanation rather than silently discarded. Embedded textures work best. External glTF resources and compressed geometry requiring extra decoders are not supported.
- **Unreal FBX export** uses a detected Blender installation, centimeters, +X forward, +Z up, and matching character/animation skeletons. Export scale matches Still's preview (normally about 240 cm tall), rather than recovering the source file's physical height. It preserves movement on the original skeleton; Unreal's **Enable Root Motion** stays off. Mannequin/MetaHuman retargeting, automatic locomotion-root extraction, and identical complex PBR materials are separate work. See [Unreal export and verified import settings](docs/unreal-export.md).
- Physics assumes one connected skeleton, a flat floor, recognizable feet, and inferred masses/foot shapes. Native physics supports humanoids through a proxy and can produce large corrections or residual foot penetration on different proportions. Full-body collision, exact anatomy, props, moving platforms, and guaranteed contact on arbitrary acrobatics remain open work. Review flags expose remaining force, torque, penetration, and pose-drift problems.

See [import details](docs/imports.md) and [motion details](docs/motion.md).

## Local engines

On this computer, the learned model, dynamics environment, and native adapter are installed. `npm run dev` starts the editor and loopback motion service together. No character is sent to an external service. Models and isolated Python environments live in ignored `.local/` storage.

For a fresh Windows setup, install [uv](https://docs.astral.sh/uv/) and Git, then run:

```powershell
./scripts/setup-ai-motion.ps1
./scripts/setup-physics.ps1
./scripts/setup-owned-quadruped.ps1
./scripts/setup-owned-humanoid.ps1
./scripts/setup-cascadeur.ps1
```

The local learned models need a CUDA-capable NVIDIA GPU. CondMDI setup converts the authors' averaged weights to SafeTensors and verifies tensor equality and SHA-256. Its commercial checkpoint/output permissions remain unresolved. The new Still networks start from random weights and use documented CC0 assets; their exact checkpoints and source provenance have a separate release check in `backend/model-rights.json`. See [commercial model evidence](reports/Motion%20readiness%20and%20rights.md). A rights check is not a motion-quality claim.

Cascadeur AI and AutoPhysics use your installed, licensed application through its public scripting server at `127.0.0.1:8765`; no vendor weights are extracted or redistributed. Both operate on an isolated proxy and preserve the imported skin/rig. See [native setup](docs/cascadeur-integration.md), [learned model setup](docs/neural-motion.md), and the [new research and validation report](reports/Motion%20readiness%20and%20rights.md).

## Verification

```sh
npm run build
npm test
npx playwright install chromium
node scripts/smoke.mjs
node scripts/smoke-engines.mjs
```

The browser smoke run needs the dev server running. It checks real joint dragging, playback, undo/redo, timeline edits, project round trips, local recovery, GLB export, and desktop layout. Outputs are kept in ignored `.local/` storage. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chromium install.

Verified with the Three.js [Mixamo Samba Dancing FBX fixture](https://github.com/mrdoob/three.js/tree/dev/examples/models/fbx): 119 bones and two source clips, full import → six poses → animated GLB → reimport.

## Implementation

React + TypeScript + Three.js, served with Vite. `server/engine.mjs` runs a loopback-only job service on port 5175, which starts isolated Python workers. `src/engine/assistance.ts` normalizes source transforms to meters and returns motion without replacing skeletons, mesh bindings, or skin weights. Backend modules implement CondMDI, MuJoCo, and the native Cascadeur adapter. Jobs have progress, cancellation, bounded execution, and saved diagnostic reports. The service retains 20 motion jobs and 10 Unreal export folders; stopping the launcher waits for worker and native scene cleanup. Unreal conversion runs Blender in the background with a clean startup scene and script auto-execution disabled. Blender is detected from a standard installation or `STILL_BLENDER_EXECUTABLE`.

Primary API references: [FBXLoader](https://threejs.org/docs/pages/FBXLoader.html), [GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html), and [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html).
