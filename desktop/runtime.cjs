const { mkdir, readFile, writeFile, cp, access, rename, unlink, rm, lstat, realpath, stat } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const run = promisify(execFile);
const modelFiles = { owned_humanoid: 'owned-humanoid/runtime.json', quadruped: 'quadruped/runtime.json' };

async function atomicJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const pending = file + '.pending';
  await writeFile(pending, JSON.stringify(value), { mode: 0o600 });
  await rename(pending, file);
}

// Resolve executable paths on every launch. Checkpoints remain in user data;
// valid user-trained versions survive upgrades, including catalog omissions.
async function prepareRuntimes(bundle, dataRoot, runtimeRoot) {
  const catalog = JSON.parse(await readFile(path.join(bundle, 'catalog.json'), 'utf8'));
  if (catalog.version !== 1 || catalog.complete !== true) throw new Error('The installed runtime bundle is incomplete.');
  const python = path.join(runtimeRoot, 'python', 'python.exe');
  await access(python);
  await mkdir(dataRoot, { recursive: true });
  const localRoot = path.resolve(dataRoot, '.local');
  const realDataRoot = await realpath(dataRoot);
  async function checkedDirectory(directory, create = false) {
    const relative = path.relative(localRoot, path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Model operation escaped application data.');
    let current = localRoot;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      if (create) {
        try { await mkdir(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const info = await lstat(current);
      const physical = path.relative(realDataRoot, await realpath(current));
      if (!info.isDirectory() || info.isSymbolicLink() || physical.startsWith('..') || path.isAbsolute(physical)) throw new Error('Model directories must remain inside application data without junctions or symbolic links.');
    }
  }
  await checkedDirectory(localRoot, true);
  const expanded = new Map(catalog.runtimes.map(entry => [entry.file, JSON.parse(JSON.stringify(entry.runtime).replaceAll('$DATA', dataRoot.replaceAll('\\', '/')).replaceAll('$RUNTIME', runtimeRoot.replaceAll('\\', '/')).replaceAll('$APP', bundle.replaceAll('\\', '/')))]));
  const readExisting = async file => {
    try {
      const value = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return {}; throw error; }
  };
  const quarantine = async file => {
    // Preserve the old pointer and all model data for inspection/recovery.
    try { await rename(file, file.replace(/\.json$/, `.rejected-${randomUUID()}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const verified = async (provider, runtime) => {
    if (!Array.isArray(runtime.requiredFiles) || !runtime.requiredFiles.length || runtime.requiredFiles.some(file => typeof file !== 'string' || !file.trim())) return false;
    for (const file of runtime.requiredFiles) {
      try { await access(file); }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    const candidate = path.join(dataRoot, '.local', `runtime-check-${randomUUID()}.json`);
    try {
      await writeFile(candidate, JSON.stringify(runtime), { mode: 0o600 });
      try {
        await run(python, ['-m', 'backend.model_rights', provider, '--assert-release', '--runtime', candidate], {
          cwd: path.join(bundle, 'app'), windowsHide: true, timeout: 30000,
          env: { ...process.env, STILL_DATA_ROOT: dataRoot, PYTHONUTF8: '1' },
        });
      } catch (error) {
        if (error.code === 2 && !error.killed) return false; // Explicit content/quality rejection.
        throw new Error(`Model verification could not finish for ${provider}. The active runtime was kept.`, { cause: error });
      }
      return true;
    }
    finally { await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  const discardRepair = async directory => {
    const relative = path.relative(path.join(dataRoot, '.local'), path.resolve(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/-repair-[\da-f-]{12}$/.test(path.basename(directory))) throw new Error('Model repair cleanup escaped application data.');
    await checkedDirectory(directory);
    await rm(directory, { recursive: true });
  };
  const freshSupplied = async runtime => {
    const oldDirectory = runtime.config.checkpointPath;
    const relative = path.relative(path.join(dataRoot, '.local'), oldDirectory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Bundled model path escaped application data.');
    const directory = path.join(path.dirname(oldDirectory), `${runtime.installation.modelSha256.slice(0, 16)}-${runtime.installation.bundleManifestSha256.slice(0, 16)}-repair-${randomUUID().slice(0, 12)}`);
    // Never overwrite suspect bytes or user snapshots. A fresh immutable copy
    // can be verified independently; the previous directory remains available.
    await checkedDirectory(path.dirname(directory), true);
    await mkdir(directory);
    try {
      await cp(path.join(runtimeRoot, 'local', relative), directory, { recursive: true, force: false, errorOnExist: false });
      return { directory, runtime: { ...runtime, config: { ...runtime.config, checkpointPath: directory }, requiredFiles: runtime.requiredFiles.map(file => path.join(directory, path.relative(oldDirectory, file))) } };
    } catch (error) { await discardRepair(directory); throw error; }
  };
  for (const [provider, relative] of Object.entries(modelFiles)) {
    const file = path.join(dataRoot, '.local', relative);
    await checkedDirectory(path.dirname(file), true);
    const existing = await readExisting(file);
    const candidate = existing && { ...existing, python };
    if (candidate && await verified(provider, candidate)) {
      await atomicJSON(file, candidate);
      continue;
    }
    if (existing) await quarantine(file);
    let supplied = expanded.get(relative);
    if (supplied) {
      let repair;
      let activated = false;
      try {
        if (!await verified(provider, supplied)) {
          repair = await freshSupplied(supplied);
          supplied = repair.runtime;
          if (!await verified(provider, supplied)) throw new Error(`The installed ${provider} model failed verification. Its previous files were preserved.`);
        }
        await atomicJSON(file, supplied);
        activated = true;
      } finally { if (repair && !activated) await discardRepair(repair.directory); }
    }
  }
  const motionbricks = expanded.get('motionbricks/runtime.json');
  if (motionbricks) {
    const file = path.join(dataRoot, '.local/motionbricks/runtime.json');
    await checkedDirectory(path.dirname(file), true);
    const model = path.join(runtimeRoot, 'local/motionbricks/mmm_v6_soma_fp32.onnx');
    const unavailableFile = path.join(path.dirname(file), 'unavailable.json');
    try {
      const expected = '856419dc72aeb14e591eebf4dd0ea05734a2506ddb00bcd39dd6dac2ad60f4fb';
      if (path.resolve(motionbricks.config?.modelPath || '') !== path.resolve(model) || motionbricks.config.modelSha256 !== expected) throw new Error('The model configuration does not match this release.');
      for (const required of motionbricks.requiredFiles) await access(required);
      if (!Number.isSafeInteger(motionbricks.config.modelSize) || (await stat(model)).size !== motionbricks.config.modelSize) throw new Error('The model file is incomplete.');
      // Hashes are checked during assembly and before every inference. Avoid
      // reading 723 MiB before opening the editor on every startup.
      const { id } = JSON.parse(await readFile(path.join(bundle, 'runtime.json'), 'utf8'));
      const probeFile = path.join(path.dirname(file), 'probe.json');
      const key = `${id}|${model}|${python}`;
      if ((await readExisting(probeFile))?.key !== key) {
        await run(python, ['-B', '-c', 'from backend.motionbricks import load_onnxruntime; load_onnxruntime()'], { cwd: path.join(bundle, 'app'), windowsHide: true, timeout: 120000 });
        await atomicJSON(probeFile, { key });
      }
      await atomicJSON(file, { ...motionbricks, python });
      await unlink(unavailableFile).catch(() => {});
    } catch (error) {
      const message = 'MotionBricks could not start. Reinstall the full Setup to restore it; your scenes and the editor remain available.';
      try {
        const previous = await readExisting(file);
        const oldModel = previous?.config?.modelPath;
        const relative = oldModel ? path.relative(path.dirname(runtimeRoot), path.resolve(oldModel)) : '';
        if (!oldModel || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) await quarantine(file);
      } catch { /* An optional provider must not block editor startup. */ }
      await atomicJSON(unavailableFile, { message }).catch(() => {});
      console.warn(message, error.message);
    }
  }
  if (!motionbricks) {
    const file = path.join(dataRoot, '.local/motionbricks/runtime.json');
    try {
      const oldModel = (await readExisting(file))?.config?.modelPath;
      if (oldModel) {
        const relative = path.relative(path.dirname(runtimeRoot), path.resolve(oldModel));
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) await quarantine(file);
      }
    } catch { /* Preserve editor startup and externally installed providers. */ }
    await unlink(path.join(dataRoot, '.local/motionbricks/unavailable.json')).catch(() => {});
  }
  const physicsFile = path.join(dataRoot, '.local', 'physics-proof/runtime.json');
  await checkedDirectory(path.dirname(physicsFile), true);
  const physics = expanded.get('physics-proof/runtime.json');
  if (!physics) throw new Error('The installed physics runtime is missing.');
  const previousPhysics = await readExisting(physicsFile);
  const tuning = Object.fromEntries(['maxSeconds', 'maxIterations', 'maxSolveFrames'].filter(key => Number.isFinite(previousPhysics?.config?.[key]) && previousPhysics.config[key] > 0).map(key => [key, previousPhysics.config[key]]));
  await atomicJSON(physicsFile, { ...physics, config: { ...physics.config, ...tuning } });
  return python;
}

module.exports = { prepareRuntimes };
