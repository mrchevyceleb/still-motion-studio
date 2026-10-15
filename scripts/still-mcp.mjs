#!/usr/bin/env node
/** Minimal MCP stdio transport. Standard output contains JSON-RPC messages only. */
import { createClient } from './still-agent.mjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const string = { type: 'string', minLength: 1 };
const session = { ...string, description: 'Explicit Still browser session UUID. Required when more than one tab is open.' };
const shared = {
  sessionId: session,
  expectedRevision: { type: 'integer', minimum: 0, description: 'Reject this command if the scene revision changed.' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000, default: 600000 },
};
const tool = (name, description, properties = {}, required = [], readOnlyHint = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: false },
});
const tools = [
  tool('still_discover', 'Read the live Still method catalogue, parameter schemas, units, and limits before scripting commands.', {}, [], true),
  tool('still_sessions', 'List connected Still browser tabs. Select the intended session explicitly when multiple tabs are open.', {}, [], true),
  tool('still_inspect', 'Read the scene, revision, key metadata, providers, and view for one Still tab.', { sessionId: session }, [], true),
  tool('still_command', 'Run a method from still_discover. Set wait=false for a long job, then inspect it using still_job. Mutations affect the selected browser scene and may replace its character or animation.', {
    method: string, params: { type: 'object', default: {} }, ...shared,
    id: { ...string, description: 'Optional command UUID. Reuse this exact ID and payload to reconcile an uncertain submission; never retry a mutation with a fresh ID.' },
    wait: { type: 'boolean', default: true },
  }, ['method']),
  tool('still_job', 'Read an existing command job, including completion, error, cancellation, or result.', { id: string }, ['id'], true),
  tool('still_cancel', 'Request cancellation of a command job. Cancellation may remain pending while native cleanup finishes.', { id: string }, ['id']),
  tool('still_import_file', 'Upload a local FBX, GLB, or Still project file and import it into the selected tab. This replaces the scene. Server-side arbitrary paths are not accepted.', { path: string, ...shared }, ['path']),
  tool('still_export_file', 'Export the selected scene to a local file. Refuses an existing path unless overwrite=true. Unreal produces a ZIP; png captures the viewport.', {
    format: { type: 'string', enum: ['glb', 'still', 'unreal', 'png'] }, path: string,
    name: string, fps: { type: 'integer', enum: [24, 30, 60] }, overwrite: { type: 'boolean', default: false }, ...shared,
    rootMotion: { type: 'string', enum: ['preserve', 'extract', 'in-place'] }, retarget: { type: 'string', enum: ['none', 'manny', 'metahuman', 'skeleton'] }, targetMesh: string, targetSkeleton: string,
  }, ['format', 'path']),
];
const config = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = { '--connection': 'connectionFile', '--session': 'sessionId' }[process.argv[index]];
  if (!key || !process.argv[index + 1]) {
    process.stderr.write('Usage: node scripts/still-mcp.mjs [--connection FILE] [--session UUID]\n');
    process.exit(1);
  }
  config[key] = process.argv[index + 1];
}
let clientPromise;
const client = () => clientPromise ||= createClient(config).catch(error => { clientPromise = undefined; throw error; });
let initialized = false, ready = false, stopping = false;
const active = new Map();
const write = message => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n'); };
const response = (id, result) => write({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateArguments(definition, args) {
  if (!record(args)) throw new Error('Tool arguments must be an object.');
  const { properties, required } = definition.inputSchema;
  for (const name of required) if (args[name] === undefined) throw new Error(`Missing argument: ${name}.`);
  for (const [name, value] of Object.entries(args)) {
    const rule = properties[name];
    if (!rule) throw new Error(`Unknown argument: ${name}.`);
    const valid = rule.type === 'integer' ? Number.isSafeInteger(value) : rule.type === 'object' ? record(value) : typeof value === rule.type;
    if (!valid || (rule.minLength && value.length < rule.minLength) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum) || (rule.enum && !rule.enum.includes(value))) throw new Error(`Invalid argument: ${name}.`);
  }
}

async function runTool(message, controller) {
  const name = message.params?.name;
  const definition = tools.find(candidate => candidate.name === name);
  if (!definition) { rpcError(message.id, -32602, 'Unknown tool.'); return; }
  const args = message.params.arguments ?? {};
  try { validateArguments(definition, args); }
  catch (error) { rpcError(message.id, -32602, error.message); return; }
  const settings = { ...args, signal: controller.signal };
  let progressSignature = '', progress = 0;
  const progressToken = message.params?._meta?.progressToken;
  if (typeof progressToken === 'string' || typeof progressToken === 'number') settings.onProgress = job => {
    const signature = JSON.stringify([job.status, job.progress]);
    if (signature === progressSignature) return;
    progressSignature = signature;
    write({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: ++progress, message: `Still job ${job.id}: ${job.status}` } });
  };
  try {
    const sdk = await client();
    let result;
    if (name === 'still_discover') result = await sdk.schema(settings);
    else if (name === 'still_sessions') result = await sdk.sessions(settings);
    else if (name === 'still_inspect') result = await sdk.call('scene.inspect', {}, settings);
    else if (name === 'still_command') result = await sdk[args.wait === false ? 'enqueue' : 'call'](args.method, args.params || {}, settings);
    else if (name === 'still_job') result = await sdk.job(args.id, settings);
    else if (name === 'still_cancel') result = await sdk.cancel(args.id);
    else if (name === 'still_import_file') result = await sdk.importFile(args.path, settings);
    else if (name === 'still_export_file') result = await sdk.exportFile(args.format, args.path, settings);
    response(message.id, { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: false });
  } catch (error) {
    response(message.id, { content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code || 'ERROR', message: error.message, details: error.details } }) }], isError: true });
  }
}

async function handle(message) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { rpcError(null, -32600, 'Invalid JSON-RPC request.'); return; }
  const hasId = Object.hasOwn(message, 'id');
  if (!hasId) {
    if (message.method === 'notifications/initialized' && initialized) ready = true;
    else if (message.method === 'notifications/cancelled') active.get(message.params?.requestId)?.abort();
    return;
  }
  if (typeof message.id !== 'string' && (typeof message.id !== 'number' || !Number.isFinite(message.id))) { rpcError(null, -32600, 'Invalid request ID.'); return; }
  if (message.method === 'ping') { response(message.id, {}); return; }
  if (message.method === 'initialize') {
    if (initialized) { rpcError(message.id, -32600, 'Already initialized.'); return; }
    if (!record(message.params) || typeof message.params.protocolVersion !== 'string' || !record(message.params.capabilities) || !record(message.params.clientInfo)) { rpcError(message.id, -32602, 'Invalid initialization parameters.'); return; }
    initialized = true;
    response(message.id, { protocolVersion: versions.includes(message.params.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'still-local-agent', version: '1.0.0' }, instructions: 'Keep Still open in a browser. Discover its schema, list sessions, and select the intended tab. Read scene revision before mutations. File paths are local to this MCP process; exports refuse overwrites by default.' });
    return;
  }
  if (!ready) { rpcError(message.id, -32002, 'Initialize the MCP connection first.'); return; }
  if (message.method === 'tools/list') {
    if (message.params?.cursor) { rpcError(message.id, -32602, 'No additional tool pages exist.'); return; }
    response(message.id, { tools }); return;
  }
  if (message.method !== 'tools/call') { rpcError(message.id, -32601, 'Method not found.'); return; }
  if (active.has(message.id)) { rpcError(message.id, -32600, 'Request ID is already active.'); return; }
  const controller = new AbortController();
  active.set(message.id, controller);
  try { await runTool(message, controller); }
  finally { active.delete(message.id); }
}

let buffer = '', dropping = false;
const maxMessage = 16 * 1024 * 1024;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (stopping) return;
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (dropping) { dropping = false; continue; }
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > maxMessage) { rpcError(null, -32600, 'Message exceeds 16 MiB.'); continue; }
    let message;
    try { message = JSON.parse(line); }
    catch { rpcError(null, -32700, 'Parse error.'); continue; }
    void handle(message).catch(() => rpcError(message?.id ?? null, -32603, 'Internal error.'));
  }
  if (Buffer.byteLength(buffer) > maxMessage) { buffer = ''; dropping = true; rpcError(null, -32600, 'Message exceeds 16 MiB.'); }
});
function stop() {
  if (stopping) return;
  stopping = true;
  for (const controller of active.values()) controller.abort();
  process.stdin.destroy();
}
process.stdin.on('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdout.on('error', stop);
