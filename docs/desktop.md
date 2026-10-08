# Windows desktop

Run **Still Motion Studio Setup 0.2.0.exe** and choose a per-user install location. The app works offline on Windows x64 without separate Python, Node, Blender, or CUDA installations. The validated animal model, a CPU runtime, MuJoCo, Blender, and fonts are included.

Closing the editor hides it to the tray. Agent commands, rendering, and generation continue in that workspace. Double-click the tray icon to reopen; **Quit Still** stops the engine and performs native cleanup. The app must remain running for scripting to work.

Desktop uses port **17175** on loopback. Keeping the origin fixed preserves projects across restarts. If another program owns that port, Still reports the conflict rather than opening an empty workspace elsewhere. Development stays on 5173/5175.

Data is under `%APPDATA%/Still Motion Studio`. The **Still** menu opens its data and agent-tools directories. The private token lives in `.local/agent/connection.json`; never share it. Configure an external Node-capable agent with `agent-tools/still-mcp.mjs`, or use `still-agent.mjs` beside it. The installed app itself does not require Node.

Cascadeur is optional. If installed in its normal user folder, Still registers the adapter automatically. Its scripting bridge must run at `127.0.0.1:8765`. [Native setup](cascadeur-integration.md). Failed cleanup is retained on disk and retried at startup; further native work stays blocked until cleanup succeeds.

## Build

Install Node, uv, managed Python 3.10, and Blender on the development machine. Run `npm install`, `uv python install 3.10`, then `npm run desktop:dist`. Builds go to ignored `.local/installers`.

`desktop:prepare` compiles the UI, constructs a portable CPU runtime using pinned requirements, copies approved models and provenance into a fresh staging folder, validates the copied bundles, and publishes the complete folder with rollback, and includes Blender from `STILL_BLENDER_DIRECTORY` or the local 5.2 installation. `desktop:pack` builds an unpacked executable; `npm run desktop` opens the prepared bundle.

No CondMDI checkpoint, user FBX, training mesh, Epic target character, or Cascadeur binary is packaged. Dependency license files accompany their binaries. The installer is unsigned, so Windows may show a publisher warning. Signing and automated release updates remain release-operations work.

The current installer omits the standalone humanoid model because it failed the corrected quality gate. Use curve interpolation or the licensed Cascadeur adapter for human motion. Old development weights remain backed up locally for research.

Release 0.2 is validated as a fresh-install preview. Two upgrade issues remain: existing data can retain stale runtime/model manifests, and moving the app while native cleanup is pending can leave an obsolete Python path in recovery. See [validation and review findings](../reports/Release-0.2-validation.md).
