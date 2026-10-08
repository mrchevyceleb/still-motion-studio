import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const DAY = 86400000;
const STALE = 60000;
const TIMEOUT = 900000;
const CANCEL_GRACE = 30000;
const BODY_LIMIT = 200 * 1024 * 1024;
const FILE_QUOTA = 2 * 1024 * 1024 * 1024;
const JOB_QUOTA = 512 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
const errorObject = error => ({ code: error.code || 'INTERNAL_ERROR', message: error instanceof ApiError ? error.message : 'The local agent service could not complete this request.', ...(error.details ? { details: error.details } : {}) });
const uuid = value => typeof value === 'string' && UUID.test(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = BODY_LIMIT) {
  if (Number(req.headers['content-length']) > limit) fail(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit} bytes.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'BODY_TOO_LARGE', `Request body exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'INVALID_JSON', 'Send a valid JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON', 'Send a JSON object.');
  return value;
}

function fields(value, allowed, required = []) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(400, 'INVALID_PARAMS', `Unknown property: ${key}.`);
  for (const key of required) if (!(key in value)) fail(400, 'INVALID_PARAMS', `Missing property: ${key}.`);
}

/** JSON Schema subset used by the published contract; rejects rather than coerces. */
function validate(value, rule, schema, location = 'params', depth = 0) {
  if (depth > 40) fail(400, 'INVALID_PARAMS', `${location} is nested too deeply.`);
  if (rule.$ref) {
    if (!rule.$ref.startsWith('#/$defs/')) throw new Error('Unsupported schema reference.');
    return validate(value, schema.$defs[rule.$ref.slice(8)], schema, location, depth + 1);
  }
  const matches = candidate => { try { validate(value, candidate, schema, location, depth + 1); return true; } catch (e) { if (e instanceof ApiError) return false; throw e; } };
  if (rule.oneOf && rule.oneOf.filter(matches).length !== 1) fail(400, 'INVALID_PARAMS', `${location} must match exactly one allowed shape.`);
  if (rule.anyOf && !rule.anyOf.some(matches)) fail(400, 'INVALID_PARAMS', `${location} is missing a required edit.`);
  if (rule.not && matches(rule.not)) fail(400, 'INVALID_PARAMS', `${location} contains mutually exclusive properties.`);
  if ('const' in rule && value !== rule.const) fail(400, 'INVALID_PARAMS', `${location} must equal ${JSON.stringify(rule.const)}.`);
  if (rule.enum && !rule.enum.includes(value)) fail(400, 'INVALID_PARAMS', `${location} must be one of: ${rule.enum.join(', ')}.`);
  const type = rule.type;
  if (type && !(type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type)) fail(400, 'INVALID_PARAMS', `${location} must be ${type}.`);
  if (typeof value === 'number' && (!Number.isFinite(value) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum))) fail(400, 'INVALID_PARAMS', `${location} is outside its allowed range.`);
  if (typeof value === 'string' && ((rule.minLength !== undefined && value.length < rule.minLength) || (rule.maxLength !== undefined && value.length > rule.maxLength) || (rule.pattern && !new RegExp(rule.pattern).test(value)))) fail(400, 'INVALID_PARAMS', `${location} has an invalid length or format.`);
  if (Array.isArray(value)) {
    if ((rule.minItems !== undefined && value.length < rule.minItems) || (rule.maxItems !== undefined && value.length > rule.maxItems)) fail(400, 'INVALID_PARAMS', `${location} has an invalid number of items.`);
    if (rule.items) value.forEach((entry, i) => validate(entry, rule.items, schema, `${location}[${i}]`, depth + 1));
  } else if (value && typeof value === 'object') {
    if (rule.minProperties !== undefined && Object.keys(value).length < rule.minProperties) fail(400, 'INVALID_PARAMS', `${location} must contain an edit.`);
    for (const key of rule.required || []) if (!(key in value)) fail(400, 'INVALID_PARAMS', `${location}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(rule.properties || {}, key)) validate(item, rule.properties[key], schema, `${location}.${key}`, depth + 1);
      else if (rule.additionalProperties === false) fail(400, 'INVALID_PARAMS', `Unknown property: ${location}.${key}.`);
    }
  }
}

export function createAgentService({ root, port }) {
  const directory = path.resolve(root, '.local', 'agent');
  const fileDirectory = path.join(directory, 'files');
  const journalDirectory = path.join(directory, 'commands');
  const sessions = new Map();
  const jobs = new Map();
  const identities = new Map();
  const files = new Map();
  let token, schema, stopping = false, uploadReservations = 0, activeUploads = 0;
  let serialized = Promise.resolve();
  const mutate = operation => { const task = serialized.then(operation); serialized = task.catch(() => {}); return task; };
  const now = () => Date.now();
  const filePath = id => path.join(fileDirectory, `${id}.bin`);
  const journalPath = id => path.join(journalDirectory, `${id}.json`);
  const publicFile = f => ({ fileId: f.id, name: f.name, size: f.size, mime: f.mime, downloadUrl: `/api/agent/files/${f.id}` });
  const publicSession = s => ({ id: s.id, name: s.name, connected: !s.closed && now() - s.lastSeen <= STALE, createdAt: s.createdAt, lastSeen: s.lastSeen, state: s.state, ...(s.active ? { activeCommandId: s.active } : {}) });
  const publicJob = j => ({ id: j.id, sessionId: j.sessionId, method: j.method, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt, ...(j.expectedRevision !== undefined ? { expectedRevision: j.expectedRevision } : {}), ...(j.cancelRequested ? { cancelRequested: true } : {}), ...(j.status === 'done' ? { result: j.result } : {}), ...(j.error ? { error: j.error } : {}), ...(j.status === 'cancelled' ? { cancelled: true } : {}) });

  async function atomic(filename, value) {
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, filename); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async function ownDirectory(target) {
    await mkdir(target, { recursive: true });
    if ((await realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase() || (await lstat(target)).isSymbolicLink()) throw new Error('Agent staging must not be redirected.');
  }

  async function persist(job) {
    const record = { id: job.id, payloadHash: job.payloadHash, sessionId: job.sessionId, method: job.method,
      status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, dispatched: !!job.dispatched,
      fileIds: [...job.fileIds], ...(job.expectedRevision !== undefined ? { expectedRevision: job.expectedRevision } : {}),
      ...(job.error ? { error: job.error } : {}), ...(job.ackHash ? { ackHash: job.ackHash } : {}) };
    await atomic(journalPath(job.id), record);
    identities.set(job.id, record);
  }

  function compactState(state) {
    if (state === undefined) return undefined;
    if (!state || typeof state !== 'object' || Array.isArray(state) || bytes(state) > 256 * 1024) fail(400, 'INVALID_STATE', 'Session state must be a compact JSON object of at most 256 KiB.');
    return state;
  }

  function referencedFileIds(value, found = new Set(), depth = 0) {
    if (depth > 40 || !value || typeof value !== 'object') return found;
    if (typeof value.fileId === 'string' && uuid(value.fileId)) found.add(value.fileId.toLowerCase());
    for (const item of Object.values(value)) if (item && typeof item === 'object') referencedFileIds(item, found, depth + 1);
    return found;
  }

  function finishPoll(session, payload, status = 200) {
    const poll = session.poll;
    if (!poll) return;
    session.poll = null;
    clearTimeout(poll.timer);
    json(poll.res, status, payload);
  }

  async function terminal(job, status, error) {
    job.status = status;
    job.updatedAt = now();
    if (error) job.error = error;
    await persist(job);
  }

  async function closeSession(session, reason) {
    session.closed = true;
    session.closedAt = now();
    for (const id of session.queue.splice(0)) {
      const job = jobs.get(id);
      if (job && job.status === 'queued') await terminal(job, 'error', { code: 'SESSION_DISCONNECTED', message: reason, details: { uncertain: false } });
    }
    const active = jobs.get(session.active);
    if (active && !TERMINAL.has(active.status)) {
      active.cancelRequested = true;
      active.cancelAt ||= now();
      active.cancelReason = 'SESSION_DISCONNECTED';
      active.updatedAt = now();
      await persist(active);
    }
    finishPoll(session, { cancelIds: active ? [active.id] : [] });
  }

  async function dispatch(session) {
    if (!session?.poll) return;
    const active = jobs.get(session.active);
    if (active) {
      if (active.cancelRequested) finishPoll(session, { cancelIds: [active.id] });
      return;
    }
    // The browser may still be waiting for its POST /result response. Do not
    // lease new work to a poll that was sent while the previous job was active.
    if (session.poll.activeCommandId) return finishPoll(session, { cancelIds: [] });
    if (session.closed) return finishPoll(session, { error: { code: 'SESSION_EXPIRED', message: 'Register a new browser session.' } }, 410);
    while (session.queue.length) {
      const job = jobs.get(session.queue.shift());
      if (!job || job.status !== 'queued') continue;
      job.status = 'running'; job.updatedAt = now(); job.dispatched = true; job.startedAt = now();
      session.active = job.id;
      // The response now belongs to this lease. Its idle timeout must not send
      // an empty response while the journal write is still awaiting the disk.
      clearTimeout(session.poll.timer);
      // Persist the lease before returning it. A dropped response is never retried.
      await persist(job);
      finishPoll(session, { command: { id: job.id, method: job.method, params: job.params, ...(job.expectedRevision !== undefined ? { expectedRevision: job.expectedRevision } : {}) }, cancelIds: [] });
      return;
    }
  }

  function memoryBytes() { return [...jobs.values()].reduce((sum, job) => sum + (job.memoryBytes || 0), 0); }
  function makeRoom(required = 0, except) {
    const candidates = [...jobs.values()].filter(j => TERMINAL.has(j.status) && j.id !== except && ![...sessions.values()].some(s => s.active === j.id)).sort((a, b) => a.updatedAt - b.updatedAt);
    const slots = except ? 0 : 1;
    while ((jobs.size + slots > 512 || memoryBytes() + required > JOB_QUOTA) && candidates.length) jobs.delete(candidates.shift().id);
    if (jobs.size + slots > 512 || memoryBytes() + required > JOB_QUOTA) fail(429, 'COMMAND_CAPACITY', 'The agent command buffer is full. Wait for active jobs to finish; use file-backed imports for large projects.');
  }

  const ready = (async () => {
    await ownDirectory(directory); await ownDirectory(fileDirectory); await ownDirectory(journalDirectory);
    schema = JSON.parse(await readFile(path.join(root, 'shared', 'agent-schema.json'), 'utf8'));
    const connectionPath = path.join(directory, 'connection.json');
    try {
      if ((await lstat(connectionPath)).isSymbolicLink()) throw new Error('Redirected agent connection file.');
      const old = JSON.parse(await readFile(connectionPath, 'utf8'));
      if (/^[0-9a-f]{64}$/.test(old.token || '')) token = old.token;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    token ||= crypto.randomBytes(32).toString('hex');
    await atomic(connectionPath, { version: 1, baseUrl: `http://127.0.0.1:${port}/api/agent`, token });
    for (const entry of await readdir(fileDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid(entry.name.slice(0, -5))) continue;
      try {
        const f = JSON.parse(await readFile(path.join(fileDirectory, entry.name), 'utf8'));
        if (!uuid(f.id) || f.id !== entry.name.slice(0, -5) || !Number.isFinite(f.size) || f.size < 0 || f.size > BODY_LIMIT) continue;
        const info = await lstat(filePath(f.id));
        if (info.isFile() && !info.isSymbolicLink() && info.size === f.size) files.set(f.id, f);
      } catch { /* An interrupted upload never becomes a downloadable file. */ }
    }
    for (const entry of await readdir(journalDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !uuid(entry.name.slice(0, -5))) continue;
      const record = JSON.parse(await readFile(path.join(journalDirectory, entry.name), 'utf8'));
      if (record.id !== entry.name.slice(0, -5) || !/^[0-9a-f]{64}$/.test(record.payloadHash || '')) throw new Error('An agent command journal is damaged. It must be inspected before commands can safely resume.');
      identities.set(record.id, record);
      if (now() - record.updatedAt > DAY) continue;
      const job = { ...record, status: 'error', fileIds: new Set(record.fileIds || []), memoryBytes: 1024,
        error: { code: TERMINAL.has(record.status) ? 'RESULT_EXPIRED' : 'SERVICE_RESTARTED', message: 'This command was recorded before the service restarted. Its execution will not be retried; inspect the browser scene before issuing a new mutation.', details: { uncertain: record.dispatched, previousStatus: record.status } } };
      if (record.status === 'cancelled') { job.status = 'cancelled'; delete job.error; }
      if (jobs.size < 512) jobs.set(job.id, job);
    }
  })();
  // handle() reports initialization failures; avoid an unhandled rejection if
  // the engine starts before the first agent request arrives.
  ready.catch(() => {});

  async function sweep() {
    for (const session of sessions.values()) {
      if (!session.closed && now() - session.lastSeen > STALE) await closeSession(session, 'The browser session stopped responding. No queued command was executed.');
      if (session.closed && now() - session.closedAt > 300000 && (!session.active || TERMINAL.has(jobs.get(session.active)?.status))) sessions.delete(session.id);
    }
    for (const job of jobs.values()) {
      if (TERMINAL.has(job.status)) continue;
      if (job.status === 'queued' && now() - job.createdAt > TIMEOUT) await terminal(job, 'error', { code: 'COMMAND_TIMEOUT', message: 'The queued command expired before execution.', details: { uncertain: false } });
      if (job.status === 'running' && now() - job.startedAt > TIMEOUT && !job.cancelRequested) {
        job.cancelRequested = true; job.cancelAt = now(); job.cancelReason = 'COMMAND_TIMEOUT';
        await persist(job); await dispatch(sessions.get(job.sessionId));
      }
      if (job.status === 'running' && job.cancelRequested && now() - job.cancelAt > CANCEL_GRACE) await terminal(job, 'error', {
        code: 'COMPLETION_UNKNOWN', message: 'The browser did not acknowledge cancellation. The command may have changed the scene; it will not be retried.', details: { uncertain: true, reason: job.cancelReason || 'CANCEL_REQUESTED' },
      });
    }
    for (const [id, record] of identities) {
      const job = jobs.get(id);
      if (now() - record.updatedAt <= DAY || (job && !TERMINAL.has(job.status)) || [...sessions.values()].some(s => s.active === id)) continue;
      identities.delete(id); jobs.delete(id); await unlink(journalPath(id)).catch(() => {});
    }
    const protectedFiles = new Set([...identities.values()].flatMap(record => record.fileIds || []));
    for (const session of sessions.values()) for (const id of referencedFileIds(session.state)) protectedFiles.add(id);
    for (const [id, file] of files) {
      if (now() - file.lastAccess <= DAY || protectedFiles.has(id)) continue;
      await unlink(filePath(id)).catch(() => {});
      await unlink(path.join(fileDirectory, id + '.json')).catch(() => {});
      files.delete(id);
    }
  }
  const timer = setInterval(() => { if (!stopping) ready.then(() => mutate(sweep)).catch(() => {}); }, 5000);
  timer.unref();

  async function handle(req, res, url) {
    const pathname = url.pathname;
    if (pathname !== '/api/agent' && !pathname.startsWith('/api/agent/')) return false;
    try {
      await ready;
      if (stopping) fail(503, 'SERVICE_STOPPING', 'The local agent service is stopping.');
      const suffix = pathname.slice('/api/agent'.length) || '/';
      if (suffix === '/bootstrap' && req.method === 'GET') {
        if (req.headers['sec-fetch-site'] !== 'same-origin') fail(403, 'BROWSER_ONLY', 'Bootstrap is available only to the same-origin application browser. Local agents read connection.json.');
        json(res, 200, { version: 1, token }); return true;
      }
      const authorization = req.headers.authorization || '';
      const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const suppliedBytes = Buffer.from(supplied), tokenBytes = Buffer.from(token);
      if (suppliedBytes.length !== tokenBytes.length || !crypto.timingSafeEqual(suppliedBytes, tokenBytes)) fail(401, 'UNAUTHORIZED', 'A valid local agent bearer token is required.');
      if (suffix === '/schema' && req.method === 'GET') { json(res, 200, schema); return true; }
      if ((suffix === '/' || suffix === '/health') && req.method === 'GET') { json(res, 200, { version: 1, ready: true, sessions: [...sessions.values()].filter(s => !s.closed && now() - s.lastSeen <= STALE).length }); return true; }
      if (suffix === '/sessions' && req.method === 'GET') { json(res, 200, { sessions: [...sessions.values()].map(publicSession) }); return true; }
      if (suffix === '/sessions' && req.method === 'POST') {
        const data = await body(req, 300 * 1024); fields(data, ['name', 'state'], ['name']);
        validate(data.name, schema.$defs.name, schema, 'name'); const state = compactState(data.state) || {};
        await mutate(async () => {
          if (sessions.size >= 64 || [...sessions.values()].filter(s => !s.closed).length >= 16) fail(429, 'SESSION_CAPACITY', 'Too many browser sessions. Disconnect an unused session or wait for closed sessions to expire.');
          const session = { id: crypto.randomUUID(), name: data.name, state, createdAt: now(), lastSeen: now(), queue: [], active: null, closed: false, poll: null };
          sessions.set(session.id, session); json(res, 201, publicSession(session));
        }); return true;
      }
      const sessionMatch = suffix.match(/^\/sessions\/([^/]+)(?:\/(poll|result))?$/);
      if (sessionMatch) {
        const id = sessionMatch[1].toLowerCase();
        if (!uuid(id) || !sessions.has(id)) fail(404, 'SESSION_NOT_FOUND', 'This browser session is unavailable. Register a new session.');
        const session = sessions.get(id), action = sessionMatch[2];
        if (!action && req.method === 'DELETE') { await mutate(async () => { await closeSession(session, 'The browser session was disconnected.'); json(res, 200, publicSession(session)); }); return true; }
        if (action === 'poll' && req.method === 'POST') {
          const data = await body(req, 300 * 1024); fields(data, ['activeCommandId', 'state']);
          if (data.activeCommandId !== undefined && !uuid(data.activeCommandId)) fail(400, 'INVALID_PARAMS', 'activeCommandId must be a UUID.');
          const state = compactState(data.state);
          await mutate(async () => {
            if (session.closed && !session.active) fail(410, 'SESSION_EXPIRED', 'Register a new browser session.');
            if (session.poll) fail(409, 'POLL_ALREADY_ACTIVE', 'Only one long poll may be active for a browser session.');
            const activeCommandId = data.activeCommandId?.toLowerCase();
            if (activeCommandId && activeCommandId !== session.active) {
              const previous = jobs.get(activeCommandId);
              if (previous?.sessionId !== session.id || !previous.ackHash || !TERMINAL.has(previous.status)) fail(409, 'ACTIVE_COMMAND_MISMATCH', 'The browser active command does not match its leased command. Do not rerun it.');
            }
            session.lastSeen = now(); if (state) session.state = state;
            const poll = { res, timer: null, activeCommandId };
            session.poll = poll;
            poll.timer = setTimeout(() => { if (session.poll === poll) finishPoll(session, { cancelIds: jobs.get(session.active)?.cancelRequested ? [session.active] : [] }); }, 15000);
            res.on('close', () => { if (session.poll === poll) { clearTimeout(poll.timer); session.poll = null; } });
            await dispatch(session);
          }); return true;
        }
        if (action === 'result' && req.method === 'POST') {
          const data = await body(req); fields(data, ['commandId', 'result', 'error', 'cancelled', 'state'], ['commandId']);
          if (!uuid(data.commandId)) fail(400, 'INVALID_PARAMS', 'commandId must be a UUID.');
          if (Number(Object.hasOwn(data, 'result')) + Number(Object.hasOwn(data, 'error')) + Number(data.cancelled === true) !== 1 || (Object.hasOwn(data, 'cancelled') && data.cancelled !== true)) fail(400, 'INVALID_RESULT', 'Send exactly one of result, error, or cancelled:true.');
          if (Object.hasOwn(data, 'result') && (!data.result || typeof data.result !== 'object' || Array.isArray(data.result))) fail(400, 'INVALID_RESULT', 'result must be a JSON object.');
          if (Object.hasOwn(data, 'error') && (!data.error || typeof data.error !== 'object' || typeof data.error.message !== 'string' || data.error.message.length > 8192)) fail(400, 'INVALID_RESULT', 'error must include a message of at most 8192 characters.');
          const state = compactState(data.state), resultHash = hash({ result: data.result ?? null, error: data.error ?? null, cancelled: data.cancelled === true });
          await mutate(async () => {
            const job = jobs.get(data.commandId.toLowerCase());
            if (!job || job.sessionId !== id) fail(404, 'COMMAND_NOT_FOUND', 'This command does not belong to the browser session.');
            if (job.ackHash && job.ackHash !== resultHash) fail(409, 'RESULT_CONFLICT', 'This command already has a different terminal acknowledgement.');
            if (!job.dispatched) fail(409, 'COMMAND_NOT_DISPATCHED', 'This command was never dispatched to the browser.');
            session.lastSeen = now(); if (state) session.state = state;
            if (!job.ackHash) {
              if (!TERMINAL.has(job.status)) {
                const size = bytes(data.result ?? data.error ?? {}) + bytes(job.params || {});
                makeRoom(size - (job.memoryBytes || 0), job.id);
                job.memoryBytes = size;
                job.result = data.result;
                job.error = data.error ? { code: String(data.error.code || 'COMMAND_FAILED'), message: data.error.message, ...(data.error.details ? { details: data.error.details } : {}) } : undefined;
                for (const fileId of referencedFileIds(data.result)) job.fileIds.add(fileId);
                job.status = data.cancelled ? 'cancelled' : data.error ? 'error' : 'done';
              }
              job.ackHash = resultHash;
              job.updatedAt = now();
            }
            await persist(job);
            if (session.active === job.id) session.active = null;
            json(res, 200, { accepted: true, commandId: job.id, status: job.status }); await dispatch(session);
          }); return true;
        }
        fail(405, 'METHOD_NOT_ALLOWED', 'Unsupported session operation.');
      }
      if (suffix === '/commands' && req.method === 'POST') {
        const data = await body(req); fields(data, ['id', 'sessionId', 'method', 'params', 'expectedRevision'], ['method']);
        if ((data.id !== undefined && !uuid(data.id)) || (data.sessionId !== undefined && !uuid(data.sessionId))) fail(400, 'INVALID_PARAMS', 'id and sessionId must be UUIDs.');
        if (data.expectedRevision !== undefined && (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0)) fail(400, 'INVALID_PARAMS', 'expectedRevision must be a nonnegative safe integer.');
        if (typeof data.method !== 'string' || !Object.hasOwn(schema.methods, data.method)) fail(400, 'UNKNOWN_METHOD', 'Unknown command method. Read GET /api/agent/schema for supported commands.');
        const params = data.params ?? {}; validate(params, schema.methods[data.method].paramsSchema, schema);
        const commandId = (data.id || crypto.randomUUID()).toLowerCase();
        const payloadHash = hash({ sessionId: data.sessionId?.toLowerCase() ?? null, method: data.method, params, expectedRevision: data.expectedRevision ?? null });
        await mutate(async () => {
          if (identities.has(commandId)) {
            const record = identities.get(commandId);
            if (record.payloadHash !== payloadHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This command ID was already used with a different payload.');
            if (!jobs.has(commandId)) fail(410, 'RESULT_EXPIRED', 'This command was already recorded but its result is no longer retained. It will not be executed again. Inspect the scene before creating another command.', { previousStatus: record.status, uncertain: !!record.dispatched && !TERMINAL.has(record.status) });
            json(res, 202, publicJob(jobs.get(commandId))); return;
          }
          const connected = [...sessions.values()].filter(s => !s.closed && now() - s.lastSeen <= STALE);
          let session = data.sessionId ? sessions.get(data.sessionId.toLowerCase()) : connected.length === 1 ? connected[0] : null;
          if (!session || session.closed || now() - session.lastSeen > STALE) fail(409, connected.length > 1 && !data.sessionId ? 'AMBIGUOUS_SESSION' : 'NO_CONNECTED_SESSION', connected.length > 1 && !data.sessionId ? 'More than one browser session is connected. Supply sessionId from GET /sessions.' : 'Open the application and connect its agent bridge, or select a live sessionId.', { sessions: connected.map(publicSession) });
          if (session.active && TERMINAL.has(jobs.get(session.active)?.status)) fail(409, 'SESSION_RECONCILIATION_REQUIRED', 'The previous command has no browser acknowledgement. Refresh/reconnect the browser before issuing another command.', { commandId: session.active, uncertain: true });
          if (session.queue.length >= 64) fail(429, 'QUEUE_FULL', 'This browser session already has 64 queued commands.');
          if (identities.size >= 10000) fail(429, 'IDENTITY_CAPACITY', 'The command identity journal is full. Old identities expire after 24 hours.');
          const fileIds = referencedFileIds(params);
          for (const fileId of fileIds) if (!files.has(fileId)) fail(404, 'FILE_NOT_FOUND', `Uploaded file ${fileId} is unavailable. Upload it before queueing the command.`);
          const memory = bytes(params); makeRoom(memory);
          const job = { id: commandId, payloadHash, sessionId: session.id, method: data.method, params, expectedRevision: data.expectedRevision, status: 'queued', createdAt: now(), updatedAt: now(), fileIds, memoryBytes: memory };
          await persist(job); jobs.set(job.id, job); session.queue.push(job.id);
          json(res, 202, publicJob(job)); await dispatch(session);
        }); return true;
      }
      const commandMatch = suffix.match(/^\/commands\/([^/]+)$/);
      if (commandMatch) {
        const id = commandMatch[1].toLowerCase(), job = uuid(id) ? jobs.get(id) : null;
        if (!job) fail(identities.has(id) ? 410 : 404, identities.has(id) ? 'RESULT_EXPIRED' : 'COMMAND_NOT_FOUND', identities.has(id) ? 'The command was already recorded and will not be executed again; its result has expired.' : 'No command with this ID was recorded.');
        if (req.method === 'GET') { json(res, 200, publicJob(job)); return true; }
        if (req.method === 'DELETE') {
          await mutate(async () => {
            if (job.status === 'queued') { await terminal(job, 'cancelled'); const session = sessions.get(job.sessionId); if (session) session.queue = session.queue.filter(value => value !== id); }
            else if (job.status === 'running') { job.cancelRequested = true; job.cancelAt ||= now(); job.updatedAt = now(); await persist(job); await dispatch(sessions.get(job.sessionId)); }
            json(res, 200, publicJob(job));
          }); return true;
        }
      }
      if (suffix === '/files' && req.method === 'POST') {
        const name = path.posix.basename((url.searchParams.get('name') || 'upload.bin').replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_').slice(0, 200) || 'upload.bin';
        const mime = /^[\w.+-]+\/[\w.+-]+(?:;[\x20-\x7e]*)?$/.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
        const claimed = Number(req.headers['content-length']);
        if (Number.isFinite(claimed) && claimed > BODY_LIMIT) fail(413, 'FILE_TOO_LARGE', 'Files must be at most 200 MiB.');
        const reservation = Number.isFinite(claimed) && claimed >= 0 ? claimed : BODY_LIMIT;
        await mutate(async () => {
          if (files.size + activeUploads >= 128 || [...files.values()].reduce((sum, f) => sum + f.size, 0) + uploadReservations + reservation > FILE_QUOTA) fail(507, 'FILE_CAPACITY', 'Local agent staging is full. Referenced files are preserved; unreferenced files expire after 24 hours.');
          uploadReservations += reservation;
          activeUploads += 1;
        });
        const id = crypto.randomUUID(), temporary = path.join(fileDirectory, id + '.part');
        let destination, size = 0;
        try {
          destination = await open(temporary, 'wx', 0o600);
          for await (const chunk of req) {
            size += chunk.length;
            if (size > BODY_LIMIT || size > reservation) fail(413, 'FILE_TOO_LARGE', 'Upload exceeds its declared length or the 200 MiB file limit.');
            let offset = 0;
            while (offset < chunk.length) { const result = await destination.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
          }
          await destination.close(); destination = null;
          if (Number.isFinite(claimed) && size !== claimed) fail(400, 'INCOMPLETE_UPLOAD', 'The upload ended before its declared length.');
          await rename(temporary, filePath(id));
          const file = { id, name, size, mime, createdAt: now(), lastAccess: now() };
          await atomic(path.join(fileDirectory, id + '.json'), file);
          await mutate(async () => { files.set(id, file); json(res, 201, publicFile(file)); });
        } catch (error) { await destination?.close().catch(() => {}); await unlink(temporary).catch(() => {}); await unlink(filePath(id)).catch(() => {}); throw error; }
        finally { await mutate(async () => { uploadReservations -= reservation; activeUploads -= 1; }); }
        return true;
      }
      const fileMatch = suffix.match(/^\/files\/([^/]+)$/);
      if (fileMatch && req.method === 'GET') {
        const id = fileMatch[1].toLowerCase(), file = uuid(id) ? files.get(id) : null;
        if (!file) fail(404, 'FILE_NOT_FOUND', 'This uploaded or exported file is unavailable.');
        const info = await lstat(filePath(id));
        if (!info.isFile() || info.isSymbolicLink()) fail(404, 'FILE_NOT_FOUND', 'The staged file is unavailable.');
        file.lastAccess = now(); await atomic(path.join(fileDirectory, id + '.json'), file);
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}` });
        const stream = createReadStream(filePath(id)); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
      }
      fail(404, 'ROUTE_NOT_FOUND', 'Unknown agent API route. Read GET /api/agent/schema.');
    } catch (error) { json(res, error instanceof ApiError ? error.status : 500, { error: errorObject(error) }); return true; }
  }

  async function stop() {
    stopping = true; clearInterval(timer);
    await ready.catch(() => {});
    await mutate(async () => {
      for (const session of sessions.values()) finishPoll(session, { error: { code: 'SERVICE_STOPPING', message: 'The local service is stopping. Leased commands will not be retried.' } }, 503);
      for (const job of jobs.values()) if (!TERMINAL.has(job.status)) await terminal(job, 'error', { code: 'SERVICE_STOPPED', message: 'The service stopped before completion acknowledgement. Inspect the scene; this command will not be retried.', details: { uncertain: !!job.dispatched } });
    });
  }
  return { handle, stop };
}
