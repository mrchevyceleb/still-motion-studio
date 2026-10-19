/** Carry the approved learned models from the latest published full installer
 * into .local/, so an automatic build ships the same models as the last release.
 * Model weights are not in Git. prepare-desktop.mjs still re-verifies every copied
 * file against the rights registry before anything is bundled. A release with no
 * learned models to carry stops the build, so a lost model can never pass from one
 * release to the next; set STILL_ALLOW_NO_MODELS=1 only to start the chain over. */
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.GITHUB_REPOSITORY || 'mrchevyceleb/still-motion-studio';
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options }).trim();
const exists = file => access(file).then(() => true, () => false);
const noModels = reason => {
  if (process.env.STILL_ALLOW_NO_MODELS !== '1') throw new Error(`${reason} Set STILL_ALLOW_NO_MODELS=1 to build without learned models on purpose.`);
  console.log(`${reason} Building without learned models (STILL_ALLOW_NO_MODELS=1).`);
};
const fileHash = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

let sevenZip = '7z';
try { run(sevenZip, ['i']); }
catch { sevenZip = 'C:/Program Files/7-Zip/7z.exe'; if (!await exists(sevenZip)) throw new Error('7-Zip is required to read the previous installer.'); }

let latest;
try { latest = JSON.parse(run('gh', ['api', `repos/${repo}/releases/latest`])); }
catch (error) { if (String(error.stderr || '').includes('HTTP 404')) { noModels('No published release to carry models from.'); process.exit(0); } throw error; }
const version = latest.tag_name.replace(/^v/, '');
const installer = `Still-Motion-Studio-Setup-${version}.exe`;
if (!latest.assets.some(asset => asset.name === installer)) throw new Error(`${latest.tag_name} has no ${installer}.`);

const work = path.join(process.env.RUNNER_TEMP || os.tmpdir(), `still-release-models-${version}`);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
try {
  run('gh', ['release', 'download', latest.tag_name, '--repo', repo, '--dir', work, '--pattern', installer, '--pattern', 'SHA256SUMS.txt'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const sums = await readFile(path.join(work, 'SHA256SUMS.txt'), 'utf8');
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === installer)?.[0];
  if (!expected || await fileHash(path.join(work, installer)) !== expected) throw new Error(`${installer} does not match the release SHA256SUMS.txt.`);

  // NSIS keeps the app in an inner 7z archive; read only the runtime catalog and models.
  run(sevenZip, ['e', '-y', `-o${work}`, path.join(work, installer), path.join('$PLUGINSDIR', 'app-64.7z')]);
  const extracted = path.join(work, 'app');
  const runtimeEntry = name => path.join('resources', 'runtime', ...name.split('/'));
  run(sevenZip, ['x', '-y', `-o${extracted}`, path.join(work, 'app-64.7z'), runtimeEntry('catalog.json'), runtimeEntry('deps/local')]);
  const catalog = JSON.parse(await readFile(path.join(extracted, runtimeEntry('catalog.json')), 'utf8'));
  if (catalog.version !== 1 || catalog.complete !== true) throw new Error(`${latest.tag_name} has an incomplete runtime catalog.`);

  const dataRoot = root.replaceAll('\\', '/');
  let carried = 0;
  for (const { file, runtime } of catalog.runtimes) {
    if (!runtime.installation) continue; // Only learned models carry an installation manifest.
    if (!/^[a-z-]+\/runtime\.json$/.test(file)) throw new Error(`Unexpected runtime entry: ${file}`);
    const checkpoint = runtime.config?.checkpointPath || '';
    const relative = checkpoint.startsWith('$DATA/.local/') ? checkpoint.slice('$DATA/'.length) : '';
    if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unexpected model location for ${file}.`);
    const source = path.join(extracted, runtimeEntry('deps/local/' + relative.slice('.local/'.length)));
    const destination = path.join(root, ...relative.split('/'));
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    const local = JSON.parse(JSON.stringify(runtime).replaceAll('$DATA', dataRoot));
    delete local.python;
    await mkdir(path.dirname(path.join(root, '.local', file)), { recursive: true });
    await writeFile(path.join(root, '.local', ...file.split('/')), JSON.stringify(local, null, 2) + '\n');
    console.log(`Carried ${runtime.provider?.name || file} (${runtime.installation.modelSha256.slice(0, 12)}) from ${latest.tag_name}`);
    carried++;
  }
  if (!carried) noModels(`${latest.tag_name} ships no learned models.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
