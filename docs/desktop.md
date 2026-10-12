# Windows desktop

Download **Still-Motion-Studio-Setup-0.2.11.exe** from the [private GitHub release](https://github.com/mrchevyceleb/still-motion-studio/releases/latest), then run it and choose a per-user install location. The app works offline on Windows x64 without separate Python, Node, Blender, or CUDA installations. The validated animal model, a CPU runtime, MuJoCo, Blender, and fonts are included.

Closing the editor hides it to the tray. Agent commands, rendering, and generation continue in that workspace. Double-click the tray icon to reopen; **Quit Still** stops the engine and performs native cleanup. The app must remain running for scripting to work.

Desktop uses port **17175** on loopback. Keeping the origin fixed preserves projects across restarts. If another program owns that port, Still reports the conflict rather than opening an empty workspace elsewhere. Development stays on 5173/5175.

Open **Scenes** beside the project name for the permanent scene library. Each entry saves independently without a five-scene limit. Switching saves the outgoing scene first; concurrent-window conflicts are preserved as separate copies. Recent backups remain accessible for recovery. Saved physics comparisons travel with the scene and `.still` export. **Ctrl S** saves to the library; **Ctrl Shift S** downloads a portable project file.

Data is under `%APPDATA%/Still Motion Studio`. The **Still** menu opens its data and agent-tools directories. The private token lives in `.local/agent/connection.json`; never share it. Configure an external Node-capable agent with `agent-tools/still-mcp.mjs`, or use `still-agent.mjs` beside it. The installed app itself does not require Node.

Cascadeur is optional. If installed in its normal user folder, Still registers the adapter automatically. Its scripting bridge must run at `127.0.0.1:8765`. [Native setup](cascadeur-integration.md). Failed cleanup is retained on disk and retried at startup; further native work stays blocked until cleanup succeeds.

## Automatic updates

Open **Updates** in the header or **Still → Updates…**. On another computer, choose **Connect GitHub** once and complete the browser sign-in with an account that can access `mrchevyceleb/still-motion-studio`. GitHub CLI is bundled; an existing CLI login is reused. New sign-ins are protected by Electron `safeStorage` (Windows DPAPI). Tokens never enter the renderer, repository, installer, or release metadata. Temporary sign-in configuration is removed even if GitHub CLI falls back to a plaintext file. Network access is needed for sign-in and updates; editing remains offline.

Still checks at startup and every six hours while running, downloads stable releases with SHA-512 verification, and shows **Update ready**. Choose **Restart and update** when ready. The app commits the current scene to local storage before requesting a graceful engine shutdown. Generation, export, agent commands, uploads, or unresolved Cascadeur cleanup block the restart. Updates do not install implicitly during Quit, so an active job is never interrupted by a downloaded update. Local scenes, dark-mode preference, and validated custom model snapshots stay in user data.

For future releases, bump the package version, add `docs/releases/v<version>.md`, commit the source, and run `npm run desktop:release` on the development machine with its approved models installed. The command builds and validates the offline installer, creates a private draft release, uploads the installer, blockmap, `latest.yml`, hashes, and source identity, checks uploaded sizes/hashes, then publishes the complete release. Failed uploads leave a draft that the same command can resume. Clients only consume the latest published stable release. No publisher token is bundled. Do not upload `latest.yml` before its matching installer.

## Building from source

Install Node, uv, managed Python 3.10, and Blender on the development machine. Run `npm install`, `uv python install 3.10`, then `npm run desktop:dist`. Builds go to ignored `.local/installers`.

`desktop:prepare` compiles the UI, constructs a portable CPU runtime using pinned requirements, copies approved models and provenance into a fresh staging folder, validates the copied bundles, and publishes the complete folder with rollback, and includes Blender from `STILL_BLENDER_DIRECTORY` or the local 5.2 installation. `desktop:pack` builds an unpacked executable; `npm run desktop` opens the prepared bundle.

No CondMDI checkpoint, user FBX, training mesh, Epic target character, or Cascadeur binary is packaged. Dependency license files accompany their binaries. The installer is unsigned, so Windows may show a publisher warning. Signing remains release-operations work. GitHub releases now supply automatic updates.

The current installer omits the standalone humanoid model because it failed the corrected quality gate. Use curve interpolation or the licensed Cascadeur adapter for human motion. Old development weights remain backed up locally for research.

On launch, the app resolves the current bundled Python and physics paths, verifies model hashes, provenance and held-out quality, and retains valid user-trained versions. Invalid runtime manifests are backed up as `runtime.rejected-<id>.json`; checkpoint data is preserved. A rejected model omitted from the catalog stays unavailable. Pending native cleanup records are durably rebased to the current Python before replay; a failed rebase retains the cleanup obligation.

Timeline duration editing supports 0.1–600 seconds. Enable **Ripple**, or hold **Shift** while dragging a diamond, to move that moment and every later pose together. The clip length adjusts while later spacing stays intact; **Ctrl Z** undoes the entire edit. **Alt Shift ← / →** ripples by one frame with a diamond focused. Timeline gestures do not activate the file-drop overlay. Duplicating a final moment at the 10-minute limit reports that room is needed, without moving the copy backwards. See the historical [0.2 validation and review findings](../reports/Release-0.2-validation.md).
