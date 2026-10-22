# Native AutoPhysics: actual solver, baked motion, and original-rig retargeting

> Historical development notes. Local verification artifacts are not distributed. See the current README and docs for supported behavior.

## Is a real native physical result now available?

### Takeaway

Yes. The installed Cascadeur 2026.2.3 physical solver runs through its public scripting bridge and its result is explicitly baked onto every frame. `backend/cascadeur_physics.py` implements `correct_motion(request, progress)`. This provider is numerical AutoPhysics, not a newly trained model or a substitute label for interpolation.

### Cited findings

- The official 2026.2 release notes explain that Snap to Physics now asks whether to apply to every frame or only keyframes. They also document PySide UI extensions and the scripting/MCP additions. The missing final scope choice explains the earlier zero-change result. [Cascadeur 2026.2 release notes](https://cascadeur.com/help/category/319).
- Public actions are `AutoPhysicsTool.Switch Auto Physics` and `AutoPhysicsTool.Snap to Auto Physics`. The installed public `AutoPhysicTool` class itself only exposes turn-off operations. [Public action list](https://cascadeur.com/help/category/301), installed API stubs (local development artifact; not distributed).
- Qt documents `QMetaObject.invokeMethod` as a public way to invoke a signal or slot and report whether invocation succeeded. The adapter uses it on the freshly created, job-owned `All Frames` button. It checks the exact dialog title, question, two expected options, button enabled/visible state, and active owned scene first. It never chooses an existing unrelated prompt. [Qt Python meta-object API](https://doc.qt.io/qtforpython-6/PySide6/QtCore/QMetaObject.html), [runtime implementation](../../backend/cascadeur_runtime.py).
- Independent native log evidence confirms physical-corrector completion, solver termination statuses, completion of the AutoPhysics core, and the subsequent native Snap command. Actual joint transforms are read after the bake on a later idle event. These checks prevent treating a successful HTTP response or an open dialog as completed physics. [Provider implementation](../../backend/cascadeur_physics.py).
- Initial 4-second demo proof: 121/121 native frames changed after baking, maximum joint displacement 4.548 cm, mean displacement 0.854 cm, and maximum angular correction 0.1013 radians. Earlier Snap-without-choice produced zero displacement. [First successful bake verification](../../.local/autophysics-proof/initial-bake-verification.json).

### Inferences

This closes the native calculation-and-bake integration gap on this installed version. It remains an installed-application dependency, and the explicit UI-choice adapter is version-sensitive even though it uses public Qt APIs. It is not a portable vendor inference SDK.

### Gaps

A language/localization or native UI change can invalidate the guarded exact labels; the adapter fails with a clear error instead of selecting an unknown option. No application, license state, vendor package, model weight, or binary was copied or changed.

## Does native physics preserve the user's character and motion timing?

### Takeaway

The source character stays in Still. All source frames drive a temporary native humanoid proxy. Only physical correction deltas return; original child-bone offsets, hierarchy, mesh, skin bindings, and source timestamps remain intact.

### Cited findings

- Both learned inbetweening and AutoPosing are explicitly disabled through the public tools before transferring the full source animation. Physics therefore does not require a learned-model pass on a supplied animation. [Native physics preparation](../../backend/cascadeur_runtime.py).
- The native proxy uses its installed 30fps sample and Earth gravity: `gravity_per_frame * 30² / 100` measures 9.79999995 m/s². Source frame times are resampled for native computation, then the corrections return at every original timestamp. The provider accepts Earth gravity and enabled floor contact, reports the measured value, and blends correction strength as requested. [Adapter](../../backend/cascadeur_physics.py).
- The demo returned 121 frames / 21 original joints. The supplied Reaction returned 56 frames / 38 joints. The static humanoid Bear returned 121 frames / 33 joints, with only 0.017 mm maximum native joint motion: essentially numerical noise on a static pose, not a claimed useful animation change. All checks verified unchanged child-bone offsets. [Demo](../../.local/autophysics-proof/demo-verification.json), [Reaction initial transfer](../../.local/autophysics-proof/reaction-verification.json), [Bear](../../.local/autophysics-proof/bear-verification.json).
- A CC0 Quaternius `Walk_Loop` repeated fourteen times produced an 18.667-second, 561-frame, 65-joint request. The native solver converged and baked all frames in approximately 91 seconds. The returned count, bone offsets, and original times matched the input. The full input/output and measurements are local proof artifacts. [Long CC0 proof](../../.local/autophysics-proof/cc0-walk-long-verification.json), [source provenance and hashes](../../.local/owned-humanoid/sources.json), [rights assessment](../../docs/motion-model-rights.md).

### Inferences

Preserving skeleton structure removes the imported-skin corruption caused by rebuilding the user's rig inside another application. It does not, by itself, preserve accurate contacts after retargeting between different proportions and rest poses.

### Gaps

The current provider accepts named humanoids up to 20 seconds. Native proxy masses and collision geometry approximate the user's character. It is not an arbitrary-creature solver and does not infer exact mesh mass distribution or sole geometry. Off-grid source durations are sampled to the nearest native 30fps span; final source timestamps are restored and native duration is reported.

## How are retargeted contacts and result quality handled?

### Takeaway

Actual native computation does not establish acceptable motion quality. Results expose numerical quality flags and must be reviewed when large corrections or contact errors remain.

### Cited findings

- The initial rotation-only Reaction transfer increased foot-joint penetration from 7.15 cm to 7.82 cm and moved the root up to 40.4 cm at strength 0.7. The initial long CC0 walk transfer increased penetration from zero to 16.9 cm. Those results proved native execution but did not establish good retargeted contact. [Reaction initial metrics](../../.local/autophysics-proof/reaction-verification.json), [CC0 initial metrics](../../.local/autophysics-proof/cc0-walk-long-verification.json).
- The adapter now also transfers the native solved foot-position deltas, then solves two-segment source legs with their original lengths and retains corrected ankle world orientations. Targets respect source foot/toe joint floor clearance. A focused math check reached a target within 1.1e-16 m while preserving every bone offset and the ankle world orientation. [Retarget implementation](../../backend/cascadeur_physics.py), [math proof](../../.local/autophysics-proof/retarget-math-verification.json).
- **Final contact-transfer measurements:** the Reaction rerun reduced foot-joint penetration from 7.15 cm to numerical zero. The long CC0 walk rerun reduced the initial transfer's 16.9 cm penetration to zero, with the original 1.818 cm minimum joint height retained. The demo's final retarget, applied to its previously verified native bake, also retains zero penetration. All original frame times and child offsets remain unchanged. [Reaction final proof](../../.local/autophysics-proof/reaction-refined-verification.json), [CC0 final proof](../../.local/autophysics-proof/cc0-walk-long-refined-verification.json), [demo final retarget proof](../../.local/autophysics-proof/demo-refined-verification.json).
- The refined Reaction still has maximum root displacement 40.4 cm, maximum joint angular change 3.13 radians, and unreachable foot-target error up to 10.8 cm. The refined long walk has maximum root displacement 90.1 cm, angular change 1.68 radians, and foot-target error up to 1.80 cm. Both correctly return `requiresReview=true`; the demo's maximum 0.071-radian correction and negligible target error trigger no current thresholds. Native changes smaller than 0.1 mm are excluded from `nativeChangedFrames` to avoid treating static solver noise as meaningful motion. [Reaction final metrics](../../.local/autophysics-proof/reaction-refined-verification.json), [CC0 final metrics](../../.local/autophysics-proof/cc0-walk-long-refined-verification.json), [demo final metrics](../../.local/autophysics-proof/demo-refined-verification.json).
- `metrics.quality.requiresReview` and reasons flag penetration above 6 mm, worsening above 2 mm, root displacement above 2 cm, angular changes above 20 degrees, unreachable contact targets, and incomplete native convergence. Reasons are also returned as visible warnings. Foot metrics explicitly refer to joints rather than mesh surfaces. [Quality policy in provider](../../backend/cascadeur_physics.py).

### Inferences

Native foot-position constraints are necessary when preserving the original rig's segment lengths: applying native rotation changes alone does not guarantee matching foot locations. Anatomical limits and mesh contact remain separate validation concerns.

### Gaps

The leg refinement closes the observed joint-floor penetration regression, but does not make every native target reachable or preserve the original artistic intent under large physical corrections. The adapter does not certify collision-free mesh contact or anatomical feasibility; flagged results remain reviewable rather than being presented as validated animation. These proof inputs cover a procedural demo, the supplied Reaction and static humanoid Bear, and CC0 Quaternius walking; they are not broad motion-quality certification. No new learned-model evaluation used Mixamo assets in this phase.

## Can cancellation restore the native application safely?

### Takeaway

Yes. Cleanup includes the exact pending bake dialog as well as the owned temporary scene, restores the earlier selected scene, and is idempotent.

### Cited findings

- A proof paused after creating the native All Frames prompt with one owned proxy. Cleanup removed that prompt and proxy, restored the pre-existing blank scene and selection, left `ownedJobs=[]`, and a second cleanup closed zero scenes. [Pending-dialog cancellation verification](../../.local/autophysics-proof/cancellation-verification.json).
- The server must terminate its worker and then invoke `python -m backend.cascadeur --cleanup`, waiting for native cleanup before allowing another native operation. The same ownership table serves learned interpolation and AutoPhysics. [Runtime cleanup](../../backend/cascadeur_runtime.py), [cleanup entry point](../../backend/cascadeur.py).

### Inferences

Killing the outer Python worker alone is insufficient because native scene objects live in the application process. Keeping the module's ownership table alive and retaining it until successful cleanup permits recovery without closing unrelated scenes.

### Gaps

The licensed application and its local scripting bridge must remain running. Bridge loss can prevent immediate cleanup; the service must not claim a successful cancellation cleanup or start another native job until recovery succeeds.
