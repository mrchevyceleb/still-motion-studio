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
| Cascadeur | Bring your own licensed installation and enable its bridge. Follow [Cascadeur setup](cascadeur-integration.md). |
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
