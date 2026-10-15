# Creature rigs and animation sources

Still accepts rigged characters from any source that exports FBX or self-contained glTF/GLB. Importing a rigged creature keeps its skeleton and skin. Choose **Moves like → Creature / other anatomy** for a legless or unusual character; human and quadruped generation engines are disabled for this category. Editing poses, interpolation, clip tools, project saving, GLB and original-skeleton export remain available.

## A legless, multi-headed boss

If the boss already has bones, keep them and pose each neck/head/jaw. The creature category does not replace the rig. If it is unrigged, import the mesh and choose **Creature → Multiple heads / hydra**. Choose the chain count and joints per chain, then **Place creature joints**. Position each neck chain, head, jaw hinge and jaw tip in the viewport or with XYZ fields. **Bind creature** assigns skin weights and checks the bind pose and a small bend. Serpent and tentacle presets are also available.

This is assisted geometric rigging, not a neural anatomy detector. It needs placement review, especially for bent necks and overlapping appendages. A screenshot cannot establish the actual bind pose or weight quality. Test each branch with Rotate; difficult mouths, disconnected ornaments and intersecting geometry can need Blender weight cleanup. Existing rigs are never silently replaced.

## Use another animation library

**Find characters, rigs & animations** is available in both import dialogs. These are links and file workflows, not connected accounts or an embedded asset marketplace:

| Source | Useful for | Workflow |
| --- | --- | --- |
| [Mesh2Motion](https://mesh2motion.org/) | Animal, bird and dragon templates, rig fitting, animations | Export rigged GLB and import it with its clips. Its [repository](https://github.com/Mesh2Motion/mesh2motion-app) identifies code as MIT and art assets as CC0. |
| [Quaternius](https://quaternius.com/) | Animated monster and animal packs; human animation libraries | Import a model and its matching clips. Check the selected pack's license. |
| [ActorCore](https://actorcore.reallusion.com/) | Human mocap | Download licensed FBX/BVH and use a matching rig or joint mapping. |
| [Fab](https://www.fab.com/) | Specific creatures, bosses and animation packs | Choose an asset offering FBX/GLB with animations. Unreal-only assets require conversion; rights vary by item. |
| [Mixamo](https://www.mixamo.com/) | Human characters and motions | FBX for the same character uses matching-rig transfer. |

Choose **Import animation**, then FBX, GLB, embedded glTF or BVH. BVH supplies skeleton motion, not a surface. Character files are limited to 150 MB, BVH to 20 MB and motion to ten minutes.

**Matching rig** preserves animated bone transforms and matching face shapes. Names, ancestry, rest transforms and fixed parent frames must agree; Mixamo namespace differences are tolerated. It works with creature rigs too.

**Retarget with joint mapping** suggests unambiguous name matches and lets you explicitly select or skip each source joint. Each target joint can receive one source. It transfers world-space rotation changes relative to each rest pose, retains target bone lengths, and optionally transfers root and hip travel scaled by the rigs' rest skeleton size. Unmapped target joints follow their parents. It requires positive uniform rig scale and models facing the same direction; animated scale and translations outside the root/hips require matching-rig transfer. Retarget mode copies matching face shapes and warns about skipped shapes missing from the target; matching-rig mode requires all source shapes. Both modes retain target mesh/skin, support apply/append, save/export and one-step Undo.

This retarget is a starting pose transfer, without automatic anatomical mapping, rest-pose alignment, IK contact correction or a motion preview inside the import dialog. Play the applied take and Undo if it needs remapping. A human walk cannot invent three independent neck actions. For this boss, use its own skeleton with authored attack/idle/recovery poses, or clips from a comparable creature.

## Neural auto-rigging

[UniRig](https://github.com/VAST-AI-Research/UniRig/blob/main/README.md) provides learned skeleton and skin prediction for diverse assets, with a Python/PyTorch/CUDA-oriented setup. Its rigged FBX output can be imported. It is not bundled, installed or executed by this change; a native adapter and validation on real creature meshes remain separate work. Model and dependency licensing must be assessed for any redistribution.

Meshy's [Rigging API documentation](https://docs.meshy.ai/en/api/rigging) currently limits programmatic rigging to standard humanoids and explicitly excludes non-humanoids. That API is not an appropriate automatic solution for this boss despite broader marketing language.
