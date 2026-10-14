const { readFile, writeFile, rename, rm, cp, access, readdir, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const exists = file => access(file).then(() => true, () => false);
const RUNTIME_ID = /^[\da-f]{64}$/;

// The heavy runtime (Python, Blender, models, gh) lives outside the install folder,
// in a folder named by its content hash. App-only updates ship without it, so the
// installer never deletes or re-extracts those ~30k files unless the hash changes.
// A runtime counts only when its marker names this exact build and its main tools are
// still there (antivirus quarantine or a half-deleted folder must not pass).
async function healthy(dir, id) {
  const marker = await readFile(path.join(dir, '.complete'), 'utf8').catch(() => '');
  return marker === id && await exists(path.join(dir, 'python', 'python.exe')) && await exists(path.join(dir, 'blender', 'blender.exe'));
}

// Antivirus can hold a freshly installed file for a moment; another drive needs a copy.
async function move(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) {
      if (error.code === 'EXDEV' || attempt >= 20) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  await cp(from, to, { recursive: true, filter: source => source !== path.join(from, '.complete') });
  await writeFile(path.join(to, '.complete'), await readFile(path.join(from, '.complete'), 'utf8'));
}

async function resolveRuntime(bundle, store) {
  const { id } = JSON.parse(await readFile(path.join(bundle, 'runtime.json'), 'utf8'));
  if (!RUNTIME_ID.test(id)) throw new Error('The installed runtime manifest is invalid.');
  const target = path.join(store, id);
  const shipped = path.join(bundle, 'deps');
  if (await exists(shipped)) {
    // A full installer always wins, so running Setup again repairs a damaged runtime.
    await mkdir(store, { recursive: true });
    // Marked before the move, so a launch that stops halfway leaves a folder to recover.
    await writeFile(path.join(shipped, '.complete'), id);
    const incoming = path.join(store, `incoming-${randomUUID()}`);
    await move(shipped, incoming);
    // The old copy is renamed aside and deleted later, so startup never waits on 30k deletions.
    if (await exists(target)) await rename(target, path.join(store, `trash-${randomUUID()}`));
    await rename(incoming, target);
  } else if (!await healthy(target, id)) {
    // A launch that stopped mid-move left the finished runtime in a marked incoming folder.
    let incoming;
    for (const name of await readdir(store).catch(() => [])) {
      if (!incoming && name.startsWith('incoming-') && await healthy(path.join(store, name), id)) incoming = path.join(store, name);
    }
    if (!incoming) throw new Error('Still\'s runtime files are missing. Run the full Still-Motion-Studio-Setup installer from https://github.com/mrchevyceleb/still-motion-studio/releases/latest once to restore them.');
    if (await exists(target)) await rename(target, path.join(store, `trash-${randomUUID()}`));
    await rename(incoming, target);
  }
  // Best effort: a leftover copy in the install folder slows the next uninstall,
  // and runtimes from older releases only waste disk.
  void (async () => {
    await rm(shipped, { recursive: true, force: true });
    for (const name of await readdir(store)) {
      if (name !== id && (RUNTIME_ID.test(name) || name.startsWith('incoming-') || name.startsWith('trash-'))) await rm(path.join(store, name), { recursive: true, force: true });
    }
  })().catch(() => {});
  return target;
}

module.exports = { resolveRuntime };
