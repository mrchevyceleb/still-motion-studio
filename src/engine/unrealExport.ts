export interface UnrealExportCapability { available: boolean; reason?: string }
export interface UnrealExportResult { package: Blob; warnings: string[] }

const unavailable = 'The Unreal exporter is unavailable. Start Still with its launcher, then try again.';

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(unavailable); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(unavailable);
  const body = data as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : 'The Unreal export could not finish.');
  return body;
}

export async function getUnrealExportCapability(signal?: AbortSignal): Promise<UnrealExportCapability> {
  try {
    const timeout = AbortSignal.timeout(8000);
    const data = await readResponse(await fetch('/api/export-capabilities', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
    if (!data.unreal || typeof data.unreal !== 'object') return { available: false, reason: unavailable };
    const capability = data.unreal as Record<string, unknown>;
    return { available: capability.available === true, reason: typeof capability.reason === 'string' ? capability.reason : undefined };
  } catch { return { available: false, reason: unavailable }; }
}

function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 500);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Convert the editor's baked GLB locally; source rig, motion, and scene stay untouched. */
export async function exportUnrealPackage(
  binary: ArrayBuffer,
  options: { name: string; fps: number },
  onProgress: (message: string, progress: number) => void,
  signal: AbortSignal,
): Promise<UnrealExportResult> {
  let jobPath: string | null = null;
  let cancellation: Promise<void> | null = null;
  let completed = false;
  const cancel = () => {
    if (jobPath && !cancellation && !completed) {
      cancellation = fetch(jobPath, { method: 'DELETE', signal: AbortSignal.timeout(10000) }).then(() => {}, () => {});
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    onProgress('Sending your character to the local exporter…', 0.05);
    const id = crypto.randomUUID();
    jobPath = `/api/exports/${id}`;
    const query = new URLSearchParams({ name: options.name, fps: String(options.fps), id });
    // The ID exists before upload, so Cancel can abort the request and stop its worker.
    const job = await readResponse(await fetch(`/api/exports/unreal?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: binary,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    }));
    if (job.id !== id) throw new Error('The local exporter returned an invalid job. Please try again.');
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    while (true) {
      signal.throwIfAborted();
      const status = await readResponse(await fetch(jobPath, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }));
      const fraction = typeof status.progress === 'number' && Number.isFinite(status.progress) ? status.progress : 0;
      onProgress(typeof status.message === 'string' ? status.message : 'Preparing your Unreal package…', Math.max(.05, Math.min(.95, fraction)));
      if (status.status === 'error') throw new Error(typeof status.error === 'string' ? status.error : typeof status.message === 'string' ? status.message : 'The Unreal export could not finish.');
      if (status.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      if (status.status === 'done') {
        const downloadPath = `${jobPath}/download`;
        if (status.downloadUrl !== undefined && status.downloadUrl !== downloadPath) throw new Error('The exporter returned an unexpected download address.');
        onProgress('Downloading your Unreal package…', .98);
        const response = await fetch(downloadPath, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
        if (!response.ok) { await readResponse(response); throw new Error('The Unreal package could not be downloaded.'); }
        const archive = await response.blob();
        const signature = new Uint8Array(await archive.slice(0, 4).arrayBuffer());
        if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) throw new Error('The local exporter did not return a valid ZIP package.');
        signal.throwIfAborted();
        completed = true;
        onProgress('Your Unreal package is ready.', 1);
        return { package: archive, warnings: Array.isArray(status.warnings) ? status.warnings.filter((warning): warning is string => typeof warning === 'string') : [] };
      }
      if (!['uploading', 'queued', 'running'].includes(String(status.status))) throw new Error('The local exporter returned an unknown job status.');
      await pause(signal);
    }
  } catch (error) {
    cancel();
    if (cancellation) await cancellation;
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}
