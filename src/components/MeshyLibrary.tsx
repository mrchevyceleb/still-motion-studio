import { useEffect, useMemo, useRef, useState } from 'react';
import { Mesh } from 'three';
import { exportCharacterGLB, importCharacter, disposeCharacter } from '../engine/character';
import { addPersonalMotion, listMeshyTasks, removeMeshyTask, rigFingerprint, saveMeshyTask } from '../engine/motionLibrary';
import type { PendingMeshyTask } from '../engine/motionLibrary';
import type { CharacterAsset } from '../types';

interface Preset { action_id: number; name: string; category: string; preview_url: string }
interface TaskResult { id: string; status: string; expires_at?: number; task_error?: { message?: string } }

export default function MeshyLibrary({ target, onSaved }: { target: CharacterAsset; onSaved: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [tasks, setTasks] = useState<PendingMeshyTask[]>([]);
  const [search, setSearch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'swift' | 'prime'>('swift');
  const [duration, setDuration] = useState(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailableRigIds, setUnavailableRigIds] = useState<Set<string>>(new Set());
  const [unavailableTaskIds, setUnavailableTaskIds] = useState<Set<string>>(new Set());
  const [authPaused, setAuthPaused] = useState(false);
  const pollLock = useRef(false);
  const rig = useMemo(() => rigFingerprint(target), [target]);
  const supportsPreset = useMemo(() => {
    if (target.kind !== 'humanoid' || target.source !== 'import') return false;
    let textured = false;
    target.root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      if (materials.some(material => material && 'map' in material && material.map)) textured = true;
    });
    return textured;
  }, [target]);

  useEffect(() => {
    let live = true;
    void listMeshyTasks().then(value => { if (live) setTasks(value); }).catch(() => { if (live) setError('Saved Meshy tasks could not be opened.'); });
    if (window.stillDesktop) void window.stillDesktop.meshyKey.get().then(value => { if (live && value) setKey(value); }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Secure key storage is unavailable.'); });
    return () => { live = false; };
  }, []);

  async function request(path: string, method = 'GET', data?: unknown): Promise<unknown> {
    const binary = data instanceof ArrayBuffer;
    const response = await fetch(`/api/meshy/${path}`, { method, headers: { 'X-Meshy-Key': key, ...(data ? { 'Content-Type': binary ? 'model/gltf-binary' : 'application/json' } : {}) }, ...(data ? { body: binary ? data : JSON.stringify(data) } : {}) });
    const value = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) setAuthPaused(true);
      throw Object.assign(new Error(value.error || `Meshy request failed (${response.status}).`), { status: response.status });
    }
    return value;
  }

  useEffect(() => {
    if (!key) return;
    let live = true;
    void request('library').then(value => { if (live) setPresets(Array.isArray(value) ? value as Preset[] : []); }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Meshy catalog is unavailable.'); });
    return () => { live = false; };
  }, [key]);

  async function persist(task: PendingMeshyTask) {
    await saveMeshyTask(task);
    setTasks(await listMeshyTasks());
  }

  async function connect() {
    setError(null);
    const next = draft.trim();
    if (next.length < 8) { setError('Enter your Meshy API key.'); return; }
    setBusy(true);
    try {
      const check = await fetch('/api/meshy/library', { headers: { 'X-Meshy-Key': next } });
      const result = await check.json().catch(() => ({})) as Preset[] | { error?: string };
      if (!check.ok || !Array.isArray(result)) throw new Error(Array.isArray(result) ? `Meshy rejected this key (${check.status}).` : result.error || 'Meshy key validation failed.');
      if (window.stillDesktop) await window.stillDesktop.meshyKey.set(next);
      setKey(next); setDraft(''); setPresets(result); setUnavailableRigIds(new Set()); setUnavailableTaskIds(new Set()); setAuthPaused(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The key could not be checked or saved.'); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setError(null);
    try {
      if (window.stillDesktop) await window.stillDesktop.meshyKey.clear();
      setKey(''); setPresets([]); setUnavailableRigIds(new Set()); setUnavailableTaskIds(new Set()); setAuthPaused(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved Meshy key could not be removed.'); }
  }

  async function start(type: PendingMeshyTask['type'], name: string, payload: unknown, extra: Partial<PendingMeshyTask> = {}) {
    setBusy(true); setError(null); setNotice(null);
    let acceptedId: string | undefined;
    try {
      // A failed/ambiguous POST is never repeated automatically: the user can inspect Meshy tasks.
      const result = await request(type, 'POST', payload) as { result?: string };
      if (!result.result) throw new Error('Meshy did not return a task ID. Check your Meshy account before trying again.');
      acceptedId = result.result;
      const task: PendingMeshyTask = { id: result.result, type, name, status: 'PENDING', createdAt: Date.now(), ...extra };
      await persist(task);
      setNotice(`${name} started. Its task ID is saved for recovery.`);
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : 'Meshy request failed.'}${acceptedId ? ` Meshy task ID: ${acceptedId}. Save this ID; local task storage failed.` : ' If the request may have reached Meshy, check your Meshy tasks before retrying.'}`); }
    finally { setBusy(false); }
  }

  async function generatePreset(preset: Preset) {
    if (!supportsPreset || busy || authPaused) return;
    const previous = tasks.find(task => task.type === 'rigging' && task.targetRig === rig && task.status === 'SUCCEEDED' && (!task.expiresAt || task.expiresAt > Date.now()) && !unavailableRigIds.has(task.id));
    if (previous) {
      setBusy(true); setError(null);
      try {
        const status = await request(`tasks/rigging/${encodeURIComponent(previous.id)}`) as TaskResult;
        if (status.status !== 'SUCCEEDED' || status.expires_at && status.expires_at <= Date.now()) {
          await persist({ ...previous, status: 'EXPIRED', expiresAt: status.expires_at });
          setError('This Meshy rig has expired. Select the preset again to upload this character for a new rigging task.'); return;
        }
        if (status.expires_at !== previous.expiresAt) await persist({ ...previous, expiresAt: status.expires_at });
      } catch (cause) {
        if ((cause as Error & { status?: number }).status === 404) {
          setUnavailableRigIds(current => new Set(current).add(previous.id));
          setError('This rig is unavailable with the current Meshy key. Check the key, or select the preset again to upload a new rig.');
        } else setError(cause instanceof Error ? cause.message : 'The Meshy rig could not be checked.');
        return;
      } finally { setBusy(false); }
      if (!window.confirm(`Apply “${preset.name}” to your Meshy rig? Meshy charges 3 credits for this animation task.`)) return;
      await start('animations', preset.name, { rig_task_id: previous.id, action_id: preset.action_id }, { rigId: previous.id, targetRig: rig, actionId: preset.action_id });
      return;
    }
    if (!window.confirm(`Upload “${target.name}” to Meshy for rigging? This sends your character to Meshy and costs 5 credits. After rigging, applying “${preset.name}” costs another 3 credits. Continue with the upload?`)) return;
    setBusy(true); setError(null);
    try {
      const bytes = await exportCharacterGLB(target);
      if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('Meshy accepts character uploads up to 100 MB.');
      setBusy(false);
      await start('rigging', `${target.name} · ${preset.name}`, bytes, { targetRig: rig, actionId: preset.action_id });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The character could not be prepared for Meshy.'); setBusy(false); }
  }

  async function startMotion() {
    if (busy || authPaused) return;
    const clean = prompt.trim();
    if (!clean || clean.length > 400 || duration < 2 || duration > 10 || duration * 2 % 1 !== 0) { setError('Enter a prompt and a 2–10 second duration in half-second steps.'); return; }
    const credits = mode === 'swift' ? 3 : 10;
    if (!window.confirm(`Generate “${clean}” with Meshy ${mode}? This costs ${credits} credits and sends your prompt to Meshy.`)) return;
    await start('text-to-motion', clean.slice(0, 60), { prompt: clean, mode, duration });
  }

  async function download(task: PendingMeshyTask) {
    const response = await fetch(`/api/meshy/assets/${task.type}/${encodeURIComponent(task.id)}`, { headers: { 'X-Meshy-Key': key } });
    if (!response.ok) { const value = await response.json().catch(() => ({})) as { error?: string }; if (response.status === 401 || response.status === 403) setAuthPaused(true); throw Object.assign(new Error(value.error || 'Meshy file could not be downloaded.'), { status: response.status }); }
    const format = response.headers.get('X-Motion-Format');
    if (!format || !['glb', 'fbx', 'bvh'].includes(format)) throw new Error('Meshy returned an unsupported file.');
    const file = new File([await response.blob()], `${task.name.replace(/[^a-z0-9-_ ]/gi, '').slice(0, 50) || 'Meshy motion'}.${format}`);
    if (file.size > 150 * 1024 * 1024) throw new Error('The Meshy motion file is too large.');
    const source = await importCharacter(file);
    try {
      const clips = source.clips.map((clip, index) => ({ index, name: clip.name || task.name, duration: clip.duration }));
      await addPersonalMotion(file, clips, 'humanoid', 'Meshy');
      await onSaved();
      await removeMeshyTask(task.id);
      setTasks(await listMeshyTasks());
      setNotice(`${task.name} saved to My Motions.`);
    } finally { disposeCharacter(source); }
  }

  async function refresh() {
    if (!key || authPaused || pollLock.current) return;
    pollLock.current = true;
    try {
      const saved = await listMeshyTasks();
      for (const task of saved) {
        if (['FAILED', 'CANCELED', 'EXPIRED'].includes(task.status) || unavailableTaskIds.has(task.id)) continue;
        if (task.expiresAt && task.expiresAt < Date.now()) { await saveMeshyTask({ ...task, status: 'EXPIRED' }); continue; }
        let expiry = task.expiresAt;
        try {
          const status = await request(`tasks/${task.type}/${encodeURIComponent(task.id)}`) as TaskResult;
          expiry = status.expires_at;
          if (expiry && expiry < Date.now()) {
            await saveMeshyTask({ ...task, status: 'EXPIRED', expiresAt: expiry });
          } else if (status.status === 'SUCCEEDED' && task.type !== 'rigging') {
            if (status.expires_at && status.expires_at < Date.now()) throw new Error('Result expired.');
            await download(task);
          } else if (status.status !== task.status || status.expires_at !== task.expiresAt) {
            await saveMeshyTask({ ...task, status: status.status, expiresAt: status.expires_at });
          }
          if (status.status === 'FAILED') setError(`${task.name}: ${status.task_error?.message || 'Meshy could not complete this task.'}`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'Could not check Meshy.';
          const status = (cause as Error & { status?: number }).status;
          if (status === 401 || status === 403) { setAuthPaused(true); setError('Meshy rejected this key. Disconnect it and connect the correct key to resume saved tasks.'); break; }
          if (status === 404) {
            setUnavailableTaskIds(current => new Set(current).add(task.id));
            if (task.type === 'rigging') setUnavailableRigIds(current => new Set(current).add(task.id));
            setError(`${task.name} is unavailable with this Meshy key. Connect its original key or forget the saved task.`);
            continue;
          }
          if (expiry && expiry < Date.now()) await saveMeshyTask({ ...task, status: 'EXPIRED', expiresAt: expiry });
          setError(`${task.name}: ${message} The task will remain saved for another check.`);
        }
      }
      setTasks(await listMeshyTasks());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Saved Meshy tasks could not be checked.');
    } finally { pollLock.current = false; }
  }

  useEffect(() => {
    if (!key || authPaused || !tasks.some(task => !['FAILED', 'CANCELED', 'EXPIRED'].includes(task.status) && !unavailableTaskIds.has(task.id))) return;
    const pending = tasks.some(task => !['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(task.status) && !unavailableTaskIds.has(task.id));
    const timer = setInterval(() => void refresh(), pending ? 10000 : 60000);
    void refresh();
    return () => clearInterval(timer);
  }, [key, authPaused, tasks.map(task => `${task.id}:${task.status}`).join('|'), [...unavailableTaskIds].join('|')]);

  async function forget(task: PendingMeshyTask) {
    if (!window.confirm(`Forget the saved task ID for “${task.name}”? This does not cancel or delete the task in Meshy.`)) return;
    try {
      await removeMeshyTask(task.id);
      setTasks(await listMeshyTasks());
      setUnavailableTaskIds(current => { const next = new Set(current); next.delete(task.id); return next; });
      setUnavailableRigIds(current => { const next = new Set(current); next.delete(task.id); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved task could not be removed.'); }
  }

  const shown = presets.filter(item => `${item.name} ${item.category}`.toLowerCase().includes(search.toLowerCase())).slice(0, 25);
  return <details className="meshy-library"><summary>Meshy · optional</summary>
    {!key ? <><p>Use your own Meshy API key and credits. Desktop stores the key securely; browser access lasts until this page reloads.</p><input type="password" aria-label="Meshy API key" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Meshy API key"/><button disabled={busy} onClick={() => void connect()}>Connect Meshy</button></> : <>
      <button className="meshy-disconnect" onClick={() => void disconnect()}>Disconnect key</button>
      <p>Generate a biped motion from a prompt. Swift costs 3 credits (BVH); Prime costs 10 credits (FBX).</p>
      <textarea aria-label="Describe motion for Meshy" maxLength={400} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="A character dances, then waves"/>
      <div className="meshy-fields"><select aria-label="Meshy motion mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="swift">Swift · 3 credits</option><option value="prime">Prime · 10 credits</option></select><input aria-label="Meshy duration seconds" type="number" min="2" max="10" step="0.5" value={duration} onChange={event => setDuration(Number(event.target.value))}/></div>
      <button disabled={busy || authPaused} onClick={() => void startMotion()}>Generate motion</button>
      <p>Preset animations require a textured humanoid character. Uploading it for Meshy rigging costs 5 credits; each preset task costs 3 credits.</p>
      {!supportsPreset && <p>Import a textured humanoid GLB or FBX to use Meshy presets.</p>}
      <input aria-label="Search Meshy presets" placeholder="Search Meshy presets" value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="meshy-presets">{shown.map(item => <button key={item.action_id} disabled={!supportsPreset || busy || authPaused} onClick={() => void generatePreset(item)}>{item.name}<small>{item.category}</small></button>)}</div>
      {tasks.length > 0 && <><strong>Meshy tasks</strong><button disabled={authPaused} onClick={() => void refresh()}>Check now</button>{tasks.map(task => <div className="meshy-task" key={task.id}><span>{task.name} · {unavailableTaskIds.has(task.id) ? 'Unavailable with this key' : task.status}</span>{task.type === 'rigging' && task.status === 'SUCCEEDED' && task.actionId !== undefined && task.targetRig === rig && <button disabled={busy || authPaused || !supportsPreset} onClick={() => void generatePreset({ action_id: task.actionId!, name: task.name, category: '', preview_url: '' })}>Animate · 3 credits</button>}{task.status === 'EXPIRED' && <small>Result expired on Meshy.</small>}<button onClick={() => void forget(task)}>Forget</button></div>)}</>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p className="motion-error" role="alert">{error}</p>}
  </details>;
}
