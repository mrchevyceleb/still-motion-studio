import { Readable } from 'node:stream';

const base = 'https://api.meshy.ai/openapi/v1';
const taskTypes = new Set(['rigging', 'animations', 'text-to-motion']);
const idPattern = /^[a-zA-Z0-9-]{8,80}$/;
const maxCharacterBytes = 100 * 1024 * 1024;

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function jsonBody(req, max = 140 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('The character upload exceeds 100 MB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function upstream(key, path, method = 'GET', payload) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(method === 'POST' ? 120000 : 30000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = result.message || result.error || result.detail || `Meshy returned ${response.status}.`;
    const error = new Error(typeof description === 'string' ? description.slice(0, 300) : `Meshy returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function upstreamRigging(key, req) {
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxCharacterBytes) throw new Error('Upload a GLB character smaller than 100 MB.');
  const prefix = '{"model_url":"data:model/gltf-binary;base64,';
  const suffix = '"}';
  async function* encoded() {
    yield prefix;
    let count = 0;
    let carry = Buffer.alloc(0);
    let header = Buffer.alloc(0);
    for await (const chunk of req) {
      count += chunk.length;
      if (count > maxCharacterBytes) throw new Error('The character upload exceeds 100 MB.');
      if (header.length < 4) {
        header = Buffer.concat([header, chunk.subarray(0, 4 - header.length)]);
        if (header.length === 4 && header.toString('ascii') !== 'glTF') throw new Error('Upload a binary GLB file.');
      }
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = bytes.length - bytes.length % 3;
      if (whole) yield bytes.subarray(0, whole).toString('base64');
      carry = bytes.subarray(whole);
    }
    if (count !== size || header.length !== 4) throw new Error('The character upload was incomplete.');
    if (carry.length) yield carry.toString('base64');
    yield suffix;
  }
  const response = await fetch(`${base}/rigging`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(prefix) + 4 * Math.ceil(size / 3) + Buffer.byteLength(suffix)) },
    body: Readable.from(encoded(), { objectMode: false }), duplex: 'half', signal: AbortSignal.timeout(180000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const description = result.message || result.error || result.detail || `Meshy returned ${response.status}.`;
    const error = new Error(typeof description === 'string' ? description.slice(0, 300) : `Meshy returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function handleMeshy(req, res, url) {
  if (!url.pathname.startsWith('/api/meshy/')) return false;
  const key = req.headers['x-meshy-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) { send(res, 401, { error: 'Connect your Meshy API key first.' }); return true; }
  try {
    if (req.method === 'GET' && url.pathname === '/api/meshy/library') { send(res, 200, await upstream(key, '/animations/library')); return true; }
    const create = url.pathname.match(/^\/api\/meshy\/(rigging|animations|text-to-motion)$/);
    if (req.method === 'POST' && create) {
      if (create[1] === 'rigging') {
        if (req.headers['content-type'] !== 'model/gltf-binary') throw new Error('Upload a binary GLB file.');
        send(res, 200, await upstreamRigging(key, req)); return true;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Use a JSON Meshy request.');
      const data = await jsonBody(req, 4096);
      let payload;
      if (create[1] === 'animations') {
        if (!idPattern.test(data.rig_task_id) || !Number.isInteger(data.action_id) || data.action_id < 0) throw new Error('Choose a valid rig and preset.');
        payload = { rig_task_id: data.rig_task_id, action_id: data.action_id };
      } else {
        if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 400 || !['swift', 'prime'].includes(data.mode) || !Number.isFinite(data.duration) || data.duration < 2 || data.duration > 10 || data.duration * 2 % 1 !== 0) throw new Error('Enter a prompt and duration from 2 to 10 seconds in half-second steps.');
        payload = { prompt: data.prompt.trim(), mode: data.mode, duration: data.duration };
      }
      send(res, 200, await upstream(key, `/${create[1]}`, 'POST', payload)); return true;
    }
    const task = url.pathname.match(/^\/api\/meshy\/tasks\/(rigging|animations|text-to-motion)\/([^/]+)$/);
    if (req.method === 'GET' && task && taskTypes.has(task[1]) && idPattern.test(task[2])) { send(res, 200, await upstream(key, `/${task[1]}/${task[2]}`)); return true; }
    const asset = url.pathname.match(/^\/api\/meshy\/assets\/(animations|text-to-motion)\/([^/]+)$/);
    if (req.method === 'GET' && asset && idPattern.test(asset[2])) {
      const taskData = await upstream(key, `/${asset[1]}/${asset[2]}`);
      if (taskData.status !== 'SUCCEEDED' || taskData.expires_at && taskData.expires_at < Date.now()) throw new Error('The Meshy result has expired or is not ready.');
      const address = asset[1] === 'animations' ? taskData.result?.animation_glb_url || taskData.result?.animation_fbx_url : taskData.result?.motion_url;
      if (!address) throw new Error('Meshy did not provide a downloadable motion file.');
      const signed = new URL(address);
      if (signed.protocol !== 'https:' || signed.hostname !== 'assets.meshy.ai' || signed.username || signed.password) throw new Error('Meshy returned an unexpected download location.');
      const response = await fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`Meshy download failed (${response.status}).`);
      const type = asset[1] === 'animations' ? taskData.result?.animation_glb_url ? 'glb' : 'fbx' : taskData.result?.motion_format;
      if (!['glb', 'fbx', 'bvh'].includes(type)) throw new Error('Meshy returned an unsupported motion format.');
      const length = Number(response.headers.get('content-length'));
      if (length > 150 * 1024 * 1024) throw new Error('Meshy returned a motion file over 150 MB.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Motion-Format': type });
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 150 * 1024 * 1024) { res.destroy(); return true; }
        if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
      }
      res.end(); return true;
    }
    send(res, 404, { error: 'Meshy endpoint not found.' });
  } catch (error) {
    if (res.headersSent) res.destroy();
    else send(res, error.status || 400, { error: error instanceof SyntaxError ? 'Invalid Meshy request.' : error.message || 'Meshy request failed.' });
  }
  return true;
}
