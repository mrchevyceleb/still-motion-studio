# Cascadeur integration

Verified October 8, 2026 with installed Cascadeur **2026.2.3.0.16863**.

**Working:** `backend/cascadeur.py` runs learned inbetweening and `backend/cascadeur_physics.py` runs the actual native AutoPhysics solver and all-frame bake. Both use the installed application's public scripting API through `backend/cascadeur_runtime.py`. Source meshes, skin bindings, skeleton hierarchy, and bone offsets stay in Still. No vendor code, binaries, or trained weights are distributed with the adapter.

## Runtime and data flow

1. The installed Cascadeur application runs its existing public scripting server at `http://127.0.0.1:8765`. Readiness is checked through `/health`; operations use `/run` on its native idle event.
2. The adapter creates a temporary application scene from the installed `samples/Cascy.casc`, an already rigged humanoid. It preserves the previously active scene.
3. Source poses are expressed relative to the source rest skeleton, transferred to the native proxy, and written through public `DataEditor` / `SceneUpdater` operations.
4. The adapter enables `Interpolation.AI` and the inbetweening update switch. A subsequent queued request reads the actual generated bone transforms after native inference.
5. Generated motion is retargeted onto the source skeleton. A smoothly interpolated calibration accounts for native rig constraints near authored keys. All original authored keys are restored exactly; non-root bone offsets and unmapped local rotations are preserved.
6. The temporary scene is removed and the previous active scene is restored.

The machine-specific manifest is `.local/cascadeur-proof/runtime.json`; it identifies the Python runtime, required installed files, provider metadata, and loopback bridge. The Python adapter uses NumPy and SciPy. The installation's existing MCP event hook starts the server when a scene opens; Still does not modify installed scripts or preferences.

If the outer worker is terminated, the service must run `python -m backend.cascadeur --cleanup` and await it before releasing the native job lock. This idempotent recovery removes only scenes owned by the adapter. A proof created one temporary scene, recovered it, repeated cleanup with zero further removals, and verified the previous scene count and selection were restored.

## Verified output

- Demo: 21 source bones, 6 anchors, 4 seconds, 121 output frames.
- Real Mixamo fixture: 119 source bones, 6 anchors, 18.2 seconds, 547 output frames. Coincident same-named FBX wrapper/bone pairs were resolved without rebuilding the original rig.
- Both: exact authored poses and timestamps, zero non-root bone-offset changes, finite normalized quaternions. The generated interior rotations differed from the ordinary interpolated input.
- Independent native control: the same six-pose Backflip sample produced different actual joint trajectories under Bezier versus AI; native authored positions were preserved within 0.000063 cm. Its generated FBX was exported successfully.

Detailed measurements and input hashes are in `.local/cascadeur-proof/verification.json`, with cancellation recovery in `cleanup-verification.json`. Full cited findings: [native Cascadeur research notes](../research_notes/Real%20motion%20engines/native-cascadeur.md).

## Limits

This provider accepts named humanoids and clips up to 20 seconds. Cascadeur's native model supports at most 120 frames between neighboring keys. Longer gaps are inferred within that limit and retimed to the original interval, with a warning. Exact authored timing is retained. Unusual proportions or motions may need manual refinement; the generated motion is not a guarantee of physical correctness.

## Native AutoPhysics

The earlier bake limitation is resolved. The physics provider disables learned inbetweening and AutoPosing, transfers dense source motion to the isolated Cascy proxy, waits for native solver completion, invokes Snap, and applies **All Frames** through the installed PySide6 public Qt interface. It checks the newly created prompt's identity and ownership before invoking its button. Solver logs, bake confirmation and changed output frames are recorded.

The manifest is `.local/cascadeur-physics/runtime.json`. The provider requires a named humanoid, clips up to 20 seconds, Earth gravity (the sample uses 9.8 m/s²), and floor contacts. Rotation/root corrections and native foot-position deltas are transferred at the selected strength. Two-segment leg IK preserves source offsets and ankle orientation, correcting measured joint-floor penetration after proxy retargeting. It cannot guarantee visible mesh contact or reachable targets for arbitrary proportions.

Run `./scripts/setup-cascadeur.ps1` to create an isolated Python environment and register both native providers. Use `-InstallPath 'C:/path/to/Cascadeur'` for a custom installation. This requires `uv` and the licensed application already installed; it does not install Cascadeur or modify its scripts. Keep its existing scripting bridge running. Required physics options apply only to the native request; switching back to MuJoCo restores your project preferences. Each saved generation report records the settings actually requested.

Actual native runs covered the 121-frame demo, 56-frame supplied Reaction, 121-frame static Bear, and 561-frame CC0 walk. Final Reaction and walking results have zero measured foot-joint penetration. Their large root/rotation corrections and unreachable target residuals remain flagged for review. Authored times and original child offsets/scales stay unchanged; physics may adjust authored poses. Pending-dialog cancellation removes only the owned prompt and scene and restores the previous scene; repeated cleanup is a no-op. See [native AutoPhysics measurements and references](../research_notes/Motion%20readiness%20and%20rights/native-autophysics.md).

## Earlier import experiments

Earlier experiments imported FBX into native scratch scenes and attempted native Mixamo quick-rig generation. Both attempts terminated Cascadeur at its `AnimationInfo` check. That check requires exactly one record, so the message about "several" also covers zero; multiple animation takes were not established as the cause. The successful proxy route avoids that operation entirely.

## Public references

- [2026.2 release notes: MCP, trained inbetweening updates, and physics Snap change](https://cascadeur.com/help/category/319)
- [Inbetweening requirements and limitations](https://cascadeur.com/help/category/278)
- [Public action IDs](https://cascadeur.com/help/category/301)
- [Scene manager API](https://cascadeur.com/python-api/_generate/csc.app.SceneManager.html)
- [Interpolation enum](https://cascadeur.com/python-api/_generate/csc.layers.layer.Interpolation.html)
- Installed API contract: `resources/scripts/stubs/csc/` and `resources/scripts/python/scripts/mcp/script_server/README.md` inside the user's Cascadeur installation.
