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

async function resolveRuntime(bundle, store) {
  const { id } = JSON.parse(await readFile(path.join(bundle, 'runtime.json'), 'utf8'));
  if (!RUNTIME_ID.test(id)) throw new Error('The installed runtime manifest is invalid.');
  const target = path.join(store, id);
  const shipped = path.join(bundle, 'deps');
  if (!await healthy(target, id)) {
    await mkdir(store, { recursive: true });
    let incoming;
    if (await exists(shipped)) {
      incoming = path.join(store, `incoming-${randomUUID()}`);
      // A same-drive rename is instant. A custom install folder on another drive copies once.
      try { await rename(shipped, incoming); }
      catch { await cp(shipped, incoming, { recursive: true }); }
      await writeFile(path.join(incoming, '.complete'), id);
    } else {
      // A launch that stopped mid-move left the finished runtime in a marked incoming folder.
      for (const name of await readdir(store)) {
        if (!incoming && name.startsWith('incoming-') && await healthy(path.join(store, name), id)) incoming = path.join(store, name);
      }
      if (!incoming) throw new Error('Still\'s runtime files are missing. Run the full Still-Motion-Studio-Setup installer from https://github.com/mrchevyceleb/still-motion-studio/releases/latest once to restore them.');
    }
    await rm(target, { recursive: true, force: true });
    await rename(incoming, target);
  }
  // Best effort: a leftover copy in the install folder slows the next uninstall,
  // and runtimes from older releases only waste disk.
  void (async () => {
    await rm(shipped, { recursive: true, force: true });
    for (const name of await readdir(store)) {
      if (name !== id && (RUNTIME_ID.test(name) || name.startsWith('incoming-'))) await rm(path.join(store, name), { recursive: true, force: true });
    }
  })().catch(() => {});
  return target;
}

module.exports = { resolveRuntime };
