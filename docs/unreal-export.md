# Unreal export

Still exports a ZIP containing a skeletal `character.fbx`, matching `animation.fbx`, textures when present, a manifest, and `import_unreal.py`. The source skeleton and animation stay together; importing onto the Unreal mannequin or MetaHuman requires a separate IK Retargeter.

## Import into Unreal

1. Extract the whole ZIP, keeping its files together.
2. In Unreal, enable **Python Editor Script Plugin** and **Editor Scripting Utilities**, restarting the editor if requested.
3. Choose **Tools → Execute Python Script** and select the extracted `import_unreal.py`.
4. Open the imported animation under `/Game/Still/<character name>` and play it with its imported skeletal mesh.

The script creates a new destination when that name already exists. It imports the character first, assigns the resulting Skeleton to the animation, uses the manifest's sample rate, and leaves Enable Root Motion off. It does not create a Physics Asset. If import fails, it removes only that new partial destination; unsuccessful cleanup is reported in Unreal's Output Log. The script temporarily selects Unreal's legacy FBX importer and restores the previous importer setting, including on failure. This is the route validated below. Unreal 5.8's default Interchange import route has **not** been validated to the same standard; its options are different from the legacy `FbxImportUI` settings. Use the supplied script for the measured behavior rather than assuming default drag-and-drop imports reproduce these results.

The packaged `IMPORT.txt` also lists manual settings. Those settings refer to the legacy FBX dialog: scale 1, Convert Scene and Convert Scene Unit on, Force Front XAxis off, and neither T0-as-reference-pose nor reference-pose updates. Import `character.fbx` with a new Skeleton and no animation; import `animation.fbx` against that Skeleton with its manifest sample rate and full exported time range. Avoid assigning an unrelated existing Skeleton.

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

## Root motion and remaining scope

The default export preserves motion on the original root and does not automatically enable Unreal root-motion extraction. Both tested assets have a pelvis root. Extracting that root can include body bobbing, pitch, and roll; it is not equivalent to a dedicated ground-trajectory bone. For deliberate extraction, configure Enable Root Motion, root lock, and the project's Animation Blueprint as described in [Epic's root-motion guide](https://dev.epicgames.com/documentation/en-us/unreal-engine/root-motion-in-unreal-engine). In the isolated proof, Enable Root Motion plus Anim First Frame root lock produced zero sampled root-position drift on both clips; the validator then restored the original import settings. Gameplay capsule movement was not tested.

Materials and texture files use basic FBX material transfer. Check PBR connections, transparency, normal maps, and appearance in the target project; arbitrary shader graphs do not round-trip through [FBX's material pipeline](https://dev.epicgames.com/documentation/unreal-engine/fbx-material-pipeline-in-unreal-engine). Physics Assets, collision behavior, LODs, cloth, facial morph targets, and mannequin retargeting are outside these skeletal animation checks.

The exporter writes Blender binary FBX 7400. Epic's importer uses the FBX 2020.2 SDK and warns that version differences can cause compatibility issues. The measured evidence above establishes this export path on the installed 5.8.2 engine and these fixtures; it is not a guarantee for every model, importer, engine release, or game runtime.

## Repeat the validation

`scripts/unreal_validate.py` runs in an isolated Unreal project with Python Editor Script Plugin, Editor Scripting Utilities, and Skeletal Mesh Modeling Tools enabled. Set `STILL_UNREAL_VALIDATION` to a JSON configuration containing a fresh `runId`, an output path, and each case's FBX paths plus reference names, parents, rest poses, sample poses, mesh bounds, duration, and height. A completed example is `.local/unreal-proof/final-legacy-1-config.json`.

Run `UnrealEditor-Cmd.exe <project.uproject> -run=pythonscript -script=<absolute scripts/unreal_validate.py> -unattended -nullrhi -nosplash -NoSound`. The validator creates assets only under a new `/Game/StillExportValidation/<runId>` path and refuses an existing validation destination. It writes measured results and explicit pass/fail checks to the configured JSON report. This is an asset validation commandlet, not an automated game-playthrough or material render test.
