# Security

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/mrchevyceleb/still-motion-studio/security/advisories/new). If that form is unavailable, open an issue requesting a private reporting channel without including vulnerability details. Do not post working exploits, credentials, or private project files in public issues.

Include the version/commit, operating system, affected component, impact, and the smallest reproducible example you can safely share. Maintainers will investigate; this volunteer project does not promise a response deadline or a bounty.

Security fixes target the latest stable release and `main`. Update before reporting an issue fixed in a newer release. Older releases do not receive guaranteed backports.

## Local service and data

Still's editor and engine bind to loopback. The agent API uses a per-installation bearer credential in `.local/agent/connection.json` (under the app data directory for installed builds). Treat that file as a password: it authorizes scene editing, imports, and exports. Never commit it or forward the service through a public tunnel. Do not disable origin checks or expose the service on `0.0.0.0`.

Imported models, animation files, projects, and scripts are untrusted inputs. Native importers and engine adapters run locally with your user permissions; use files from sources you trust and keep dependencies updated. Back up important scenes as `.still` files.

The public updater requires no GitHub account. Release checks/downloads contact GitHub; normal character processing stays local. Optional setup scripts download their named dependencies and datasets. The app does not upload your character files as part of editing or generation.

Windows installers are currently unsigned. Release assets include `SHA256SUMS.txt` and a source-commit manifest. Download only from this repository's release page and verify checksums; checksums identify a release but do not replace code signing.
