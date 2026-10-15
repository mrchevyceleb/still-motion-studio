/** Assemble a fresh offline Windows runtime. No repository credentials are bundled. */
import { cp, mkdir, readFile, writeFile, access, lstat, rename, rm, realpath, unlink, rmdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = path.join(root, '.local');
const published = path.join(localRoot, 'desktop-bundle');
const bundle = path.join(localRoot, 'desktop-stage-' + randomUUID());
const previous = path.join(localRoot, 'desktop-previous-' + randomUUID());
const cache = path.join(localRoot, 'desktop-cache/python');
const python = path.join(cache, 'python.exe');
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
const fileHash = filename => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(filename).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});
// The runtime folder's identity: every relative path and its bytes. Installed copies
// live outside the install folder under this id, so app-only releases leave them alone.
async function contentHash(directory) {
  const lines = [];
  async function walk(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else lines.push(`${path.relative(directory, filename).replaceAll('\\', '/')}\t${await fileHash(filename)}`);
    }
  }
  await walk(directory);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function checkedDirectory(directory) {
  if (path.dirname(path.resolve(directory)) !== localRoot || !/^desktop-(bundle|stage-[\da-f-]+|previous-[\da-f-]+)$/.test(path.basename(directory))) {
    throw new Error('Desktop build operation escaped its workspace.');
  }
  if (await exists(directory)) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Desktop build directories must be real directories.');
  }
}

// An earlier build may have left the Python cache as a link into the developer's own
// uv Python. Remove the link itself, never its target, so the cache is rebuilt from real files.
async function unlinkCache() {
  for (const link of [path.dirname(cache), cache]) {
    let stat;
    try { stat = await lstat(link); } catch { continue; }
    if (stat.isSymbolicLink()) {
      console.log(`Replacing linked ${path.relative(root, link)} with a private copy`);
      await unlink(link).catch(() => rmdir(link));
    } else if (!stat.isDirectory()) throw new Error('The desktop Python cache must be a real directory.');
  }
}

await mkdir(localRoot, { recursive: true });
await checkedDirectory(bundle);
await unlinkCache();
await mkdir(bundle); // Never reuse a partially assembled release.
try {
  if (!await exists(python)) {
    const base = execFileSync('uv', ['python', 'find', '--managed-python', '3.10'], { encoding: 'utf8', windowsHide: true }).trim();
    // uv's short-version folder is a junction. Copy the real files, never the link,
    // or uv pip install below writes into the developer's global uv Python.
    await cp(await realpath(path.dirname(base)), cache, { recursive: true, dereference: true, filter: filename => !filename.includes('site-packages') && !filename.endsWith('__pycache__') });
  }
  execFileSync('uv', ['pip', 'install', '--exact', '--break-system-packages', '--python', python, '-r', path.join(root, 'requirements-desktop.txt'), '--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match'], { stdio: 'inherit', windowsHide: true });
  execFileSync(python, ['-c', 'import torch,numpy,scipy,safetensors,mujoco; assert torch.version.cuda is None; print("Offline CPU runtime verified")'], { stdio: 'inherit', windowsHide: true });
  const deps = path.join(bundle, 'deps');
  await cp(cache, path.join(deps, 'python'), { recursive: true, dereference: true, filter: filename => !filename.endsWith('__pycache__') && !filename.endsWith('.pyc') });

  for (const name of ['server', 'backend', 'shared', 'dist']) {
    await cp(path.join(root, name), path.join(bundle, 'app', name), { recursive: true, filter: filename => !filename.endsWith('__pycache__') && !filename.endsWith('.pyc') });
  }
  await cp(path.join(root, 'package.json'), path.join(bundle, 'app/package.json'));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, name), path.join(bundle, name));
  await cp(path.join(root, 'dist/THIRD-PARTY-LICENSES.txt'), path.join(bundle, 'THIRD-PARTY-LICENSES.txt'));
  await mkdir(path.join(bundle, 'app/scripts'), { recursive: true });
  for (const name of ['still-agent.mjs', 'still-mcp.mjs', 'unreal_import.py', 'unreal_retarget.py']) {
    await cp(path.join(root, 'scripts', name), path.join(bundle, 'app/scripts', name));
  }

  const local = path.join(deps, 'local');
  await mkdir(local);
  const rights = JSON.parse(await readFile(path.join(root, 'backend/model-rights.json'), 'utf8'));
  const runtimes = [];
  const omitted = [];
  const relative = absolute => {
    const rel = path.relative(root, absolute).replaceAll('\\', '/');
    if (!rel.startsWith('.local/') || rel.includes('../')) throw new Error('A model path escaped the local model directory.');
    return rel;
  };
  for (const [provider, file] of [['owned_humanoid', 'owned-humanoid/runtime.json'], ['quadruped', 'quadruped/runtime.json'], ['physics', 'physics-proof/runtime.json']]) {
    if (provider !== 'physics' && !await exists(path.join(root, '.local', file))) {
      omitted.push({ provider, reason: 'No locally installed, release-approved model. Use curve interpolation or install an approved model.' });
      continue;
    }
    const runtime = provider === 'physics' ? {
      config: { maxSeconds: 35, maxIterations: 40, maxSolveFrames: 241 },
      provider: { id: 'mujoco', name: 'MuJoCo dynamics', learned: false, description: 'Articulated dynamics correction with frictional floor contacts. Body inertia and joint cones are approximate.' },
    } : JSON.parse(await readFile(path.join(root, '.local', file), 'utf8'));
    if (provider !== 'physics') {
      execFileSync(python, ['-m', 'backend.model_rights', provider, '--assert-release', '--runtime', path.join(root, '.local', file)], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
      const model = runtime.config.checkpointPath;
      const rel = relative(model);
      const destination = path.join(local, rel.slice(7));
      const manifest = JSON.parse(await readFile(path.join(model, 'complete.json'), 'utf8'));
      for (const filename of [...Object.keys(manifest.files), 'complete.json']) {
        const target = path.join(destination, filename);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(model, filename), target);
      }
      // Validate the copied bytes, not only the source model. The embedded Python
      // needs an extended Windows path when a worktree pushes staging past MAX_PATH.
      execFileSync(path.join(deps, 'python/python.exe'), ['-c', 'from backend.model_bundle import verify_bundle; import sys; verify_bundle(sys.argv[1], sys.argv[2], approved_files_hash=sys.argv[3])', path.toNamespacedPath(destination), rights.providers[provider].approvedCorpusSha256, rights.providers[provider].approvedCorpusFilesSha256], { cwd: path.join(bundle, 'app'), stdio: 'inherit', windowsHide: true });
      runtime.config.checkpointPath = '$DATA/' + rel;
      if (!runtime.installation) {
        for (const artifact of rights.providers[provider]?.evidenceArtifacts || []) {
          if (!artifact.path.startsWith('.local/')) continue;
          const target = path.join(local, artifact.path.slice(7));
          await mkdir(path.dirname(target), { recursive: true });
          await cp(path.join(root, artifact.path), target);
        }
      }
      runtime.requiredFiles = ['model.safetensors', 'model.json', 'validation.json', 'complete.json'].map(name => '$DATA/' + rel + '/' + name);
    } else runtime.requiredFiles = ['$APP/app/backend/physics.py'];
    runtime.python = '$RUNTIME/python/python.exe';
    runtimes.push({ file, runtime });
  }
  const blender = process.env.STILL_BLENDER_DIRECTORY || 'C:/Program Files/Blender Foundation/Blender 5.2';
  await cp(blender, path.join(deps, 'blender'), { recursive: true, filter: filename => !filename.endsWith('.pdb') && !filename.endsWith('__pycache__') });
  const blenderVersionOutput = execFileSync(path.join(blender, 'blender.exe'), ['--version'], { encoding: 'utf8', windowsHide: true });
  const blenderVersion = /^Blender (\d+\.\d+\.\d+)/m.exec(blenderVersionOutput)?.[1];
  const blenderCommit = /build hash: ([a-f0-9]+)/.exec(blenderVersionOutput)?.[1];
  if (!blenderVersion || !blenderCommit) throw new Error('Cannot identify the bundled Blender version and source commit.');
  await writeFile(path.join(bundle, 'blender-source.json'), JSON.stringify({
    version: blenderVersion, commit: blenderCommit,
    archive: `blender-${blenderVersion}.tar.xz`,
    upstream: `https://download.blender.org/source/blender-${blenderVersion}.tar.xz`,
    dependencies: 'https://download.blender.org/source/',
    buildInstructions: 'https://developer.blender.org/docs/handbook/building_blender/',
  }, null, 2) + '\n');
  for (const required of ['deps/python/python.exe', 'deps/blender/blender.exe', 'app/dist/index.html', 'app/server/engine.mjs']) await access(path.join(bundle, required));
  await writeFile(path.join(bundle, 'runtime.json'), JSON.stringify({ id: await contentHash(deps) }) + '\n');
  // This completion marker is written only after every dependency and model
  // validates. Publishing replaces the whole release, including removed files.
  await writeFile(path.join(bundle, 'catalog.json'), JSON.stringify({ version: 1, complete: true, runtimes, omitted }, null, 2));
  await checkedDirectory(published);
  await checkedDirectory(previous);
  const hadPrevious = await exists(published);
  if (hadPrevious) await rename(published, previous);
  try { await rename(bundle, published); }
  catch (error) {
    if (hadPrevious) await rename(previous, published);
    throw error;
  }
  if (hadPrevious) { await checkedDirectory(previous); await rm(previous, { recursive: true }); }
  console.log('Offline desktop bundle ready:', published);
} finally {
  if (await exists(bundle)) { await checkedDirectory(bundle); await rm(bundle, { recursive: true }); }
}
