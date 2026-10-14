# Character files

Still accepts FBX, GLB, and self-contained glTF files up to 150 MB. Files are parsed locally in the browser.

For Mixamo, download **FBX Binary → With Skin**. Import it directly: an existing skeleton never needs to be re-rigged. Animation-only FBX files load as editable skeletons, with a message explaining why no character surface appears. Multiple source clips remain available on the imported asset.

GLB is the portable export format. It includes the character, its original skin bindings, and the edited animation. Standalone `.gltf` files work only when buffers and images are embedded as data URIs. External resources cannot be resolved from a single uploaded file. FBX files that reference separate texture files receive a visible warning; embedding textures or converting to GLB preserves their appearance. Draco-compressed meshes currently need to be decompressed before import.

## What stays intact

Import retains the source bone hierarchy, local transforms, skin indices, skin weights, and inverse bind matrices. Display size and centering are applied by a separate parent group, placing the character on the floor at approximately 2.4 scene units tall. Original rig data is not rebuilt to fit the editor.

Exported GLB nodes include a small joint marker in standard glTF extras. This allows Still to restore unweighted endpoint joints and the rigid demo mannequin as editable joints, since glTF normally recognizes only joints referenced by a skin. The marker does not require an extension or special renderer.

## Starter rigs

An unrigged mesh can receive a humanoid or quadruped template and four normalized weights per vertex based on distance to bone segments. Humanoid fitting includes five fingers per hand by default: three bend joints and an endpoint for each digit. A placement preview lets you inspect both hands, drag individual landmarks, or enter their coordinates before binding. Neighboring finger branches receive separate weight families and finer distance falloff. Exposed fingertip components are found from the mesh samples; missing or ambiguous digits remain flagged estimates. Use open hands with separated fingers, and check every estimated joint. Gloves and fused fingers cannot gain separate mesh geometry from rigging alone. Body-only fitting remains available. Finger joints can be shown in the editor; Rotate edits them individually, and fingertip IK stops at the palm instead of moving the arm. Saved projects and original-skeleton exports preserve all finger joints.

This is a geometric starting point, not trained AI auto-rigging. Humanoids should be upright and in an A-pose or T-pose; quadrupeds should be standing, Y-up, and facing +Z. Unusual proportions, clothing, closed poses, tails, and intersecting limbs can need better fitting or hand-authored weights. Existing rigs bypass this operation entirely; the practice humanoid keeps its original body-only skeleton so older saved scenes remain compatible.

## Apply a separate Mixamo animation

1. Use **Import a character** to load your rigged character. Download its initial Mixamo FBX with **With Skin** if you need the mesh too.
2. In Mixamo, choose the animation for the same character and download an FBX. **Without Skin** includes the animated skeleton; **With Skin** also works.
3. Choose **Import animation** under **Your character**, then select that animation file. Select its clip if it has several.
4. Choose **Apply to character** to replace the current motion, or **Append after current motion** to add it to the end. Set the transition duration for an append; zero makes a cut.

The existing character and skin are retained; only editable motion keys change. One Undo restores the previous take. Saved scenes, GLB and Unreal exports use the imported or combined motion. Review contacts after blending.

This is compatible-skeleton animation transfer, not automatic retargeting. Matching joints may have different Mixamo namespaces or file order, but the animated joints, ancestry, bind transforms and fixed parent coordinate frames must agree. Missing or ambiguous joints and incompatible rigs are rejected without changing the scene. For a differently rigged character, retarget the animation to its skeleton before importing. **Import a character** and a file dropped onto the workspace open a new scene; they do not apply motion to the current character.

## Verified paths

- Humanoid and quadruped demo construction, joint edits, and project round trips.
- Automatic weights preserve the original mesh at bind pose and deform its vertices when joints move.
- GLB export and reimport preserve skin data, editable endpoint joints, and animation channels.
- Three.js's Mixamo Samba Dancing FBX: 119 joints, two source clips; import, extract six poses from an 18.2-second clip, interpolate, export GLB, reimport, and resample the result.

The test fixture came from the [Three.js example assets](https://github.com/mrdoob/three.js/tree/dev/examples/models/fbx). Loader and exporter behavior follows the official [FBXLoader](https://threejs.org/docs/pages/FBXLoader.html), [SkinnedMesh](https://threejs.org/docs/pages/SkinnedMesh.html), and [GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html) documentation.
