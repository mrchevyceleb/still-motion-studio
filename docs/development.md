# Development

## Run the editor

Install [Node.js 24 LTS](https://nodejs.org/) and Git. Node 22.12 or newer is supported. Windows, macOS and Linux can run the browser editor; the packaged desktop build targets Windows x64.

```sh
git clone https://github.com/mrchevyceleb/still-motion-studio.git
cd still-motion-studio
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The local engine runs on port 5175. Stop development with Ctrl+C. If either port is occupied, stop the other Still development instance first. No API key, cloud account, Python, GPU, model download or environment file is needed for core editing. Optional native tools display their availability in the app.

Projects and the character library live in browser storage for this origin. Export `.still` files for backups; clearing site data removes local projects. Avoid switching between `localhost` and `127.0.0.1` if you want the same library. Never commit project files containing someone else's models.

## Optional native features

| Feature | Setup |
| --- | --- |
| MuJoCo physics | Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then in Windows PowerShell run `./scripts/setup-physics.ps1`. The script provisions Python 3.12 and verifies the solver. |
| Unreal FBX export | Install Blender and set `STILL_BLENDER_EXECUTABLE` to its executable before starting development. See [export documentation](unreal-export.md). GLB export works without Blender. |
| Learned animal motion | Follow [quadruped training](learned-quadruped.md). The training scripts require the documented CUDA environment and a provenance-checked corpus; a fresh clone has no trained model. |
| Humanoid research | See [humanoid model status](owned-humanoid.md). No candidate currently passes the release quality gate. |

The Windows setup scripts create ignored `.local/` environments. The Python backends can also run on other platforms, but those provisioning scripts and desktop packaging are Windows-specific. Do not enable CondMDI for distribution: its weights/data rights remain unresolved.

## Layout and checks

- `src/`: React editor, Three.js viewport, timeline and scene persistence.
- `server/`: local HTTP service, authenticated agent bridge and native jobs.
- `backend/` and `training/`: optional Python motion, physics and training code.
- `desktop/`: Electron lifecycle, runtime management and public updates.
- `shared/`: contracts used by the editor and service.
- `scripts/`: development, packaging and agent tools.

```sh
npm run build
npm test
python -m compileall -q backend training
npm audit --omit=dev --audit-level=high
```

Python compilation is a syntax check and does not install native dependencies. CI runs these checks on Windows and Linux. Use a focused manual check for a UI change and native validation for the engine you changed; do not add broad duplicate tests.

The local agent token is generated in `.local/agent/connection.json`. Treat it like a password. See [agent scripting](agent-scripting.md), [contributing](../CONTRIBUTING.md), and [desktop builds](desktop.md).

## Releases

Every push to `main` publishes a Windows release. The [release workflow](../.github/workflows/release.yml) runs on `windows-latest` and:

1. Picks the version: the next patch number above every existing GitHub release and `v*` tag, with the `package.json` version as a floor. The version is set for that build only; nothing is committed back to `main`. Raise `package.json` (and `package-lock.json`) in a normal commit to start a new minor or major series.
2. Uses `docs/releases/v<version>.md` as the notes when it exists, otherwise lists the commits since the previous release.
3. Runs the tests, then downloads the pinned official Blender 5.2.1 Windows build and matching source archive from download.blender.org, checks their SHA-256 checksums and caches them. CPU Python 3.10 comes from a pinned uv release.
4. Copies the approved learned models from the latest full installer (they are not in Git), then builds the full Setup and the smaller Update installer with `npm run desktop:dist`. The models pass the same rights, provenance and hash checks as a local build.
5. Runs `scripts/release-desktop.mjs`, which checks both installers against `latest.yml` (version, runtime, SHA-512 and size), checks the Blender source version header, writes `SHA256SUMS.txt` and the source-commit manifest, uploads everything to a draft release and publishes it only after GitHub confirms every asset's size and SHA-256.

Every input to the bundled runtime is pinned (Python, packages, Blender and the carried models), so the runtime id only changes when one of them does. A release that changes only the app updates installed copies with the small Update installer.

Releases queue one at a time. A failed run leaves at most a draft, never a partial public release; re-running the job resumes the same version. Put `[skip release]` in the head commit message to push without releasing.

To test a branch without publishing, run the workflow manually with **publish** off, for example `gh workflow run release.yml --ref <branch> -f publish=false`. Runs outside `main` never publish. A dry run builds and checks everything, then attaches both installers to the workflow run as artifacts for seven days.

Maintainers can still publish from a Windows machine with `npm run desktop:release`; see [desktop builds](desktop.md#publish-a-desktop-release).
