import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Written before a native job starts, not just when its cleanup fails. A killed
// service therefore cannot silently forget that Cascadeur may own a temp scene.
export function nativeRecoveryJournal(dataRoot, { python } = {}) {
  const file = path.join(dataRoot, '.local', 'native-recovery.json');
  const persist = async record => {
    await mkdir(path.dirname(file), { recursive: true });
    const pending = file + '.pending';
    await writeFile(pending, JSON.stringify(record), { mode: 0o600 });
    await rename(pending, file);
  };
  return {
    async read() {
      try {
        const record = JSON.parse(await readFile(file, 'utf8'));
        if (record.version !== 1 || typeof record.config?.python !== 'string') throw new Error('Invalid native recovery journal.');
        if (python && record.config.python !== python) {
          await access(python);
          record.config.python = python;
          await persist(record);
        }
        return record.config;
      } catch (error) {
        if (error.code === 'ENOENT' && error.path === file) return null;
        throw error;
      }
    },
    async begin(config) {
      await persist({ version: 1, startedAt: new Date().toISOString(), config });
    },
    async clear() { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
  };
}
