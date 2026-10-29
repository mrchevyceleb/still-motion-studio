import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, FolderPlus, LoaderCircle, Play, Search, Trash2, X } from 'lucide-react';
import { disposeCharacter, importCharacter } from '../engine/character';
import { importAnimationOnRig } from '../engine/animationImport';
import { libraryAlignment, mappingReady, suggestLibraryMapping } from '../engine/libraryRetarget';
import { addPersonalMotion, listPersonalMotions, motionHash, readMotionMapping, readPersonalMotion, removePersonalMotion } from '../engine/motionLibrary';
import type { PersonalMotion } from '../engine/motionLibrary';
import { RetargetError, retargetAnimation } from '../engine/retarget';
import type { CharacterAsset, PoseKey, RigKind } from '../types';
import MeshyLibrary from './MeshyLibrary';
import './MotionLibrary.css';

interface OfflineClip { id: string; sourceFile: string; clipIndex: number; name: string; duration: number; provider: string; body: RigKind; category: string; loop: boolean }
interface OfflineSource { file: string; sha256: string; bytes: number }
interface OfflineCatalog { version: number; sources: OfflineSource[]; clips: OfflineClip[] }
interface Entry { id: string; sourceId: string; clipIndex: number; name: string; duration: number; provider: string; body: RigKind; category: string; personal?: PersonalMotion }

export default function MotionLibrary({ target, disabled, onPreview, onClear, onApply, onNeedsMapping }: {
  target: CharacterAsset; disabled: boolean;
  onPreview: (keys: PoseKey[], duration: number, name: string) => void;
  onClear: () => void;
  onApply: (keys: PoseKey[], duration: number, mode: 'apply' | 'append', blend: number, name: string) => void;
  onNeedsMapping: (file: File, mode: 'apply' | 'append', clipIndex: number) => void;
}) {
  const [catalog, setCatalog] = useState<OfflineCatalog | null>(null);
  const [personal, setPersonal] = useState<PersonalMotion[]>([]);
  const [search, setSearch] = useState('');
  const [body, setBody] = useState<'all' | RigKind>('all');
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [loaded, setLoaded] = useState<{ keys: PoseKey[]; duration: number; file: File; needsMapping: boolean; retargeted: boolean } | null>(null);
  const [blend, setBlend] = useState('0.15');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const verifiedSources = useRef(new Map<string, ArrayBuffer>());
  const [importProvider, setImportProvider] = useState<PersonalMotion['provider']>('My Motions');

  useEffect(() => {
    let active = true;
    fetch('/motions/catalog.json').then(async response => {
      if (!response.ok) throw new Error('Offline motion catalog is missing.');
      const value = await response.json() as OfflineCatalog;
      if (value.version !== 1) throw new Error('Offline motion catalog is incompatible.');
      if (active) setCatalog(value);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load offline clips.'); });
    listPersonalMotions().then(value => { if (active) setPersonal(value); }).catch(() => { if (active) setError('Your saved motions could not be opened.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => { ++request.current; setSelected(null); setLoaded(null); onClear(); }, [target.root]);

  const entries = useMemo<Entry[]>(() => {
    const bundled = catalog?.clips.map(clip => ({ id: clip.id, sourceId: clip.sourceFile, clipIndex: clip.clipIndex, name: clip.name, duration: clip.duration, provider: clip.provider, body: clip.body, category: clip.category })) ?? [];
    const own = personal.flatMap(item => item.clips.map(clip => ({ id: `${item.id}:${clip.index}`, sourceId: item.id, clipIndex: clip.index, name: clip.name, duration: clip.duration, provider: item.provider, body: item.body, category: 'My Motions', personal: item })));
    return [...own, ...bundled];
  }, [catalog, personal]);
  const filtered = useMemo(() => entries.filter(item => (body === 'all' || item.body === body) && `${item.name} ${item.provider} ${item.category} ${item.sourceId}`.toLowerCase().includes(search.toLowerCase().trim())), [entries, body, search]);

  async function fileFor(entry: Entry): Promise<File> {
    if (entry.personal) return readPersonalMotion(entry.personal);
    const source = catalog?.sources.find(item => item.file === entry.sourceId);
    if (!source) throw new Error('This bundled source is missing from the catalog.');
    const cached = verifiedSources.current.get(source.file);
    if (cached) {
      verifiedSources.current.delete(source.file);
      verifiedSources.current.set(source.file, cached);
      return new File([cached], source.file, { type: 'model/gltf-binary' });
    }
    const response = await fetch(`/motions/${encodeURIComponent(source.file)}`);
    if (!response.ok) throw new Error('This bundled motion file is unavailable.');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== source.bytes) throw new Error('The bundled motion file is incomplete.');
    const file = new File([bytes], source.file, { type: 'model/gltf-binary' });
    if (await motionHash(file) !== source.sha256) throw new Error('The bundled motion file failed its integrity check.');
    verifiedSources.current.set(source.file, bytes);
    while (verifiedSources.current.size > 3 || [...verifiedSources.current.values()].reduce((size, value) => size + value.byteLength, 0) > 24 * 1024 * 1024) {
      const oldest = verifiedSources.current.keys().next().value;
      if (!oldest || oldest === source.file) break;
      verifiedSources.current.delete(oldest);
    }
    return file;
  }

  async function choose(entry: Entry) {
    if (disabled) return;
    const ticket = ++request.current;
    setSelected(entry); setLoaded(null); setLoading(true); setError(null); onClear();
    let source: CharacterAsset | undefined;
    try {
      const file = await fileFor(entry);
      source = await importCharacter(file);
      if (ticket !== request.current) return;
      const clip = source.clips[entry.clipIndex];
      if (!clip) throw new Error('The selected clip is missing from its source file.');
      let keys: PoseKey[];
      let needsMapping = false;
      let retargeted = false;
      try { keys = importAnimationOnRig(target, source, clip); }
      catch {
        retargeted = true;
        const saved = await readMotionMapping(source, target).catch(() => undefined);
        const mapping = saved ?? suggestLibraryMapping(target, source);
        if (!saved && !mappingReady(target, mapping)) { needsMapping = true; keys = []; }
        else {
          try { keys = retargetAnimation(target, source, clip, mapping, true, libraryAlignment(target, mapping)); }
          catch (cause) {
            const message = cause instanceof Error ? cause.message : 'This move could not be fitted automatically.';
            if (cause instanceof RetargetError && cause.reason === 'scale') throw cause;
            needsMapping = true; keys = []; if (ticket === request.current) setError(message);
          }
        }
      }
      if (ticket !== request.current) return;
      setLoaded({ keys, duration: clip.duration, file, needsMapping, retargeted });
      setBlend(String(Math.min(.15, clip.duration / 2)));
      if (!needsMapping) {
        onPreview(keys, clip.duration, entry.name);
        if (window.matchMedia('(max-width: 720px)').matches) requestAnimationFrame(() => document.querySelector('.viewport-shell')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
      }
    } catch (cause) { if (ticket === request.current) setError(cause instanceof Error ? cause.message : 'Could not preview this motion.'); }
    finally { if (source) disposeCharacter(source); if (ticket === request.current) setLoading(false); }
  }

  async function add(file: File) {
    if (disabled) return;
    setLoading(true); setError(null);
    let source: CharacterAsset | undefined;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('Choose a motion file smaller than 150 MB.');
      source = await importCharacter(file);
      const clips = source.clips.map((clip, index) => ({ index, name: clip.name || `Clip ${index + 1}`, duration: clip.duration }));
      await addPersonalMotion(file, clips, source.kind, importProvider);
      setPersonal(await listPersonalMotions());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This motion could not be saved. Check available storage.'); }
    finally { if (source) disposeCharacter(source); setLoading(false); }
  }

  async function remove(entry: PersonalMotion) {
    if (disabled || loading) return;
    if (!window.confirm(`Remove “${entry.filename}” and all ${entry.clips.length} saved clip${entry.clips.length === 1 ? '' : 's'} from My Motions? This cannot be undone.`)) return;
    try {
      await removePersonalMotion(entry.id);
      setPersonal(await listPersonalMotions());
      if (selected?.sourceId === entry.id) { setSelected(null); setLoaded(null); onClear(); }
    } catch { setError('Could not remove this saved motion.'); }
  }

  function apply(mode: 'apply' | 'append') {
    if (!selected || !loaded || disabled || loading) return;
    if (loaded.needsMapping) { onNeedsMapping(loaded.file, mode, selected.clipIndex); return; }
    const seconds = Math.min(Number(blend), loaded.duration / 2);
    if (mode === 'append' && (!Number.isFinite(seconds) || seconds < 0)) { setError('Enter a valid transition duration.'); return; }
    onApply(loaded.keys, loaded.duration, mode, mode === 'append' ? seconds : 0, selected.name);
    setSelected(null); setLoaded(null); onClear();
  }

  return <section className="sidebar-section motion-library" aria-label="Motion Library">
    <div className="section-heading"><h2>Motion Library</h2><span className="tiny-badge">{entries.length} CLIPS</span></div>
    <div className="motion-search"><Search size={13}/><input aria-label="Search motions" placeholder="Search moves" value={search} onChange={event => { setSearch(event.target.value); setLimit(40); }}/></div>
    <select className="motion-body-filter" aria-label="Filter motions by body type" value={body} onChange={event => { setBody(event.target.value as typeof body); setLimit(40); }}><option value="all">All body types</option><option value="humanoid">Human</option><option value="quadruped">Four legs</option><option value="creature">Creature</option></select>
    <div className="motion-list">{filtered.slice(0, limit).map(entry => <div className={`motion-row ${selected?.id === entry.id ? 'selected' : ''}`} key={entry.id}>
      <button disabled={disabled} onClick={() => void choose(entry)} title={`Preview ${entry.name}`}><Activity size={13}/><span><strong>{entry.name}</strong><small>{entry.provider} · {entry.duration.toFixed(1)}s · {entry.body}</small></span>{selected?.id === entry.id && loading ? <LoaderCircle size={13} className="spin"/> : <Play size={12}/>}</button>
      {entry.personal && <button className="motion-remove" aria-label={`Remove ${entry.name} from My Motions`} title="Remove saved file and all its clips" disabled={disabled || loading} onClick={() => void remove(entry.personal!)}><Trash2 size={11}/></button>}
    </div>)}{!filtered.length && <p className="motion-empty">No motions match this search.</p>}</div>
    {filtered.length > limit && <button className="motion-more" onClick={() => setLimit(value => value + 40)}>Show more · {filtered.length - limit} remaining</button>}
    {selected && <div className="motion-actions"><div className="motion-actions-heading"><strong>{selected.name}</strong><button aria-label="Close motion preview" onClick={() => { ++request.current; setSelected(null); setLoaded(null); setError(null); onClear(); }}><X size={13}/></button></div>
      {error && <p className="motion-error" role="alert">{error}</p>}
      {loaded?.needsMapping && <p>This move needs help fitting your character. Set it up once to use it with this rig.</p>}
      {loaded && !loaded.needsMapping && <button className="motion-replay" onClick={() => onPreview(loaded.keys, loaded.duration, selected.name)}><Play size={12}/>Replay preview</button>}
      {loaded?.retargeted && !loaded.needsMapping && <button className="motion-replay" disabled={disabled || loading} onClick={() => onNeedsMapping(loaded.file, 'apply', selected.clipIndex)}>Adjust fit</button>}
      <div className="motion-apply-buttons"><button disabled={!loaded || loading || disabled} onClick={() => apply('apply')}>{loaded?.needsMapping ? 'Set up motion' : 'Apply'}</button>{!loaded?.needsMapping && <button disabled={!loaded || loading || disabled} onClick={() => apply('append')}>Append</button>}</div>
      {!loaded?.needsMapping && <label>Blend · seconds<input aria-label="Motion transition seconds" type="number" min="0" step="0.05" value={blend} onChange={event => setBlend(event.target.value)}/></label>}
    </div>}
    {error && !selected && <p className="motion-error" role="alert">{error}</p>}
    <input ref={input} type="file" accept=".fbx,.glb,.gltf,.bvh" hidden aria-label="Add a motion file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void add(file); }}/>
    <button className="motion-add" disabled={disabled || loading} onClick={() => { setImportProvider('My Motions'); input.current?.click(); }}><FolderPlus size={14}/>Add to My Motions</button>
    <button className="motion-mixamo" onClick={() => { setImportProvider('Mixamo'); if (window.stillDesktop) void window.stillDesktop.openExternal('https://www.mixamo.com/').catch(() => setError('Mixamo could not be opened in your browser.')); else if (!window.open('https://www.mixamo.com/', '_blank', 'noopener,noreferrer')) setError('Allow popups to open Mixamo.'); }}><ArrowUpRight size={13}/>Open Mixamo</button>
    {importProvider === 'Mixamo' && <button className="motion-add" disabled={disabled || loading} onClick={() => input.current?.click()}>Add downloaded Mixamo file</button>}
    <MeshyLibrary target={target} onSaved={async () => setPersonal(await listPersonalMotions())}/>
  </section>;
}
