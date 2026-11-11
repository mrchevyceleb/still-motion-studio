# Native Cascadeur learned motion integration

> Historical development notes. Local verification artifacts are not distributed. See the current README and docs for supported behavior.

## Can the installed learned engine actually produce motion through a public API?

### Takeaway

Yes. A working adapter now runs the installed Cascadeur learned inbetweening engine and returns animation to Still's original character. It does not extract, redistribute, or imitate the vendor's trained model.

### Cited Findings

- Cascadeur 2026.2 officially adds a simple MCP server, Python stubs, and updates its trained inbetweening model. The local installation is 2026.2.3.0.16863. — [Official release notes](https://cascadeur.com/help/category/319); [local integration notes](../../docs/cascadeur-integration.md).
- The installed scripting server exposes loopback `GET /health` and queued `POST /run`; scripts run on the application's idle event. — Installed server README (local development artifact; not distributed).
- The public layer enum exposes `Interpolation.AI`. Scene modifications, data editing, and scene creation are public APIs. — [Interpolation enum](https://cascadeur.com/python-api/_generate/csc.layers.layer.Interpolation.html); [SceneManager](https://cascadeur.com/python-api/_generate/csc.app.SceneManager.html); [Python API introduction](https://cascadeur.com/help/category/215).
- Proof on an isolated copy of the shipped Backflip animation: six keys at frames 0, 22, 46, 69, 95, 123; 58 joints and 124 frames. Switching the same sparse timeline from Bezier to AI changed interior joint positions by a mean 88.385 cm and maximum 394.545 cm. Authored positions changed by at most 0.000063 cm. A real 1,665,216-byte FBX was exported. These measurements prove native computation occurred, not that the generated motion is always desirable. — [Proof script](../../.local/cascadeur-proof/native-ai-verify.py); [Bezier samples](../../.local/cascadeur-proof/native-bezier-positions.json); [AI samples](../../.local/cascadeur-proof/native-ai-positions.json); [FBX output](../../.local/cascadeur-proof/native-ai-result.fbx).
- Complete editor-format requests succeeded for a 21-bone demo and the real 119-bone Mixamo fixture. Both returned finite normalized rotations, identical timestamps, exact authored poses, and zero changes to non-root bone offsets. — [Machine-readable verification](../../.local/cascadeur-proof/verification.json); [adapter](../../backend/cascadeur.py); [native runtime](../../backend/cascadeur_runtime.py).

### Inferences

- A local installed-engine provider closes the learned interpolation gap on this computer without shipping proprietary model files. Its output still needs artistic review; generating motion and generating the intended motion are different acceptance criteria.
- The public scripting adapter is a practical dependency boundary. Keeping the vendor installation external is substantially safer for maintenance than reproducing its internals.

### Gaps

- No portable standalone Cascadeur inference SDK was found. The application and its enabled scripting server must be available.
- No distribution-license interpretation is offered. This implementation uses the local installed application; it does not package the application or its model assets.

## How can the editor avoid breaking an imported Mixamo rig?

### Takeaway

Use an already rigged native character only as an inference proxy, then retarget the generated rotations to the source skeleton. The source mesh, skin bindings, hierarchy, and local bone offsets stay in Still.

### Cited Findings

- The adapter creates a temporary scene from the installed `samples/Cascy.casc`. It writes source pose deltas to the proxy through `DataEditor` and `SceneUpdater`, applies AI interpolation, reads the resulting bone transforms, and removes its temporary scene. It restores the previously active scene. — [Native adapter runtime](../../backend/cascadeur_runtime.py).
- Proxy rotation deltas are computed relative to each skeleton's rest pose. Interpolated calibration removes small adjustments introduced by native rig constraints at authored keys; the exact original source keys are returned. Unmapped source local rotations are retained. — [Retargeting implementation](../../backend/cascadeur.py).
- The actual FBX contains repeated same-named transform/bone nodes. The adapter resolves these only when they form a coincident ancestor chain, choosing the distal joint. Unrelated ambiguous names are rejected. — [Mixamo request](../../.local/ai-motion/request-mixamo.json); [mapping implementation](../../backend/cascadeur.py).
- Final demo proof: 4 seconds, 6 anchors, 121 returned frames, 21 source joints; mean interior world-rotation change 0.1243 radians; maximum native proxy adjustment 3.325 cm. Final Mixamo proof: 18.2 seconds, 6 anchors, 547 returned frames, 119 source joints; mean interior rotation change 0.1639 radians; maximum proxy adjustment 1.469 cm. Both preserve all six source anchors exactly. — [Verification report](../../.local/cascadeur-proof/verification.json).
- Cascadeur documents humanoid-only inbetweening and a maximum 120 native frames between neighboring keys. The adapter limits jobs to 20 seconds; it infers longer individual gaps within 120 frames and retimes them back to the original authored interval, with a warning. — [Official inbetweening documentation](https://cascadeur.com/help/category/278); [adapter limits and time mapping](../../backend/cascadeur.py).

### Inferences

- The proxy path removes native quick-rig generation from this integration's critical path. It also prevents native rig construction from changing a user's imported skin.
- Very unusual proportions, creature anatomy, or character-specific joint constraints can still require manual refinement. This provider is deliberately presented as humanoid motion inference, not universal automatic rigging.

### Gaps

- Quadruped learned inbetweening is not supported by this native model. Ordinary editing and a separate dynamics provider remain useful but do not constitute a quadruped trained model.
- Earlier direct native quick-rig attempts crashed at the vendor's `AnimationInfo` validation. Read-only inspection shows the condition is `len(...) != 1`, so its “several” error also covers zero; duplicate animation takes were never established as the cause. That path was abandoned after the proxy route succeeded. — [Earlier native proof notes](../../docs/cascadeur-integration.md).

## Can native AutoPhysics be reliably baked without exposing Cascadeur's interface?

**Superseded by the later successful implementation:** the all-frame bake and
owned-dialog cleanup now work through public Qt APIs. See [native AutoPhysics
research and verification](../Motion%20readiness%20and%20rights/native-autophysics.md).
The observations below retain the earlier incomplete Snap-only proof as history.

### Takeaway

Native AutoPhysics calculation was verified, but its final bake is not integrated. The public Snap action now opens an all-frames/keyframes prompt; calling it alone produced no changes to the source joints in the hidden application.

### Cited Findings

- Public action IDs include `AutoPhysicsTool.Switch Auto Physics` and `AutoPhysicsTool.Snap to Auto Physics`. The documented Python tool exposes `turn_off` and `turn_off_all_fulcrum_points`, without a bake method accepting the prompt choice. — [Public action list](https://cascadeur.com/help/category/301); installed tool stubs (local development artifact; not distributed).
- The 2026.2 release notes explicitly describe the new Snap choice between all frames and keyframes. — [Release notes, physics snapping changes](https://cascadeur.com/help/category/319).
- In the isolated native sample, enabling physics completed trajectory smoothing, separation, physics correction, compensation, rotation smoothing, secondary motion, unbound restoration, and collision correction. The native log reported solver convergence. Running the Snap action then comparing all 58 joints at 124 frames produced zero source-position change. — [Enable script](../../.local/cascadeur-proof/native-physics-enable.py); [Snap script](../../.local/cascadeur-proof/native-physics-snap.py); [verification script](../../.local/cascadeur-proof/native-physics-verify.py); [post-Snap samples](../../.local/cascadeur-proof/native-physics-positions.json).
- The shipped provider invokes learned inbetweening only and does not claim native AutoPhysics output. — [Provider implementation](../../backend/cascadeur.py).

### Inferences

- A separate numerical dynamics provider is presently a more dependable unattended physics path than trying to drive a hidden native confirmation dialog.
- Native AutoPhysics may become suitable once the vendor exposes a supported bake operation or dialog-free workflow. The existing public action alone is insufficient evidence of applied physics.

### Gaps

- No documented way to choose the native Snap scope programmatically was found in the shipped Python API or public action list. No private calls, UI preference changes, licensing changes, or binary modifications were attempted to bypass it.
- Cancellation kills the outer Python worker, so the server must subsequently invoke `python -m backend.cascadeur --cleanup` and await it before starting another native job. Cleanup targets only temporary scenes owned by this adapter. — [Cleanup contract](../../backend/cascadeur.py); [native cleanup implementation](../../backend/cascadeur_runtime.py).
