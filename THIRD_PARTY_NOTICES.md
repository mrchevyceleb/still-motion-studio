# Third-party software, models and assets

Still Motion Studio's original code is covered by [MIT](LICENSE). This does not relicense dependencies, imported characters, external applications, training corpora or third-party trademarks. Retain their notices when redistributing them.

## JavaScript and fonts

| Component | License / source |
| --- | --- |
| React and React DOM | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| Three.js | [MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) |
| Lucide icons | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| Electron | [MIT](https://github.com/electron/electron/blob/main/LICENSE); Chromium and other bundled components have separate notices |
| electron-updater | [MIT](https://github.com/electron-userland/electron-builder/blob/master/LICENSE) |
| Manrope and DM Sans fonts | SIL Open Font License 1.1; full notices in [`public/fonts`](public/fonts) |

`npm run build` generates `dist/THIRD-PARTY-LICENSES.txt` from the installed runtime dependency tree, including the frontend packages bundled into JavaScript. The desktop bundle carries this file too. Electron's distribution retains its own `LICENSE` and `LICENSES.chromium.html`. Build tools are not licensed under Still's MIT grant either; consult their installed packages and `package-lock.json`.

## Optional desktop runtime

Windows installers include unmodified Python (PSF), PyTorch (BSD-3-Clause), NumPy (BSD-3-Clause), SciPy (BSD-3-Clause), MuJoCo (Apache-2.0), safetensors (Apache-2.0) and their dependencies. Full license files remain alongside the installed distributions, including notices for bundled numerical libraries. `requirements-desktop.txt` pins those versions.

Blender is a separate executable invoked for exports. Its combined binary is distributed under GPL-3.0-or-later; its bundled dependencies have additional terms. The Python scripts in this repository do not change Blender's executable. See [Blender licensing](https://www.blender.org/about/license/) and its [official source archives](https://download.blender.org/source/).

For every newly published full installer, the release process requires a matching Blender source archive and copies its identity and SHA-256 into `blender-source.json`. The archive is uploaded beside the installer and included in `SHA256SUMS.txt`. Preserve Blender's installed license directory and provide the corresponding source and build instructions for any modified redistribution. A link to this project's MIT license alone is not a license notice for Blender. Review additional bundled dependency obligations before distributing a custom runtime.

The desktop also includes app-local Microsoft Visual C++ 14.44.35211 runtime DLLs, extracted without modification from the hash-pinned official Microsoft redistributable. Its complete license is included as `python/MICROSOFT-VC-RUNTIME-LICENSE.rtf` alongside the binaries.

## NVIDIA MotionBricks

Official Windows releases include NVIDIA MotionBricks SOMA RP v1 ONNX weights, pinned to source revision `54fc563aeaaf819a753d72cc9fdc6713989cdd43` and SHA-256 `856419dc72aeb14e591eebf4dd0ea05734a2506ddb00bcd39dd6dac2ad60f4fb`. The model is separately licensed under the [NVIDIA Open Model Agreement](backend/assets/NVIDIA-Open-Model-Agreement.pdf); its full agreement and upstream model notice accompany the installed weights. Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement.

The adapted SOMA feature codec and canonical skeleton retain upstream Apache-2.0 notices in [backend/assets/motionbricks-LICENSE.txt](backend/assets/motionbricks-LICENSE.txt). No NVIDIA evaluation sample motion is shipped. ONNX Runtime (MIT), FlatBuffers (Apache-2.0), packaging (Apache-2.0/BSD) and protobuf (BSD) retain their installed distribution notices. The model is not relicensed under Still's MIT license.

## Motion and character rights

- The offline Motion Library includes Quaternius Universal Animation Library 1 and 2 and selected Mesh2Motion rigs and animation packs under CC0 1.0 Universal. Source versions, individual hashes, and attribution details are retained in [`public/motions/NOTICE.txt`](public/motions/NOTICE.txt) and [`public/motions/catalog.json`](public/motions/catalog.json). The Carnegie Mellon derived mocap pack is excluded.
- The owned quadruped prior is trained from scratch on the documented Quaternius CC0 corpus. Its model and provenance must pass `backend/model-rights.json` before packaging. Weights and training assets are not in Git; source-only builds omit unavailable models.
- No CondMDI checkpoint is distributed. Code licensing does not resolve checkpoint, dataset or output rights. The research provider is disabled unless deliberately enabled by a developer. See [model rights](docs/motion-model-rights.md).
- The Cascadeur integration was removed in 0.2.23. No Cascadeur binary, vendor weights, Epic Manny or MetaHuman asset is included.
- Imported FBX/GLB files, Mixamo animations and exported user projects retain their own rights. Obtain permission for the assets you share. A repository license does not grant rights to those assets.
- Manrope/DM Sans font names, Blender, Unreal Engine, Cascadeur and other product names belong to their respective owners. This project is independent of those vendors.
