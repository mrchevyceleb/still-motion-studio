# Windows desktop

## Install and use

Download the full **Still-Motion-Studio-Setup** installer from [Releases](https://github.com/mrchevyceleb/still-motion-studio/releases). It targets Windows x64 and includes CPU Python, MuJoCo and Blender; no separate Node installation or GPU is needed. Learned models are included only when locally available and approved at build time. A source-only build can omit them.

Install the full **0.2.23 Setup** once to move from the old private-repository updater to public updates without sign-in. Windows installers are unsigned; verify their origin and the published `SHA256SUMS.txt`.

The runtime is stored under `%LOCALAPPDATA%/Still Motion Studio/runtime/<id>`. **Setup** includes it; the smaller **Update** installer only works when that exact runtime is already installed. Automatic updates choose the smaller installer when possible. Updating preserves local scenes and valid user-trained models. Uninstalling removes the runtime.

Closing the editor hides it to the tray, allowing agent jobs to continue. Double-click the tray icon to reopen it; **Quit Still** stops the service. The installed app uses loopback port **17175** and stores data under `%APPDATA%/Still Motion Studio`. An occupied port is reported rather than silently switching to an empty project origin.

The **Still** menu opens data and agent-tool directories. Keep `.local/agent/connection.json` private: it authorizes local scripting. Export `.still` files for portable backups.

## Public updates

Open **Updates** in the header or **Still → Updates…**. Version 0.2.23 checks public GitHub releases at startup and every six hours. No GitHub account, CLI or access token is needed. Network access is required for checks/downloads; editing remains local.

Downloads are verified against the release's SHA-512 metadata. Choose **Restart and update** to apply one. Still saves the current scene and waits for a graceful engine shutdown. Active generation, exports, agent commands, or uploads block restart. Quitting does not implicitly install an update.

## Build from a fresh clone

Install Node.js 24 LTS, [uv](https://docs.astral.sh/uv/getting-started/installation/) and an official Windows Blender build (the default path is Blender 5.2). In PowerShell:

```powershell
npm ci
uv python install 3.10
# Set this if Blender is installed elsewhere:
$env:STILL_BLENDER_DIRECTORY = 'C:/Program Files/Blender Foundation/Blender 5.2'
npm run desktop:dist
```

This downloads the pinned CPU Python dependencies, builds the UI, retains third-party notices and copies Blender into a fresh staging directory. Output is in ignored `.local/installers/`. `npm run desktop:pack` creates an unpacked executable; after preparation, `npm run desktop` opens it.

There is no requirement for the maintainer's `.local` folder. Physics configuration is generated from defaults. Missing learned models are listed as omitted in `catalog.json`; installed models must pass existing rights, provenance, hash and quality gates. Invalid installed models cause a build failure, not a silent bypass. Models are never downloaded from a private location.

Runtime preparation swaps staging into place only after validation, preserving the previous bundle on failure. On launch it revalidates models, preserves valid user-trained snapshots and quarantines invalid manifests without deleting their checkpoint data.

## Publish a desktop release

Maintainer access to the GitHub repository and the `gh` CLI are needed only for publishing. They are not part of the installed application.

1. Run the build/tests and verify installation, import, save/reopen, export and updates on Windows. Check included model provenance. Audit the complete runtime and its source/license obligations using [third-party notices](../THIRD_PARTY_NOTICES.md).
2. Bump `package.json` and `package-lock.json` together, add `docs/releases/v<version>.md`, and commit/push that exact source.
3. Download the official source archive matching the installed Blender version from [Blender's source index](https://download.blender.org/source/). Retain its dependencies' source information and build instructions too. Modified/custom Blender builds require their actual corresponding source, not a stock archive.
4. Set `STILL_BLENDER_SOURCE_ARCHIVE` to that local archive, for example `C:/Downloads/blender-5.2.1.tar.xz`, then run `npm run desktop:release`.

The command builds both installers, checks their metadata and hashes, requires the matching Blender version header, then uploads installers, blockmaps, the update feed, Blender source archive, notices, checksums and source-commit metadata to a draft release. It publishes only after GitHub confirms every uploaded size and hash. A failed upload remains a draft and can be resumed. Source/archive version checks do not replace auditing a custom binary or its dependencies.

Never upload `latest.yml` without its matching installer. Preserve published corresponding source for as long as binaries are offered. The public GitHub feed must be reachable before announcing public automatic updates. Code signing is not configured by this project.
