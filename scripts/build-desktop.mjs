/** Build the full installer (with the runtime) and the app-only update installer, then one feed. */
import { readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { build } = require('electron-builder');
const yaml = createRequire(require.resolve('electron-updater/package.json'))('js-yaml');
const config = JSON.parse(await readFile(path.join(root, 'electron-builder.json'), 'utf8'));
const { id: runtimeId } = JSON.parse(await readFile(path.join(root, '.local/desktop-bundle/runtime.json'), 'utf8'));
const full = path.join(root, '.local/installers');
const update = path.join(root, '.local/installers-update');
const win = (output, overrides = {}) => build({ projectDir: root, win: ['nsis'], publish: 'never', config: { ...config, directories: { ...config.directories, output }, ...overrides } });

// The update installer refuses to run unless this exact runtime is already installed,
// so running it by hand on an older or fresh PC can't leave Still without its runtime.
const guard = path.join(root, '.local/update-installer.nsh');
await writeFile(guard, `!include "${path.join(root, 'desktop', 'installer.nsh')}"
!macro customInit
  \${IfNot} \${FileExists} "$LOCALAPPDATA\\Still Motion Studio\\runtime\\${runtimeId}\\.complete"
    MessageBox MB_OK|MB_ICONSTOP "This is the quick update for an existing Still install. Run Still-Motion-Studio-Setup from github.com/mrchevyceleb/still-motion-studio/releases/latest instead." /SD IDOK
    SetErrorLevel 2
    Quit
  \${EndIf}
!macroend
`);

await rm(update, { recursive: true, force: true });
await win(full);
// Same app, without deps/: installs in seconds because the runtime already sits outside the install folder.
await win(update, { artifactName: 'Still-Motion-Studio-Update-${version}.${ext}', nsis: { ...config.nsis, include: guard }, extraResources: [{ from: '.local/desktop-bundle', to: 'runtime', filter: ['**/*', '!deps', '!deps/**/*'] }] });

const feed = yaml.load(await readFile(path.join(full, 'latest.yml'), 'utf8'));
const slim = yaml.load(await readFile(path.join(update, 'latest.yml'), 'utf8'));
if (feed.version !== slim.version || feed.files.length !== 1 || slim.files.length !== 1) throw new Error('Both installers must come from the same single-file build.');
for (const name of [slim.path, slim.path + '.blockmap']) await copyFile(path.join(update, name), path.join(full, name));
// The full installer stays first: older releases always take it. Current ones switch to
// the update installer only when runtimeId matches the runtime they already have.
feed.files.push(slim.files[0]);
feed.runtimeId = runtimeId;
await writeFile(path.join(full, 'latest.yml'), yaml.dump(feed, { lineWidth: -1 }));
console.log(`Installers ready in ${full}: ${feed.path} and ${slim.path} (runtime ${runtimeId.slice(0, 12)})`);
