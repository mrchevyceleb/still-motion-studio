/** Assemble and publish a fresh offline Windows runtime. */
import { cp, mkdir, readFile, writeFile, access, lstat, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

async function checkedDirectory(directory) {
  if (path.dirname(path.resolve(directory)) !== localRoot || !/^desktop-(bundle|stage-[\da-f-]+|previous-[\da-f-]+)$/.test(path.basename(directory))) {
    throw new Error('Desktop build operation escaped its workspace.');
  }
  if (await exists(directory)) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Desktop build directories must be real directories.');
  }
}

await mkdir(localRoot, { recursive: true });
await checkedDirectory(bundle);
await mkdir(bundle); // Never reuse a partially assembled release.
try {
  if (!await exists(python)) {
    const base = execFileSync('uv', ['python', 'find', '--managed-python', '3.10'], { encoding: 'utf8', windowsHide: true }).trim();
    await cp(path.dirname(base), cache, { recursive: true, filter: filename => !filename.includes('site-packages') && !filename.endsWith('__pycache__') });
  }
  execFileSync('uv', ['pip', 'install', '--exact', '--break-system-packages', '--python', python, '-r', path.join(root, 'requirements-desktop.txt'), '--extra-index-url', 'https://download.pytorch.org/whl/cpu', '--index-strategy', 'unsafe-best-match'], { stdio: 'inherit', windowsHide: true });
  execFileSync(python, ['-c', 'import torch,numpy,scipy,safetensors,mujoco; assert torch.version.cuda is None; print("Offline CPU runtime verified")'], { stdio: 'inherit', windowsHide: true });
  await cp(cache, path.join(bundle, 'python'), { recursive: true, filter: filename => !filename.endsWith('__pycache__') && !filename.endsWith('.pyc') });

  for (const name of ['server', 'backend', 'shared', 'dist']) {
    await cp(path.join(root, name), path.join(bundle, 'app', name), { recursive: true, filter: filename => !filename.endsWith('__pycache__') && !filename.endsWith('.pyc') });
  }
  await cp(path.join(root, 'package.json'), path.join(bundle, 'app/package.json'));
  await mkdir(path.join(bundle, 'app/scripts'), { recursive: true });
  for (const name of ['still-agent.mjs', 'still-mcp.mjs', 'unreal_import.py', 'unreal_retarget.py']) {
    await cp(path.join(root, 'scripts', name), path.join(bundle, 'app/scripts', name));
  }

  const local = path.join(bundle, 'local');
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
    if (provider === 'owned_humanoid' && !await exists(path.join(root, '.local', file))) {
      omitted.push({ provider, reason: 'No humanoid model has passed the current quality gate. Use curve interpolation or installed licensed Cascadeur.' });
      continue;
    }
    const runtime = JSON.parse(await readFile(path.join(root, '.local', file), 'utf8'));
    if (provider !== 'physics') {
      execFileSync(python, ['-m', 'backend.model_rights', provider, '--assert-release'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
      const model = runtime.config.checkpointPath;
      const rel = relative(model);
      const destination = path.join(local, rel.slice(7));
      const manifest = JSON.parse(await readFile(path.join(model, 'complete.json'), 'utf8'));
      for (const filename of [...Object.keys(manifest.files), 'complete.json']) {
        const target = path.join(destination, filename);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(model, filename), target);
      }
      // Validate the copied bytes, not only the source model.
      execFileSync(path.join(bundle, 'python/python.exe'), ['-c', 'from backend.model_bundle import verify_bundle; import sys; verify_bundle(sys.argv[1], sys.argv[2], approved_files_hash=sys.argv[3])', destination, rights.providers[provider].approvedCorpusSha256, rights.providers[provider].approvedCorpusFilesSha256], { cwd: path.join(bundle, 'app'), stdio: 'inherit', windowsHide: true });
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
    runtime.python = '$APP/python/python.exe';
    runtimes.push({ file, runtime });
  }
  const blender = process.env.STILL_BLENDER_DIRECTORY || 'C:/Program Files/Blender Foundation/Blender 5.2';
  await cp(blender, path.join(bundle, 'blender'), { recursive: true, filter: filename => !filename.endsWith('.pdb') && !filename.endsWith('__pycache__') });
  await writeFile(path.join(bundle, 'THIRD-PARTY-NOTICE.txt'), 'Still includes Python, PyTorch CPU, NumPy, SciPy, safetensors, MuJoCo, and unmodified Blender. Their license files are included in the runtime folders. Blender source: https://projects.blender.org/blender/blender (5.2). Motion training sources: Quaternius CC0 Universal Animation Library and Ultimate Animated Animals. No CondMDI weights or Epic/Cascadeur assets are included.\n');
  for (const required of ['python/python.exe', 'blender/blender.exe', 'app/dist/index.html', 'app/server/engine.mjs']) await access(path.join(bundle, required));
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
