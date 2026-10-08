import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, readdir, stat, rm, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUnrealExportService } from './unreal-export.mjs';
import { createAgentService } from './agent-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.STILL_ENGINE_PORT || 5175);
const jobs = new Map();
const configurations = {
  owned_humanoid: '.local/owned-humanoid/runtime.json',
  quadruped: '.local/quadruped/runtime.json',
  inbetween: '.local/ai-motion/runtime.json',
  physics: '.local/physics-proof/runtime.json',
  cascadeur: '.local/cascadeur-proof/runtime.json',
  cascadeur_physics: '.local/cascadeur-physics/runtime.json',
};
let activeJob = null;
let cascadeurHealth = { expires: 0, ready: false };
let nativeCleanupPending = false;
let nativeRecoveryConfig = null;
let recoveryWork = null;
const recoveryMessage = 'Cascadeur could not restore its temporary scene. Open Cascadeur with its scripting bridge, then retry cleanup. Your animation is unchanged.';
let stopping = false;
const jobRoot = path.join(root, '.local', 'engine-jobs');
const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173']);
const agentService = createAgentService({ root, port });
const exportsService = createUnrealExportService({ root,
  reserve(id) { if (activeJob || stopping) return false; activeJob = `export:${id}`; return true; },
  release(id) { if (activeJob === `export:${id}`) activeJob = null; },
});

async function configuration(id) {
  try {
    const config = JSON.parse(await readFile(path.join(root, configurations[id]), 'utf8'));
    await access(config.python);
    await access(path.join(root, 'backend', `${id}.py`));
    for (const filename of config.requiredFiles || []) await access(filename);
    if (id === 'cascadeur' || id === 'cascadeur_physics') {
      if (nativeCleanupPending) return null;
      if (Date.now() > cascadeurHealth.expires) {
        let ready = false;
        try { ready = (await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(6000) })).ok; } catch { /* Native engine is closed. */ }
        cascadeurHealth = { expires: Date.now() + 30000, ready };
      }
      if (!cascadeurHealth.ready) return null;
    }
    return config;
  } catch { return null; }
}

async function providers() {
  const result = [];
  for (const id of Object.keys(configurations)) {
    const config = await configuration(id);
    if (config) result.push({ id, kind: ['physics', 'cascadeur_physics'].includes(id) ? 'physics' : 'inbetween', name: config.provider?.name || id, learned: config.provider?.learned === true, description: config.provider?.description || '', limits: config.limits || {} });
  }
  return result;
}

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error('This motion is too large for one generation pass.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicJob(job) {
  return { id: job.id, status: job.status, message: job.message, progress: job.progress, provider: job.provider, ...(job.status === 'done' ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
}

async function cleanupNative(config) {
  const child = spawn(config.python, ['-m', 'backend.cascadeur', '--cleanup'], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, PYTHONUTF8: '1' } });
  const timeout = setTimeout(() => child.kill(), 45000);
  try { return await new Promise(resolve => { child.on('error', () => resolve(false)); child.on('close', code => resolve(code === 0)); }); }
  finally { clearTimeout(timeout); }
}

async function restoreNative(config) {
  // One automatic retry handles a transient bridge interruption. Keep the
  // failed configuration so explicit recovery works even while providers hide.
  let restored = await cleanupNative(config);
  if (!restored && !stopping) restored = await cleanupNative(config);
  nativeCleanupPending = !restored;
  nativeRecoveryConfig = restored ? null : config;
  cascadeurHealth.expires = 0;
  return restored;
}

async function pruneJobFiles() {
  await mkdir(jobRoot, { recursive: true });
  // Never recursively remove a redirected directory or an arbitrary filename.
  if ((await realpath(jobRoot)).toLowerCase() !== path.resolve(jobRoot).toLowerCase()) return;
  const entries = [];
  for (const entry of await readdir(jobRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name)) continue;
    const target = path.resolve(jobRoot, entry.name);
    if (path.dirname(target) !== jobRoot || jobs.get(entry.name)?.status === 'running') continue;
    entries.push({ target, modified: (await stat(target)).mtimeMs });
  }
  entries.sort((a, b) => b.modified - a.modified);
  for (const entry of entries.slice(20)) await rm(entry.target, { recursive: true, force: true });
}

async function run(job, request, config) {
  const folder = path.join(jobRoot, job.id);
  try {
    await mkdir(folder, { recursive: true });
    const input = path.join(folder, 'request.json');
    const output = path.join(folder, 'result.json');
    await writeFile(input, JSON.stringify({ ...request, runtime: config.config || {} }));
    if (job.status === 'cancelled') return;
    const child = spawn(config.python, ['-u', path.join(root, 'backend/worker.py'), '--provider', job.provider, '--input', input, '--output', output], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: '4' },
    });
    job.child = child;
    const deadline = setTimeout(() => { job.error = 'The motion engine exceeded ten minutes. Your animation was kept.'; child.kill(); }, 600000);
    let pending = '';
    let errors = '';
    const log = [];
    child.stdout.on('data', chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      for (const line of lines) {
        log.push(line);
        try {
          const event = JSON.parse(line);
          if (event.event === 'progress') { job.message = event.message; job.progress = event.progress; }
          if (event.event === 'error') job.error = event.message;
        } catch { /* Provider libraries may write ordinary log lines. */ }
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-16000); });
    let code;
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { clearTimeout(deadline); }
    await writeFile(path.join(folder, 'engine.log'), log.join('\n') + '\n' + errors);
    if (job.status === 'cancelled') return;
    if (code !== 0) throw new Error(job.error || 'The local engine could not finish this motion. Check the engine log for details.');
    job.result = JSON.parse(await readFile(output, 'utf8'));
    job.message = job.provider.startsWith('cascadeur') ? 'Restoring your native workspace…' : 'Finishing the motion…';
  } catch (error) {
    if (job.status !== 'cancelled') { job.status = 'error'; job.error = String(error.message || error); job.message = job.error; }
  } finally {
    job.child = null;
    if (job.provider === 'cascadeur' || job.provider === 'cascadeur_physics') {
      // A killed Python worker cannot execute its finally block. Recover only
      // scenes owned by our native adapter before accepting another job.
      if (!(await restoreNative(config))) {
        job.status = 'error'; job.error = recoveryMessage; job.message = recoveryMessage;
        delete job.result;
      }
    }
    if (activeJob === job.id) activeJob = null;
    if (job.status === 'running' && job.result) { job.status = 'done'; job.progress = 1; job.message = 'Motion ready.'; }
    await pruneJobFiles().catch(error => console.error('Diagnostic cleanup:', error.message));
  }
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host) || (origin && !origins.has(origin))) {
    reply(res, 403, { error: 'This engine accepts requests from the local Still editor only.' }); return;
  }
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  try {
    if (await agentService.handle(req, res, url)) return;
    if (await exportsService.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/api/engine') {
      reply(res, 200, { application: 'still-engine', version: 1, providers: await providers(), busy: activeJob !== null, ...(nativeCleanupPending ? { recovery: { message: recoveryMessage, canRetry: activeJob === null && !stopping } } : {}) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/engine/recover') {
      if (activeJob || stopping) { reply(res, 409, { error: 'The engine is busy. Wait for the current operation before retrying cleanup.' }); return; }
      if (!nativeCleanupPending || !nativeRecoveryConfig) { reply(res, 200, { recovered: true }); return; }
      activeJob = 'native-recovery';
      recoveryWork = restoreNative(nativeRecoveryConfig);
      let recovered;
      try { recovered = await recoveryWork; }
      finally { activeJob = null; recoveryWork = null; }
      reply(res, recovered ? 200 : 503, recovered ? { recovered: true } : { error: recoveryMessage }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/engine/jobs') {
      if (stopping) { reply(res, 503, { error: 'The local motion engine is shutting down.' }); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { reply(res, 415, { error: 'Use a JSON motion request.' }); return; }
      if (activeJob) { reply(res, 409, { error: 'The local engine is already working. Wait for that motion or cancel it first.' }); return; }
      const request = await body(req);
      const provider = request.provider;
      if (!Object.hasOwn(configurations, provider)) { reply(res, 400, { error: 'Choose an installed motion engine.' }); return; }
      const config = await configuration(provider);
      if (!config) { reply(res, 503, { error: 'This motion engine is not installed or its model files are missing.' }); return; }
      // Recheck after asynchronous body/config reads so simultaneous requests cannot start two GPU jobs.
      if (activeJob || stopping) { reply(res, 409, { error: 'The local engine is busy or shutting down.' }); return; }
      const job = { id: crypto.randomUUID(), status: 'running', provider, progress: 0, message: 'Preparing your motion…', child: null };
      jobs.set(job.id, job); activeJob = job.id;
      for (const [id, previous] of jobs) { if (jobs.size <= 20) break; if (previous.status !== 'running') jobs.delete(id); }
      job.work = run(job, request, config);
      reply(res, 202, publicJob(job)); return;
    }
    const match = url.pathname.match(/^\/api\/engine\/jobs\/([0-9a-f-]{36})$/);
    const job = match ? jobs.get(match[1]) : null;
    if (job && req.method === 'GET') { reply(res, 200, publicJob(job)); return; }
    if (job && req.method === 'DELETE') {
      if (job.status === 'running') { job.status = 'cancelled'; job.message = 'Generation cancelled. Your poses are unchanged.'; job.child?.kill(); }
      reply(res, 200, publicJob(job)); return;
    }
    reply(res, 404, { error: 'That local engine request was not found.' });
  } catch (error) { reply(res, 400, { error: error instanceof SyntaxError ? 'The motion request was not valid JSON.' : String(error.message || error) }); }
});

server.listen(port, '127.0.0.1', () => console.log(`Still motion engine: http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
void pruneJobFiles().catch(error => console.error('Diagnostic cleanup:', error.message));
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await agentService.stop();
  for (const job of jobs.values()) {
    if (job.status === 'running') { job.status = 'cancelled'; job.child?.kill(); }
  }
  await exportsService.stop();
  await Promise.allSettled([...jobs.values()].map(job => job.work).concat(recoveryWork));
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('message', message => { if (message?.type === 'shutdown') void stop(); });
// The IPC parent disappearing also requests cleanup, including on Windows.
if (process.connected) process.on('disconnect', stop);
