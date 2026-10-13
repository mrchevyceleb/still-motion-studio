#!/usr/bin/env node
/** Local Still SDK. No dependencies, remote credentials, or automatic mutation retries. */
import { readFile, writeFile, link, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const defaultConnection = fileURLToPath(new URL('../.local/agent/connection.json', import.meta.url));
const terminal = new Set(['done', 'error', 'cancelled']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StillError extends Error {
  constructor(message, code = 'STILL_ERROR', details = {}) {
    super(message); this.name = 'StillError'; this.code = code; this.details = details;
  }
}

function identifier(value, label) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new StillError(`${label} must be a UUID.`, 'INVALID_ARGUMENT');
  return value;
}

function milliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4294967295) throw new StillError(`${label} must be a positive integer below 4294967296.`, 'INVALID_ARGUMENT');
  return value;
}

/** Resolve the local capability file once; callers may supply an explicit token/baseUrl pair. */
export async function createClient(options = {}) {
  let connection = {};
  if (!options.baseUrl || !options.token) {
    try { connection = JSON.parse((await readFile(options.connectionFile || process.env.STILL_AGENT_CONNECTION || defaultConnection, 'utf8')).replace(/^\uFEFF/, '')); }
    catch { throw new StillError('Still connection file is unavailable. Start the local Still service first, or pass connectionFile.', 'NO_CONNECTION'); }
    if (connection.version !== 1) throw new StillError('This Still connection version is unsupported.', 'INVALID_CONNECTION');
  }
  const base = new URL(options.baseUrl || connection.baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/, '') !== '/api/agent') {
    throw new StillError('Still requires an HTTP loopback /api/agent endpoint.', 'INVALID_CONNECTION');
  }
  const baseUrl = base.href.replace(/\/$/, '');
  const token = options.token || connection.token;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new StillError('The Still connection token is missing or invalid.', 'INVALID_CONNECTION');
  let selectedSession = options.sessionId ? identifier(options.sessionId, 'sessionId') : undefined;
  const requestTimeout = milliseconds(options.requestTimeoutMs ?? 15000, 'requestTimeoutMs');
  const defaultTimeout = milliseconds(options.timeoutMs ?? 600000, 'timeoutMs');

  async function request(route, { method = 'GET', json, body, signal, binary = false } = {}) {
    const combined = AbortSignal.any([AbortSignal.timeout(requestTimeout), ...(signal ? [signal] : [])]);
    let response;
    try {
      response = await fetch(baseUrl + route, {
        method, redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        body: json !== undefined ? JSON.stringify(json) : body,
      });
      if (response.ok && binary) return new Uint8Array(await response.arrayBuffer());
      const payload = await response.json();
      if (!response.ok) throw new StillError(payload.error?.message || payload.message || `Still returned HTTP ${response.status}.`, payload.error?.code || 'HTTP_ERROR', { ...payload.error?.details, status: response.status });
      return payload;
    } catch (error) {
      if (error instanceof StillError) throw error;
      throw new StillError(signal?.aborted ? 'Still request was aborted.' : 'Still could not complete the local request. Start the service and check its connection file.', signal?.aborted ? 'ABORTED' : 'CONNECTION_ERROR');
    }
  }

  async function sessions({ signal } = {}) {
    const result = await request('/sessions', { signal });
    const rows = Array.isArray(result) ? result : result.sessions;
    if (!Array.isArray(rows)) throw new StillError('Still returned an invalid session list.', 'INVALID_RESPONSE');
    return rows;
  }
  async function chooseSession(value, signal) {
    if (value) return identifier(value, 'sessionId');
    if (selectedSession) return selectedSession;
    const rows = (await sessions({ signal })).filter(row => row.connected !== false);
    if (rows.length !== 1) throw new StillError(rows.length ? 'Multiple Still tabs are open. Pass the intended sessionId.' : 'Open Still in a browser before sending scene commands.', rows.length ? 'SESSION_REQUIRED' : 'NO_SESSION', { sessions: rows });
    selectedSession = identifier(rows[0].sessionId || rows[0].id, 'sessionId');
    return selectedSession;
  }
  async function enqueue(method, params = {}, settings = {}) {
    if (typeof method !== 'string' || !method || !params || typeof params !== 'object' || Array.isArray(params)) throw new StillError('Provide a method and a params object.', 'INVALID_ARGUMENT');
    const id = identifier(settings.id || randomUUID(), 'id');
    const sessionId = await chooseSession(settings.sessionId, settings.signal);
    const command = { id, sessionId, method, params };
    if (settings.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(settings.expectedRevision) || settings.expectedRevision < 0) throw new StillError('expectedRevision must be a nonnegative integer.', 'INVALID_ARGUMENT');
      command.expectedRevision = settings.expectedRevision;
    }
    try { return await request('/commands', { method: 'POST', json: command, signal: settings.signal }); }
    catch (error) { error.details = { ...error.details, jobId: id, sessionId }; throw error; }
  }
  const job = (id, settings = {}) => request('/commands/' + identifier(id, 'job id'), settings);
  const cancel = (id) => request('/commands/' + identifier(id, 'job id'), { method: 'DELETE' });
  async function wait(id, settings = {}) {
    identifier(id, 'job id');
    const timeoutMs = milliseconds(settings.timeoutMs ?? defaultTimeout, 'timeoutMs');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([timeout, ...(settings.signal ? [settings.signal] : [])]);
    let current;
    try {
      while (true) {
        current = await job(id, { signal });
        settings.onProgress?.(current);
        if (terminal.has(current.status)) break;
        await delay(400, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted) { error.details = { ...error.details, jobId: id }; throw error; }
      let cancelRequested = false;
      try { await cancel(id); cancelRequested = true; } catch { /* Job ID remains available for reconciliation. */ }
      throw new StillError(timeout.aborted ? 'Still command timed out; cancellation was requested.' : 'Still command was aborted; cancellation was requested.', timeout.aborted ? 'TIMEOUT' : 'ABORTED', { jobId: id, cancelRequested });
    }
    if (current.status !== 'done') throw new StillError(current.error?.message || `Still command ${current.status}.`, current.error?.code || current.status.toUpperCase(), { ...current.error?.details, jobId: id, status: current.status });
    return current.result;
  }
  async function call(method, params = {}, settings = {}) {
    milliseconds(settings.timeoutMs ?? defaultTimeout, 'timeoutMs');
    let queued;
    try { queued = await enqueue(method, params, settings); }
    catch (error) {
      if (settings.signal?.aborted && error.details?.jobId) {
        try { await cancel(error.details.jobId); error.details.cancelRequested = true; } catch { error.details.cancelRequested = false; }
      }
      throw error;
    }
    return wait(queued.id, settings);
  }
  async function uploadFile(filename, settings = {}) {
    const source = path.resolve(filename), info = await stat(source);
    if (!info.isFile() || info.size > 200 * 1024 * 1024) throw new StillError('Import a regular file of at most 200 MiB.', 'INVALID_FILE');
    const bytes = await readFile(source);
    return request('/files?name=' + encodeURIComponent(path.basename(source)), { method: 'POST', body: bytes, signal: settings.signal });
  }
  async function importFile(filename, settings = {}) {
    const file = await uploadFile(filename, settings);
    return call('scene.import', { fileId: file.fileId }, settings);
  }
  async function downloadFile(fileId, filename, settings = {}) {
    identifier(fileId, 'fileId');
    const destination = path.resolve(filename);
    const temporary = path.join(path.dirname(destination), `.still-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, await request('/files/' + fileId, { signal: settings.signal, binary: true }), { flag: 'wx' });
      // link is an atomic no-replace operation, including when another writer wins the race.
      if (settings.overwrite === true) await rename(temporary, destination);
      else await link(temporary, destination);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { path: destination, fileId };
  }
  async function exportFile(format, filename, settings = {}) {
    // Check an existing destination before running an expensive export; wx still prevents a later race.
    if (settings.overwrite !== true) {
      try { await stat(filename); throw new StillError('Export destination exists. Choose another path or pass overwrite: true.', 'FILE_EXISTS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const result = await call('export', { format, ...(settings.name !== undefined ? { name: settings.name } : {}), ...(settings.fps !== undefined ? { fps: settings.fps } : {}), ...(settings.rootMotion !== undefined ? { rootMotion: settings.rootMotion } : {}), ...(settings.retarget !== undefined ? { retarget: settings.retarget } : {}), ...(settings.targetMesh !== undefined ? { targetMesh: settings.targetMesh } : {}), ...(settings.targetSkeleton !== undefined ? { targetSkeleton: settings.targetSkeleton } : {}) }, settings);
    const file = result.file || result;
    const saved = await downloadFile(file.fileId, filename, settings);
    return { ...result, ...saved };
  }
  return { schema: (settings = {}) => request('/schema', settings), sessions, enqueue, job, wait, call, cancel, uploadFile, importFile, downloadFile, exportFile };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = [...argv], config = {}, settings = {};
  for (const [flag, key, target, convert] of [['--connection', 'connectionFile', config, String], ['--session', 'sessionId', config, String], ['--revision', 'expectedRevision', settings, Number], ['--timeout', 'timeoutMs', settings, Number], ['--id', 'id', settings, String]]) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      if (!args[index + 1]) throw new StillError(`${flag} requires a value.`, 'INVALID_ARGUMENT');
      target[key] = convert(args[index + 1]); args.splice(index, 2);
    }
  }
  const [action, ...values] = args;
  if (!action || ['--help', 'help'].includes(action)) {
    console.log('Still local agent CLI\n  sessions | schema | call METHOD JSON | enqueue METHOD JSON\n  job UUID | cancel UUID | import INPUT | export FORMAT OUTPUT\n  run SCRIPT.mjs [ARGS...]\nOptions: --connection FILE --session UUID --revision N --timeout MS --id UUID\nExports refuse existing paths. Script modules export default async (client, args).');
    return;
  }
  const client = await createClient(config);
  settings.sessionId = config.sessionId;
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  settings.signal = controller.signal;
  try {
    let result;
    if (action === 'sessions') result = await client.sessions(settings);
    else if (action === 'schema') result = await client.schema(settings);
    else if (action === 'call' || action === 'enqueue') {
      const json = values[1]?.startsWith('@') ? await readFile(values[1].slice(1), 'utf8') : values[1];
      result = await client[action](values[0], json ? JSON.parse(json.replace(/^\uFEFF/, '')) : {}, settings);
    }
    else if (action === 'job' || action === 'cancel') result = await client[action](values[0], settings);
    else if (action === 'import') result = await client.importFile(values[0], settings);
    else if (action === 'export') result = await client.exportFile(values[0], values[1], settings);
    else if (action === 'run') {
      const script = await import(pathToFileURL(path.resolve(values[0])).href);
      if (typeof script.default !== 'function') throw new StillError('A run script must export default async function (client, args).', 'INVALID_SCRIPT');
      result = await script.default(client, values.slice(1), settings);
    } else throw new StillError('Unknown CLI action. Run with --help.', 'INVALID_ARGUMENT');
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { console.error(JSON.stringify({ error: { code: error.code || 'ERROR', message: error.message, details: error.details } })); process.exitCode = 1; });
}
