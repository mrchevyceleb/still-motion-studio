import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, stat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 180 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const exists = filename => stat(filename).then(info => info.isFile(), () => false);

export function createUnrealExportService({ root, dataRoot = root, reserve, release }) {
  const jobs = new Map(), directory = path.join(dataRoot, '.local/unreal-exports');
  let stopping = false, converterCache = null;

  async function converter() {
    if (converterCache && Date.now() < converterCache.expires) return converterCache.filename;
    const candidates = [process.env.STILL_BLENDER_EXECUTABLE];
    try { candidates.push(JSON.parse(await readFile(path.join(dataRoot, '.local/unreal-export/runtime.json'), 'utf8')).blender); } catch { /* Optional configuration. */ }
    const foundation = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Blender Foundation');
    try {
      const versions = (await readdir(foundation, { withFileTypes: true })).filter(item => item.isDirectory() && /^Blender /i.test(item.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      candidates.push(...versions.map(item => path.join(foundation, item.name, 'blender.exe')));
    } catch { /* Try PATH and standard Unix installs next. */ }
    candidates.push(...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(item => path.join(item, process.platform === 'win32' ? 'blender.exe' : 'blender')));
    candidates.push('/usr/bin/blender', '/Applications/Blender.app/Contents/MacOS/Blender');
    let filename = null;
    if (await exists(path.join(root, 'backend/unreal_export.py'))) {
      for (const candidate of candidates) if (typeof candidate === 'string' && await exists(candidate)) { filename = candidate; break; }
    }
    converterCache = { expires: Date.now() + (filename ? 60000 : 3000), filename };
    return filename;
  }

  const publicJob = job => ({ id: job.id, status: job.status, message: job.message, progress: job.progress,
    ...(job.error ? { error: job.error } : {}), ...(job.status === 'done' ? { downloadUrl: `/api/exports/${job.id}/download`, warnings: job.warnings || [] } : {}) });

  async function prune() {
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)).toLowerCase() !== path.resolve(directory).toLowerCase()) return;
    const old = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name) || ['uploading', 'running'].includes(jobs.get(entry.name)?.status)) continue;
      const target = path.resolve(directory, entry.name);
      if (path.dirname(target) === directory) old.push({ target, time: (await stat(target)).mtimeMs });
    }
    old.sort((a, b) => b.time - a.time);
    for (const item of old.slice(10)) await rm(item.target, { recursive: true, force: true });
    for (const [id, job] of jobs) { if (jobs.size <= 10) break; if (!['uploading', 'running'].includes(job.status)) jobs.delete(id); }
  }

  async function upload(req, filename) {
    const file = await open(filename, 'wx');
    let size = 0, header = Buffer.alloc(0);
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('This export exceeds 180 MB. Use smaller textures or a lighter character.');
        if (header.length < 12) header = Buffer.concat([header, chunk.subarray(0, 12 - header.length)]);
        let offset = 0;
        while (offset < chunk.length) { const result = await file.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
      }
      if (size < 20 || header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== size) throw new Error('Unreal export requires a complete binary GLB character.');
    } finally { await file.close(); }
  }

  async function run(job, executable, options) {
    let log = '', errors = '', pending = '';
    try {
      const config = path.join(job.folder, 'options.json');
      await writeFile(config, JSON.stringify(options));
      if (job.status === 'cancelled' || stopping) return;
      job.status = 'running'; job.message = 'Preparing the Unreal character and animation…'; job.progress = .05;
      const child = spawn(executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(root, 'backend/unreal_export.py'), '--', '--input', path.join(job.folder, 'source.glb'), '--output', job.output, '--options', config], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
      });
      job.child = child;
      const deadline = setTimeout(() => { job.error = 'Unreal export exceeded three minutes. Your project is unchanged; try a shorter clip or lighter character.'; child.kill(); }, 180000);
      child.stdout.on('data', chunk => {
        log = (log + chunk.toString('utf8')).slice(-1000000);
        pending = (pending + chunk.toString('utf8')).slice(-1000000);
        const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.event === 'progress') { job.message = String(event.message); job.progress = Math.max(0, Math.min(.99, Number(event.progress) || 0)); }
            if (event.event === 'error') job.error = String(event.message);
          } catch { /* Blender also writes ordinary diagnostics. */ }
        }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-12000); });
      let code;
      try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
      finally { clearTimeout(deadline); }
      if (job.status === 'cancelled') return;
      if (code !== 0 || job.error) throw new Error(job.error || 'The Unreal package could not be prepared. Check the local export log for details; your project is unchanged.');
      if ((await stat(job.output)).size < 22) throw new Error('The converter returned an empty Unreal package.');
      const manifest = JSON.parse(await readFile(job.output.replace(/\.zip$/, '.json'), 'utf8'));
      job.warnings = Array.isArray(manifest.warnings) ? manifest.warnings.filter(item => typeof item === 'string') : [];
      job.status = 'done'; job.progress = 1; job.message = 'Unreal package ready.';
    } catch (error) {
      if (job.status !== 'cancelled') { job.status = 'error'; job.error = String(error.message || error); job.message = job.error; }
    } finally {
      job.child = null; release(job.id);
      await writeFile(path.join(job.folder, 'export.log'), log + '\n' + errors).catch(() => {});
      await prune().catch(error => console.error('Export cleanup:', error.message));
    }
  }

  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/export-capabilities') {
      const ready = !!(await converter());
      json(res, 200, { unreal: { available: ready, ...(ready ? {} : { reason: 'Install Blender to enable the local Unreal FBX exporter.' }) } }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/exports/unreal') {
      if (!['model/gltf-binary', 'application/octet-stream'].includes((req.headers['content-type'] || '').split(';')[0])) { json(res, 415, { error: 'Upload a binary GLB character.' }); return true; }
      if (Number(req.headers['content-length']) > MAX_BYTES) { json(res, 413, { error: 'This export exceeds 180 MB. Use smaller textures or a lighter character.' }); return true; }
      const fps = Number(url.searchParams.get('fps') || 30), rootMotion = url.searchParams.get('rootMotion') || 'preserve';
      const retarget = url.searchParams.get('retarget') || 'none', targetMesh = url.searchParams.get('targetMesh') || '';
      if (![24, 30, 60].includes(fps) || !['preserve', 'extract', 'in-place'].includes(rootMotion) || !['none', 'manny', 'metahuman'].includes(retarget)) { json(res, 400, { error: 'Choose 24, 30, or 60 fps and a supported root-motion and retarget mode.' }); return true; }
      if (targetMesh && (targetMesh.length > 512 || !/^\/(?:Game|Engine|[A-Za-z][A-Za-z0-9_]*)\/[A-Za-z0-9_/]+(?:\.[A-Za-z0-9_]+)?$/.test(targetMesh))) { json(res, 400, { error: 'Choose a valid Unreal Skeleton or SkeletalMesh asset path.' }); return true; }
      const executable = await converter();
      if (!executable) { json(res, 503, { error: 'The local Unreal exporter needs Blender installed.' }); return true; }
      const id = url.searchParams.get('id') || crypto.randomUUID();
      if (!UUID.test(id)) { json(res, 400, { error: 'The export job ID is invalid.' }); return true; }
      if (jobs.has(id)) { json(res, 409, { error: 'This export job already exists. Start a new export.' }); return true; }
      if (req.aborted || res.destroyed) return true;
      if (stopping || !reserve(id)) { json(res, 409, { error: 'The local engine is busy. Finish or cancel its current operation before exporting.' }); return true; }
      const name = (url.searchParams.get('name') || 'Animation').trim().slice(0, 120) || 'Animation';
      const job = { id, folder: path.join(directory, id), status: 'uploading', message: 'Receiving your character…', progress: 0, name, request: req };
      job.output = path.join(job.folder, 'Unreal.zip'); jobs.set(id, job);
      res.once('close', () => {
        if (!res.writableFinished && ['uploading', 'running'].includes(job.status)) {
          job.status = 'cancelled'; job.message = 'Export cancelled. Your project is unchanged.';
          job.child?.kill(); job.request?.destroy();
        }
      });
      job.upload = (async () => { await mkdir(job.folder, { recursive: true }); await upload(req, path.join(job.folder, 'source.glb')); })();
      try {
        await job.upload; job.request = null;
        if (stopping || job.status === 'cancelled') { release(id); json(res, 409, { error: 'Export was cancelled. Your project is unchanged.' }); return true; }
        job.work = run(job, executable, { name, fps, rootMotion, retarget, targetMesh });
        json(res, 202, publicJob(job));
      } catch (error) {
        if (job.status !== 'cancelled') { job.status = 'error'; job.error = String(error.message || error); }
        job.request = null; release(id);
        await prune().catch(error => console.error('Export cleanup:', error.message));
        if (!res.destroyed) json(res, 400, { error: job.error || 'Export was cancelled.' });
      }
      return true;
    }
    const match = url.pathname.match(/^\/api\/exports\/([0-9a-f-]{36})(\/download)?$/);
    if (!match) return false;
    const job = jobs.get(match[1]);
    if (!job) { json(res, 404, { error: 'This local export has expired. Export the project again.' }); return true; }
    if (req.method === 'GET' && match[2]) {
      if (job.status !== 'done') { json(res, 409, { error: 'The Unreal package is not ready.' }); return true; }
      const info = await stat(job.output);
      const filename = (job.name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'Animation') + '-Unreal.zip';
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
      const stream = createReadStream(job.output); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return true;
    }
    if (req.method === 'GET') { json(res, 200, publicJob(job)); return true; }
    if (req.method === 'DELETE') {
      if (['uploading', 'running'].includes(job.status)) { job.status = 'cancelled'; job.message = 'Export cancelled. Your project is unchanged.'; job.child?.kill(); job.request?.destroy(); }
      json(res, 200, publicJob(job)); return true;
    }
    return false;
  }

  async function stop() {
    stopping = true;
    for (const job of jobs.values()) if (['uploading', 'running'].includes(job.status)) { job.status = 'cancelled'; job.child?.kill(); job.request?.destroy(); }
    await Promise.allSettled([...jobs.values()].flatMap(job => [job.upload, job.work]));
  }
  void prune().catch(error => console.error('Export cleanup:', error.message));
  return { handle, stop };
}
