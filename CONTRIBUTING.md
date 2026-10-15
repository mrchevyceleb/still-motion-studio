# Contributing to Still

Bug reports, documentation, accessibility improvements, and focused code changes are welcome. Read the [README](README.md) for setup and current limitations.

## Development

Use Node.js 24 LTS and Git. A GPU, Python, Blender, and model downloads are **not required** to develop the editor.

```sh
git clone https://github.com/mrchevyceleb/still-motion-studio.git
cd still-motion-studio
npm ci
npm run dev
```

The editor runs at http://127.0.0.1:5173; the local service uses port 5175. Optional engines are described in [development setup](docs/development.md).

## Changes and checks

1. Open an issue for a substantial feature or architectural change. Small fixes can go straight to a pull request.
2. Branch from `main`. Keep each PR focused and explain the user-visible change.
3. Run `npm run build` and `npm test`. For UI changes, exercise the affected flow in both themes and at a narrow window width; include a screenshot when useful. Check Python syntax with `python -m compileall -q backend training` when changing those files.
4. Test the behavior you changed. Add a small regression test for a meaningful bug; documentation and styling edits do not need new test suites. Native engine/export changes need the relevant installed runtime and a description of what you actually validated.

Tests must not need a GitHub login, a publisher token, private assets, or a developer's `.local` folder. Do not publish credentials, user scenes, proprietary characters, training datasets, or model weights in issues, fixtures, or commits. Use the built-in procedural characters or assets with documented redistribution permission.

## Code and project layout

The UI is React/TypeScript in `src/`; `server/` implements the local Node service and agent API; `backend/` contains Python engine adapters; `desktop/` contains Electron integration. See [development setup](docs/development.md) for the rest.

Preserve existing rigs, Undo behavior, source poses, local scene storage, and cancellation. Keep imported content untrusted. Model quality and rights checks are separate requirements; do not bypass either to make a provider available.

By contributing, you agree that your original contributions are provided under this project's [MIT license](LICENSE). Identify any third-party code or assets and preserve their licenses. See [third-party notices](THIRD_PARTY_NOTICES.md).

Please follow the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), rather than a public issue.
