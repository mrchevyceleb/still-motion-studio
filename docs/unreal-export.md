# Unreal export

Still exports a ZIP containing a skeletal `character.fbx`, matching `animation.fbx`, textures when present, a manifest, and Unreal Python import/retarget helpers. Keep the source skeleton, or choose **Manny** or **MetaHuman** to have the import helper create IK Rigs, an aligned IK Retargeter, and a baked animation for the selected target body.

## Import into Unreal

1. Extract the whole ZIP, keeping its files together.
2. In Unreal, enable **Python Editor Script Plugin** and **Editor Scripting Utilities**, restarting the editor if requested.
3. Choose **Tools → Execute Python Script** and select the extracted `import_unreal.py`.
4. Open the imported animation under `/Game/Still/<character name>` and play it with its imported skeletal mesh.

The script creates a new destination when that name already exists. It imports the character first, assigns the resulting Skeleton to the animation, and uses the manifest's sample rate. It explicitly saves the generated Skeleton and dependencies so the imported animation remains usable after restarting Unreal. It does not create a Physics Asset. If import fails, it removes only that new partial destination; unsuccessful cleanup is reported in Unreal's Output Log. The script temporarily selects Unreal's legacy FBX importer and restores the previous importer setting, including on failure. This is the route validated below. Unreal 5.8's default Interchange import route has **not** been validated to the same standard; its options are different from the legacy `FbxImportUI` settings. Use the supplied script for the measured behavior rather than assuming default drag-and-drop imports reproduce these results.

The packaged `IMPORT.txt` also lists manual settings. Those settings refer to the legacy FBX dialog: scale 1, Convert Scene and Convert Scene Unit on, Force Front XAxis off, and neither T0-as-reference-pose nor reference-pose updates. Import `character.fbx` with a new Skeleton and no animation; import `animation.fbx` against that Skeleton with its manifest sample rate and full exported time range. Avoid assigning an unrelated existing Skeleton.

### Use a character already in Unreal

Choose **My existing Unreal character (animation only)** to export onto that character's own bone names and rest pose. Enter its **Skeleton asset**, for example `/Game/KarateBear/SKEL_KarateBear.SKEL_KarateBear`, and choose the same binary **Character FBX** that was originally imported into Unreal. Still defaults to the FBX imported in the current session. Original FBX bytes stay in memory and are not embedded in saved `.still` projects, so choose the FBX again after reopening a project. Fitting a replacement rig clears this default. The Skeleton path and character mode are remembered on this computer. This mode requires support for `retarget: "skeleton"` in the Blender exporter and Unreal import helper; the numerical measurements below cover the previously validated export modes.

Choose **My original skeleton** and paste its asset path into **Existing Unreal skeleton**, for example `/Game/Characters/Fluffy_Skeleton.Fluffy_Skeleton`. A matching SkeletalMesh path also works. The packaged helper imports only `animation.fbx` and assigns it to that existing Skeleton; it skips `character.fbx`. Leaving the field blank keeps the new-character import described above. For manual import, select that same existing Skeleton when importing `animation.fbx` as an animation.

Mixamo joint names are normalized for Unreal: both `mixamorig:Hips` and the `mixamorigHips` spelling produced by the FBX loader export as `Hips`. The same mapping is applied to the bones, skin weights, and animation tracks, and recorded in `boneAliases`. Other rig names are preserved where Unreal allows them. The helper checks target bone names and the root before importing; a SkeletalMesh target also permits a parent-hierarchy check. Unreal's importer validates the animation hierarchy. A different rig still needs retargeting. **Gameplay root motion** and **In place** add a root bone, so the existing target must have that same hierarchy; use **Original movement** for a normal Mixamo skeleton.

Epic documents [Python editor setup and execution](https://dev.epicgames.com/documentation/unreal-engine/scripting-the-unreal-editor-using-python) and the [skeletal FBX import pipeline](https://dev.epicgames.com/documentation/unreal-engine/fbx-skeletal-mesh-pipeline-in-unreal-engine?lang=en-US).

## What was measured in Unreal

The actual installed **Unreal Engine 5.8.2, build 56702186** imported the exported Reaction and Bear assets in an isolated headless project. Checks used Unreal's imported skeleton, animation data, mesh vertices, and skin weights. Reference positions and deformed bounds came from evaluation of the source GLB through the exporter, transformed into centimeters and Unreal coordinates.

| Check | Reaction | Bear |
| --- | ---: | ---: |
| Preserved bones and hierarchy | 38, exact | 33, exact |
| Weighted vertices checked | 163,194 | 163,194 |
| Imported height | 240.000012 cm | 240 cm |
| Sample rate / inclusive keys | 60 fps / 110 | 30 fps / 121 |
| Duration | 1.816666722 s | 4 s |
| Maximum rest-joint position error | 0.000189 cm | 0.000301 cm |
| Maximum sampled animated-joint error | 0.000203 cm | 0.009211 cm |
| Maximum deformed mesh-bounds error | 0.000116 cm | 0.001521 cm |

Both assets passed unit bone-scale, finite-transform, normalized-weight, single-root, and facing tests: +X forward, +Y right, +Z up, matching [Unreal's coordinate convention](https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine). The bounds test CPU-skinned **every imported vertex** at the beginning, middle, and end of each clip. This checks deformation numerically; it is not a rendered material or exhaustive every-frame visual comparison. The 240 cm height is the height of these normalized Still assets, not a hard-coded human size promise.

Reaction's 1.816666722-second duration does not end on a 30 fps frame boundary. The exporter chose 60 fps to preserve its duration and final pose, and disclosed that change in the package. Unreal reports 109 frame intervals for its 110 inclusive keys; Bear has 120 intervals and 121 keys.

The optional importer was also executed directly in Unreal: it created new Bear assets, linked the correct Skeleton, imported a four-second sequence, and restored the Interchange setting from 1 → 0 → 1. Proof reports are local development artifacts at `.local/unreal-proof/final-legacy-1.json` and `.local/unreal-proof/import-package-smoke.json`.

## Morph targets and facial shapes

Characters imported from FBX or GLB with named morph targets show **Face & shapes** in the editor. Each slider runs from 0 to 1 and edits the moment at the playhead, creating a moment when needed. Values live with the pose, follow the same Smooth, Direct, or Hold interpolation, play in the viewport, and survive `.still` save/reopen, Undo/Redo, duplication, clip edits, and motion generation. Shapes with the same name on multiple mesh primitives are driven together. Characters without morph targets have no additional controls.

Animated GLB export writes mesh-node `weights` channels for keyed shapes. The Unreal exporter preserves the mesh's shape keys, bakes their geometry through the same centimeter/axis transform as the base mesh, and samples weights at every exported frame. `character.fbx` contains the blend shapes. `animation.fbx` includes meshes with shapes so their blend shape channels carry the animation; packages without shapes retain skeleton-only animation FBXs. `manifest.json` records `morphTargets` and `morphCurves`, with one weight per inclusive exported frame starting at time zero (`index / fps`). Conflicting weights for the same shape name on different meshes produce an explicit error because Unreal uses one named curve to drive that shape.

The supplied legacy FBX helper enables **Import Morph Targets**, imports animation curves, and retains curves whose values are all zero. It logs the morph curves found on the resulting AnimSequence and fails if an expected curve is missing. For manual import, enable those same settings and disable **Do Not Import Curve With Zero**. Source morph names must match the destination mesh when using an existing Skeleton. Manny/MetaHuman body retargeting does not map source shapes onto a different facial rig.

Blender **5.2.2** proof used a two-bone, 12-vertex skinned fixture with object translation, rotation and scale, animated bone motion, and two shapes over two seconds at 30 fps:

| Check | Result |
| --- | ---: |
| Inclusive exported frames | 61 |
| Shapes in both re-imported FBXs | Blink, Smile |
| Blink weights at 0 / 1 / 2 seconds | 0.15 / 0.85 / 0.25 |
| Smile weights at 0 / 1 / 2 seconds | 0.8 / 0.2 / 1 |
| Maximum weight error across all 61 re-imported frames | 0.000000060 |
| Exporter evaluated vertex error, morphs included | 0.000033 cm |
| Re-imported animation joint error | 0.000026 cm |
| Re-imported animation evaluated vertex error | 0.000073 cm |

The corresponding fixture without shapes passed with 0.000031 cm exporter vertex error, no imported shape keys, and a skeleton-only animation FBX. Its entire 34-field manifest matched the original exporter exactly. Reproduce these development checks with `scripts/morph-fixture.py` and `scripts/check-morph-export.py`, using Blender's `--python` argument. The builder accepts `--without-morphs --output <path.glb>`; the checker accepts `--input <path.glb> --package <path.zip> --output <report.json>`.

`scripts/smoke-morphs.mjs` also passed editor import from GLB and FBX, slider edits, Undo/Redo, save/reopen/recovery, playback, three interpolation modes, six clip edits, and GLB weight-channel checks. Run it with Node after building the fixture; optionally set `STILL_MORPH_FBX` to the extracted animation FBX. Converting its editor-produced GLB and re-importing both FBXs measured 0.000000060 maximum weight error and 0.000079 cm evaluated vertex error. A negative control that deliberately omitted morph animation failed the exporter's unchanged evaluated-vertex verification with 29.9636 cm error.

**Unreal morph import and curve validation are pending execution.** Unreal was not launched for this work. Earlier Unreal measurements establish bone animation behavior for their original fixtures, not morph behavior. `scripts/unreal_validate.py` now checks optional expected morph names/counts and evaluates float curves within 0.001 using the UE 5.8 Python API; those checks still need to run in the destination engine.

## Gameplay root motion

Choose the root-motion mode in the Unreal export dialog:

- **Original movement** (`preserve`) keeps the original skeleton and movement, with Unreal root motion disabled.
- **Gameplay root motion (Extract)** adds an unweighted `RootMotion` bone carrying horizontal travel and heading. The pelvis retains bobbing, jumping height, pitch, and roll. All original world-space poses are preserved. The import helper enables root motion and `Anim First Frame` root lock on the source and retargeted animations.
- **In place** adds the same root but removes the ground trajectory from playback. The character stays in place while retaining its body movement.

The dialog defaults to Extract on a fresh install and remembers the last movement choice. Entering an existing asset path in My original skeleton selects Original movement; choose Extract or In place explicitly only when the existing hierarchy already has the added root. Extract suits attacks and moves that travel. Existing-character mode uses the reference skeleton through the converter's `skeleton` contract rather than the added-root behavior described for the original-skeleton modes above.

This extraction is a planar locomotion convention, not a reconstruction of an animator's intended trajectory. At the exact heading singularity of a horizontal half-turn, the previous heading is retained. Full three-dimensional actor travel is not extracted: vertical motion remains in the pose. An Animation Blueprint or montage must still consume root motion according to the game's movement setup; see [Epic's root-motion guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/root-motion-in-unreal-engine).

A fresh four-second fixture traveled and turned 90 degrees. Actual Unreal 5.8 evaluation of all 121 frames measured a maximum **0.000076 cm** difference between preserve/exported source-joint positions, **zero root-track position error**, and **zero horizontal pelvis drift** for the in-place export. Blender also checked every skinned vertex at the beginning, middle, and end. These are asset-level tests; a particular project's networked CharacterMovement, collision, and Animation Blueprint still determine gameplay behavior.

### Save directly into a folder

Enable **Save into a folder** and enter an absolute path to an existing directory, such as `C:\Users\you\Documents\Unreal Clips`. The desktop app also offers **Browse**. Still remembers the folder and extracts the finished package into a subfolder named for the export. Repeated names get `_2`, `_3`, and so on; existing files are never overwritten. A failed folder save downloads the ZIP instead and shows the error.

The local API accepts `POST /api/exports/<id>/save` with JSON `{ "folder": "<absolute directory path>" }` for a finished job and returns `{ "savedTo": "<export subfolder>" }`. It creates only the export subfolder and its package contents, and rejects unsafe ZIP paths.

## Automatic Manny and MetaHuman retargeting

Choose **Manny** when the destination project already contains the mannequin. The helper finds the standard `SKM_Manny`/`SKM_Manny_Simple` asset or accepts the exact target SkeletalMesh asset path. For **MetaHuman**, add the MetaHuman to the destination project first; the helper discovers a unique body under `/Game/MetaHumans/`. If there are multiple bodies, enter the desired body asset path in Still, for example `/Game/MetaHumans/Character/Body/f_med_nrw_body.f_med_nrw_body`. Enable Unreal's **IK Rig** plugin before running the helper.

The helper recognizes standard Mixamo, Still, Manny and MetaHuman bone names, builds connected spine/head/limb chains, aligns the target pose, applies Unreal's automatic full-body IK setup where its template is recognized, and bakes a new target animation under the import's `Retargeted` folder. Unrecognized names or disconnected chains return an explicit error. Target mesh assets are never copied into the ZIP or modified.

Executed tests retargeted both the traveling fixture and the supplied 38-bone Reaction animation onto the installed Manny skeleton. The results had the correct target Skeleton, finite transforms, preserved duration (4 seconds and 1.816666722 seconds), and a moving, turning root. All imported and retargeted assets were then reopened in a fresh Unreal process and evaluated successfully. The local proof files are `.local/readiness-unreal/measure.json` and `reopen-proof.json`. A MetaHuman body was not available for a comparable execution test; that path shares the same retargeting machinery and requires the user's existing body asset. Body retargeting does not map facial controls or simulate cloth. Source facial morphs are exported separately as described above.

Agent export options are `rootMotion: "preserve" | "extract" | "in-place"`, `retarget: "none" | "manny" | "metahuman" | "skeleton"`, and optional `targetMesh` containing the Unreal asset path. With `retarget: "none"`, `targetMesh` selects an existing Skeleton or SkeletalMesh for direct animation import. With Manny or MetaHuman it selects the retarget destination SkeletalMesh. With `retarget: "skeleton"`, provide `targetSkeleton`; the reference defaults to the asset's original FBX bytes from the current import session. API defaults remain `preserve` and `none`; the dialog uses the remembered movement choice, initially Extract.

The client sends one request containing the GLB immediately followed by the reference FBX, with query parameters `retarget=skeleton`, `targetSkeleton=<asset path>`, and `reference=1`. The server splits at the GLB header's total length, checks the binary FBX signature, writes `reference.fbx`, and passes its absolute path as `referenceFbx` in the converter options. Combined uploads allow 330 MB while the GLB limit stays 180 MB.

Materials and texture files use basic FBX material transfer. Check PBR connections, transparency, normal maps, and appearance in the target project; arbitrary shader graphs do not round-trip through [FBX's material pipeline](https://dev.epicgames.com/documentation/unreal-engine/fbx-material-pipeline-in-unreal-engine). Physics Assets, collision behavior, LODs, and cloth are outside these skeletal animation checks.

The exporter writes Blender binary FBX 7400. Epic's importer uses the FBX 2020.2 SDK and warns that version differences can cause compatibility issues. The measured evidence above establishes this export path on the installed 5.8.2 engine and these fixtures; it is not a guarantee for every model, importer, engine release, or game runtime.

## Repeat the validation

`scripts/unreal_validate.py` runs in an isolated Unreal project with Python Editor Script Plugin, Editor Scripting Utilities, and Skeletal Mesh Modeling Tools enabled. Set `STILL_UNREAL_VALIDATION` to a JSON configuration containing a fresh `runId`, an output path, and each case's FBX paths plus reference names, parents, rest poses, sample poses, mesh bounds, duration, and height. A completed example is `.local/unreal-proof/final-legacy-1-config.json`.

Each case's `expected` object can also contain `morphTargets: ["Blink", "Smile"]` and `morphCurves: {"Blink": [{"time": 0, "value": 0.15}, {"time": 1, "value": 0.85}, {"time": 2, "value": 0.25}]}`. Include every expected target name for an exact count/name check. Curves can instead be numeric arrays aligned with `sampleTimes`, or full exported arrays with `frameCount` and `fps`, matching the manifest. Missing APIs, missing curves, invalid samples, and empty imported curves produce clear errors or failed checks. Curve evaluation uses `AnimationLibrary.get_float_value_at_time`, with imported keys inspected through `get_float_keys`. The existing CPU-skinned bounds check evaluates bone deformation only; omit morph-deformed `meshBoundsCm` expectations for morph cases.

Run `UnrealEditor-Cmd.exe <project.uproject> -run=pythonscript -script=<absolute scripts/unreal_validate.py> -unattended -nullrhi -nosplash -NoSound`. The validator creates assets only under a new `/Game/StillExportValidation/<runId>` path and refuses an existing validation destination. It writes measured results and explicit pass/fail checks to the configured JSON report. This is an asset validation commandlet, not an automated game-playthrough or material render test.
