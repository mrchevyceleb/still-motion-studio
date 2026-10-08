import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;
function start(file, args = [], ipc = false) {
  const child = spawn(process.execPath, [path.join(root, file), ...args], { cwd: root, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); void stop(1); });
  child.on('exit', code => { if (!stopping) void stop(code || 0); });
  return child;
}
let existing = false;
try { existing = (await (await fetch('http://127.0.0.1:5175/api/engine', { signal: AbortSignal.timeout(8000) })).json()).application === 'still-engine'; } catch { /* First launch. */ }
if (!existing) start('server/engine.mjs', [], true);
start('node_modules/vite/bin/vite.js', ['--host', '127.0.0.1', ...process.argv.slice(2)]);
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const limit = setTimeout(() => { child.kill(); resolve(); }, 60000);
    child.once('exit', () => { clearTimeout(limit); resolve(); });
    child.once('error', () => { clearTimeout(limit); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill(); });
    else child.kill();
  })));
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
