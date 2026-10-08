export interface AgentCommand { id: string; method: string; params: Record<string, unknown>; expectedRevision?: number }
export interface AgentConnection { connected: boolean; sessionId?: string; error?: string }
export interface AgentFileReference { fileId: string; name: string; size: number; downloadUrl: string }
export interface AgentBridgeOptions {
  name: string;
  getState: () => unknown;
  execute: (command: AgentCommand, signal: AbortSignal) => unknown | Promise<unknown>;
  onConnection?: (connection: AgentConnection) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let token: string | null = null;
let bootstrap: Promise<string> | null = null;

class TransportError extends Error {
  constructor(message: string, readonly status = 0, readonly code = 'TRANSPORT_ERROR') { super(message); }
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

async function responseJSON(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  let body: unknown;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw new TransportError('The local agent service returned an invalid response.', response.status); }
  if (!object(body)) throw new TransportError('The local agent service returned an invalid response.', response.status);
  if (!response.ok) {
    const error = object(body.error) ? body.error : body;
    throw new TransportError(typeof error.message === 'string' ? error.message : typeof body.error === 'string' ? body.error : `Agent service request failed (${response.status}).`, response.status, typeof error.code === 'string' ? error.code : 'TRANSPORT_ERROR');
  }
  return body;
}

async function getToken(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!token) {
    // An effect cleanup must not cancel a bootstrap also used by the next mount.
    bootstrap ??= fetch('/api/agent/bootstrap', { signal: AbortSignal.timeout(8000), cache: 'no-store' }).then(responseJSON).then(body => {
      if (typeof body.token !== 'string' || !body.token) throw new TransportError('The agent service did not provide a session token.');
      token = body.token;
      return token;
    }).finally(() => { bootstrap = null; });
    await bootstrap;
  }
  signal?.throwIfAborted();
  return token!;
}

async function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const auth = await getToken(init.signal ?? undefined);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${auth}`);
  const response = await fetch(url, { ...init, headers, cache: 'no-store' });
  if (response.status === 401) token = null;
  return response;
}

async function jsonRequest(url: string, method: string, body: unknown, signal: AbortSignal) {
  return responseJSON(await authenticatedFetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function commandFrom(input: unknown): AgentCommand {
  if (!object(input) || typeof input.id !== 'string' || !input.id || typeof input.method !== 'string' || !input.method || (input.params !== undefined && !object(input.params)) || (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || Number(input.expectedRevision) < 0))) {
    throw new TransportError('The agent service supplied an invalid command.');
  }
  return { id: input.id, method: input.method, params: (input.params ?? {}) as Record<string, unknown>, ...(input.expectedRevision === undefined ? {} : { expectedRevision: Number(input.expectedRevision) }) };
}

/** One serial executor and an independent heartbeat/cancellation poll. No code evaluation. */
export function connectAgentBridge(options: AgentBridgeOptions): () => void {
  const lifetime = new AbortController();
  const seen = new Set<string>();
  let stopSession: (() => void) | null = null;
  let connected = false;
  const announce = (connection: AgentConnection) => { if (!lifetime.signal.aborted) options.onConnection?.(connection); };

  async function session() {
    await getToken(lifetime.signal);
    lifetime.signal.throwIfAborted();
    // Recover the registration ID even if StrictMode cleanup runs during this request.
    const registration = await jsonRequest('/api/agent/sessions', 'POST', { name: options.name, state: options.getState() }, AbortSignal.timeout(10000));
    if (typeof registration.id !== 'string' || !UUID.test(registration.id)) throw new TransportError('The agent service returned an invalid session ID.');
    const path = `/api/agent/sessions/${registration.id}`;
    const scope = new AbortController();
    const execution: { active: { id: string; controller: AbortController; work: Promise<void> } | null } = { active: null };
    let failure: unknown;
    const stop = () => { scope.abort(); execution.active?.controller.abort(); };
    stopSession = stop;
    const signal = AbortSignal.any([lifetime.signal, scope.signal]);

    const run = (command: AgentCommand) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const entry = { id: command.id, controller, work: Promise.resolve() };
      execution.active = entry;
      entry.work = (async () => {
        let outcome: Record<string, unknown>;
        try {
          controller.signal.throwIfAborted();
          if (seen.has(command.id)) throw new TransportError('This command ID has already been executed. Submit a new command after inspecting state.', 409, 'COMMAND_ALREADY_EXECUTED');
          seen.add(command.id);
          const result = await options.execute(command, controller.signal);
          // The dispatcher checks cancellation before committing. Once it returns,
          // preserve that successful result even if cancellation races the acknowledgement.
          outcome = { result: result === undefined ? null : result };
        } catch (error) {
          outcome = controller.signal.aborted || (object(error) && error.name === 'AbortError') ? { cancelled: true } : { error: { message: error instanceof Error ? error.message : 'The command failed.', ...(object(error) && typeof error.code === 'string' ? { code: error.code } : {}) } };
        }
        try {
          // Freeze acknowledgement and state: retries must never rerun the command.
          const acknowledgement = JSON.parse(JSON.stringify({ commandId: command.id, ...outcome, state: options.getState() }));
          let attempts = 0;
          while (!signal.aborted) {
            try {
              await jsonRequest(`${path}/result`, 'POST', acknowledgement, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
              break;
            } catch (error) {
              if (signal.aborted) break;
              if (error instanceof TransportError && error.status >= 400 && error.status < 500 && error.status !== 429) throw error;
              await delay(Math.min(5000, 500 * 2 ** Math.min(attempts++, 4)), signal);
            }
          }
        } catch (error) {
          if (!signal.aborted) { failure = error; stop(); }
        } finally {
          signal.removeEventListener('abort', abort);
          if (execution.active === entry) execution.active = null;
        }
      })();
    };

    try {
      signal.throwIfAborted();
      connected = true;
      announce({ connected: true, sessionId: registration.id });
      while (!signal.aborted) {
        const body = await jsonRequest(`${path}/poll`, 'POST', { ...(execution.active ? { activeCommandId: execution.active.id } : {}), state: options.getState() }, AbortSignal.any([signal, AbortSignal.timeout(25000)]));
        signal.throwIfAborted();
        if (Array.isArray(body.cancelIds) && execution.active && body.cancelIds.includes(execution.active.id)) execution.active.controller.abort();
        if (body.command !== undefined && body.command !== null) {
          const command = commandFrom(body.command);
          if (execution.active && execution.active.id !== command.id) throw new TransportError('The agent service sent overlapping commands. The session was stopped.');
          if (!execution.active) run(command);
        }
        // A server may answer immediately with state/cancellation; avoid a tight poll loop.
        await delay(30, signal);
      }
      if (failure) throw failure;
    } finally {
      connected = false;
      stop();
      announce({ connected: false, error: failure instanceof Error ? failure.message : 'Agent connection interrupted. Reconnecting…' });
      // Finish cooperative task cleanup before another session may execute anything.
      const work = execution.active?.work;
      const remove = jsonRequest(path, 'DELETE', undefined, AbortSignal.timeout(5000)).catch(() => {});
      await Promise.allSettled([work, remove]);
      if (stopSession === stop) stopSession = null;
    }
  }

  announce({ connected: false });
  void (async () => {
    let attempts = 0;
    while (!lifetime.signal.aborted) {
      try { await session(); attempts = 0; }
      catch (error) {
        if (lifetime.signal.aborted) break;
        announce({ connected: false, error: error instanceof Error ? error.message : 'The local agent service is unavailable.' });
      }
      try { await delay(Math.min(10000, 1000 * 2 ** Math.min(attempts++, 4)), lifetime.signal); } catch { break; }
    }
  })();

  return () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort(); stopSession?.();
    if (connected) options.onConnection?.({ connected: false });
  };
}

function fileReference(value: unknown): AgentFileReference {
  if (!object(value) || typeof value.fileId !== 'string' || !UUID.test(value.fileId) || typeof value.name !== 'string' || typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0 || value.downloadUrl !== `/api/agent/files/${value.fileId}`) {
    throw new Error('The agent service returned an invalid file reference.');
  }
  return value as unknown as AgentFileReference;
}

export async function uploadAgentFile(blob: Blob, name: string, signal?: AbortSignal): Promise<AgentFileReference> {
  signal?.throwIfAborted();
  if (!(blob instanceof Blob) || !name.trim()) throw new Error('Provide a file and a filename.');
  const response = await authenticatedFetch(`/api/agent/files?${new URLSearchParams({ name })}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  return fileReference(await responseJSON(response));
}

export async function downloadAgentFile(reference: string | AgentFileReference, signal?: AbortSignal): Promise<File> {
  signal?.throwIfAborted();
  const id = typeof reference === 'string' ? reference : fileReference(reference).fileId;
  if (!UUID.test(id)) throw new Error('Use an agent file ID, not an external URL or filesystem path.');
  const response = await authenticatedFetch(`/api/agent/files/${id}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  if (!response.ok) await responseJSON(response);
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  let headerName = quotedName;
  if (encodedName) {
    try { headerName = decodeURIComponent(encodedName); } catch { throw new Error('The staged filename is invalid. Upload the file again.'); }
  }
  const name = typeof reference === 'string' ? headerName || 'agent-file' : reference.name;
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}
