import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme';
import './unreal-export.css';
import './agent-scripting.css';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bone, Box, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, Expand, Footprints, Hand, Keyboard, Layers2, Leaf, LoaderCircle, Maximize2, MousePointer2, Move, Pause, Play, Plus, Redo2, RotateCcw, RotateCw, Save, Settings2, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Trash2, Undo2, Upload, X } from 'lucide-react';
import { Euler, MathUtils, Quaternion } from 'three';
import Viewport from './components/Viewport';
import type { ViewportAPI } from './components/Viewport';
import { connectAgentBridge } from './engine/agentBridge';
import type { AgentConnection } from './engine/agentBridge';
import { executeAgentCommand, READ_COMMANDS } from './engine/agentCommands';
import type { AgentEditor } from './engine/agentCommands';
import PoseThumbnail from './components/PoseThumbnail';
import { applyPose, autoRigCharacter, createDemoCharacter, disposeCharacter, exportCharacterGLB, getAutoRigDiagnostics, importCharacter, restoreCharacter } from './engine/character';
import { applyPhysics, buildAnimationClip, createDemoKeys, sampleClip, samplePose, simplifyKeys } from './engine/motion';
import { generateMotion, getEngineStatus, makeMotionRequest, restoreEngineFrames, recoverNativeEngine } from './engine/assistance';
import type { EngineProvider, EngineStatus } from './engine/assistance';
import { exportUnrealPackage, getUnrealExportCapability } from './engine/unrealExport';
import type { UnrealExportCapability } from './engine/unrealExport';
import { archiveLocal, downloadFile, embedCharacter, listArchives, loadLocal, readArchive, saveLocal, validateProject } from './engine/project';
import type { ArchiveEntry } from './engine/project';
import { DEFAULT_SETTINGS } from './types';
import type { CharacterAsset, InterpolationMode, MotionGeneration, MotionSettings, Pose, PoseKey, ProjectDocument, RigKind } from './types';

interface Studio { title: string; keys: PoseKey[]; generated?: PoseKey[]; generation?: MotionGeneration; duration: number; settings: MotionSettings; sourceClip?: number | null; rigKind?: RigKind }
type Dialog = 'import' | 'export' | 'help' | 'rig' | 'new' | 'agent' | null;
const clone = <T,>(value: T): T => structuredClone(value);
const niceName = (name: string) => name.replace(/^mixamorig[:_]?/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_:]/g, ' ');
const uid = () => crypto.randomUUID();

function PoseSketch({ index = 0, quadruped = false }: { index?: number; quadruped?: boolean }) {
  const reach = [0, 9, 22, 36, 17, 0][index % 6];
  return <svg className="pose-sketch" viewBox="0 0 90 96" fill="none" aria-hidden="true">
    <ellipse cx="45" cy="87" rx="24" ry="3" fill="currentColor" opacity=".06" />
    {quadruped ? <g stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 50L59 48L68 33L76 37M27 50L22 77M32 51L36 76M53 50L50 77M59 49L65 73M24 49L14 41" /><circle cx="73" cy="34" r="6" fill="currentColor" stroke="none" /></g> : <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="44" cy="19" r="8" fill="currentColor" stroke="none"/><path d="M44 33L44 55" strokeWidth="14"/><path d={`M36 34L25 ${45 - reach / 5}L16 ${50 - reach / 3}M52 34L63 ${43 - reach / 2}L70 ${49 - reach}`} strokeWidth="6"/><path d={`M39 56L33 70L30 81M49 56L55 ${70 - reach / 12}L59 81`} strokeWidth="7"/><path d="M29 82L36 82M57 82L64 82" strokeWidth="5"/></g>}
  </svg>;
}

function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={onChange}><span /></button>;
}

export default function App() {
  const [asset, setAsset] = useState<CharacterAsset>(() => createDemoCharacter('humanoid'));
  const [studio, setStudio] = useState<Studio>(() => ({ title: 'A little hello', keys: createDemoKeys(asset), duration: 4, settings: { ...DEFAULT_SETTINGS } }));
  const [time, setTime] = useState(0.8);
  const { theme, toggleTheme } = useTheme();
  const [fps, setFps] = useState(30);
  const [playing, setPlaying] = useState(false);
  const [selectedBone, setSelectedBone] = useState<number | null>(null);
  const [showRig, setShowRig] = useState(true);
  const [showGhosts, setShowGhosts] = useState(false);
  const [cameraView, setCameraView] = useState<'perspective' | 'front' | 'side'>('perspective');
  const [tool, setTool] = useState<'move' | 'rotate'>('move');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [rigKind, setRigKind] = useState<RigKind>('humanoid');
  const [busy, setBusy] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [engineChoice, setEngineChoice] = useState<EngineProvider['id']>('owned_humanoid');
  const [physicsChoice, setPhysicsChoice] = useState<EngineProvider['id']>('physics');
  const [progress, setProgress] = useState<number | null>(null);
  const engineOperation = useRef<AbortController | null>(null);
  const exportOperation = useRef<AbortController | null>(null);
  const [unrealCapability, setUnrealCapability] = useState<UnrealExportCapability | null>(null);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportCancelling, setExportCancelling] = useState(false);
  const [exportSummary, setExportSummary] = useState<{ warnings: string[]; error?: string; cancelled?: boolean } | null>(null);
  const seed = useRef(42);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Saved on this device');
  const [rootMotion, setRootMotion] = useState<'preserve' | 'extract' | 'in-place'>('preserve');
  const [retarget, setRetarget] = useState<'none' | 'manny' | 'metahuman'>('none');
  const [targetMesh, setTargetMesh] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [agentConnection, setAgentConnection] = useState<AgentConnection>({ connected: false });
  const [agentActivity, setAgentActivity] = useState<{ method: string; status: 'running' | 'done' | 'error' | 'cancelled'; message?: string } | null>(null);
  const agentController = useRef<AbortController | null>(null);
  const agentEditor = useRef<AgentEditor | null>(null);
  const viewportAPI = useRef<ViewportAPI | null>(null);
  const agentSnapshot = useRef<() => Record<string, unknown>>(() => ({}));
  const agentVersion = useRef({ asset, studio, fps, revision: 0 });
  if (agentVersion.current.asset !== asset || agentVersion.current.studio !== studio || agentVersion.current.fps !== fps) {
    agentVersion.current = { asset, studio, fps, revision: agentVersion.current.revision + 1 };
  }
  const [sparks, setSparks] = useState<{ id: number; x: number; y: number }[]>([]);
  const history = useRef<{ past: Studio[]; future: Studio[] }>({ past: [], future: [] });
  const importInput = useRef<HTMLInputElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const assetRef = useRef(asset);
  const durationRef = useRef(studio.duration);
  const timeRef = useRef(time);
  const operation = useRef(0);
  const dirty = useRef(false);
  const saveGeneration = useRef(0);
  const embedded = useMemo(() => embedCharacter(asset), [asset]);
  const motionKeys = studio.generated ?? studio.keys;
  const playbackMode = studio.generated ? 'linear' : studio.settings.interpolation;
  const currentPose = useMemo(() => samplePose(motionKeys, time, playbackMode), [motionKeys, playbackMode, time]);
  const compatible = (provider: EngineProvider) => !(provider.limits?.humanoidOnly && asset.kind !== 'humanoid') && !(provider.limits?.quadrupedOnly && asset.kind !== 'quadruped');
  const learnedProviders = engine?.providers.filter(provider => provider.kind !== 'physics' && provider.learned && compatible(provider)) ?? [];
  const learnedProvider = learnedProviders.find(provider => provider.id === engineChoice) ?? learnedProviders[0];
  const physicsProviders = engine?.providers.filter(provider => (provider.kind === 'physics' || provider.id === 'physics') && compatible(provider)) ?? [];
  const physicsProvider = physicsProviders.find(provider => provider.id === physicsChoice) ?? physicsProviders[0];
  const needsReview = (studio.generation?.metrics.quality as { requiresReview?: boolean } | undefined)?.requiresReview === true;
  const selectedKey = studio.keys.find(key => Math.abs(key.time - time) < 0.5 / fps);
  const keyIndex = selectedKey ? studio.keys.indexOf(selectedKey) : -1;
  const shownKeys = useMemo(() => studio.keys.length <= 8 ? studio.keys : simplifyKeys(studio.keys, 6), [studio.keys]);
  const ghostPoses = useMemo(() => showGhosts ? [samplePose(motionKeys, Math.max(0, time - .22), playbackMode), samplePose(motionKeys, Math.min(studio.duration, time + .22), playbackMode)] : [], [showGhosts, motionKeys, studio.duration, playbackMode, time]);
  const selectedRotation = useMemo(() => {
    if (selectedBone === null || !currentPose[selectedBone]) return [0, 0, 0];
    const e = new Euler().setFromQuaternion(new Quaternion().fromArray(currentPose[selectedBone].quaternion), 'XYZ');
    return [e.x, e.y, e.z].map(v => Math.round(MathUtils.radToDeg(v) * 10) / 10);
  }, [selectedBone, currentPose]);

  useEffect(() => { durationRef.current = studio.duration; }, [studio.duration]);
  useEffect(() => { timeRef.current = time; }, [time]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void getEngineStatus().then(status => { if (alive) setEngine(status); }); };
    refresh(); const timer = setInterval(refresh, 20000);
    return () => { alive = false; clearInterval(timer); engineOperation.current?.abort(); exportOperation.current?.abort(); };
  }, []);
  useEffect(() => {
    const previous = assetRef.current;
    assetRef.current = asset;
    if (previous.root !== asset.root) disposeCharacter(previous);
  }, [asset]);

  const notify = useCallback((message: string) => { setNotice(message); }, []);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timer); } }, [notice]);
  const commit = useCallback((next: Studio, message?: string) => {
    // Editing a key invalidates its generated in-betweens, keeping the simple pose timeline.
    if (next.keys !== studio.keys && next.generated === studio.generated) next = { ...next, generated: undefined, generation: undefined };
    history.current.past.push(clone({ ...studio, rigKind: asset.kind }));
    if (history.current.past.length > 60) history.current.past.shift();
    history.current.future = [];
    dirty.current = true;
    setHistoryVersion(v => v + 1); setStudio(next);
    if (next.rigKind) setAsset(current => current.kind === next.rigKind ? current : { ...current, kind: next.rigKind! });
    if (message) notify(message);
  }, [studio, asset.kind, notify]);

  const changeSettings = (patch: Partial<MotionSettings>) => commit({ ...studio, ...(patch.interpolation ? { generated: undefined, generation: undefined } : {}), settings: { ...studio.settings, ...patch } });
  const simplifyMotion = () => commit({ ...studio, sourceClip: null, keys: simplifyKeys(studio.keys, 6), settings: { ...studio.settings, interpolation: 'smooth' } }, 'Reduced to six key moments. Undo restores the full animation.');
  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(clone({ ...studio, rigKind: asset.kind }));
    setStudio(previous); setTime(t => Math.min(t, previous.duration)); setPlaying(false); setHistoryVersion(v => v + 1); dirty.current = true;
    if (previous.rigKind) setAsset(current => ({ ...current, kind: previous.rigKind! }));
  }, [studio, asset.kind]);
  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(clone({ ...studio, rigKind: asset.kind })); setStudio(next); setTime(t => Math.min(t, next.duration)); setPlaying(false); setHistoryVersion(v => v + 1); dirty.current = true;
    if (next.rigKind) setAsset(current => ({ ...current, kind: next.rigKind! }));
  }, [studio, asset.kind]);

  const documentFor = useCallback((): ProjectDocument => ({ version: 1, name: studio.title, duration: studio.duration, fps, keys: studio.keys, generated: studio.generated, generation: studio.generation, settings: studio.settings, sourceClip: studio.sourceClip ?? null, boneNames: asset.bones.map(b => b.name), character: embedded }), [studio, fps, asset, embedded]);
  const restoreDocument = useCallback(async (input: unknown, signal?: AbortSignal) => {
    const document = validateProject(input);
    const nextAsset = document.character.type === 'demo'
      ? createDemoCharacter(document.character.kind)
      : await restoreCharacter(document.character.object, document.character.kind, document.character.name);
    if (nextAsset.bones.length !== document.boneNames.length || nextAsset.bones.some((b, i) => b.name !== document.boneNames[i])) {
      disposeCharacter(nextAsset); throw new Error('The saved skeleton does not match its pose data.');
    }
    if (signal?.aborted) { disposeCharacter(nextAsset); signal.throwIfAborted(); }
    const apply = () => {
      setAsset(nextAsset); setStudio({ title: document.name, keys: document.keys, generated: document.generated, generation: document.generation, duration: document.duration, settings: document.settings, sourceClip: document.sourceClip != null && document.sourceClip < nextAsset.clips.length ? document.sourceClip : null });
      setFps(document.fps); setTime(0); setSelectedBone(null); setPlaying(false);
      history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = false;
    };
    if (signal) flushSync(apply); else apply();
  }, []);

  useEffect(() => {
    let cancelled = false;
    listArchives().then(entries => { if (!cancelled) setArchives(entries); }).catch(() => {});
    loadLocal().then(async saved => { if (saved && !cancelled) await restoreDocument(saved); }).catch(() => { if (!cancelled) setSaveStatus('Local recovery unavailable'); }).finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [restoreDocument]);

  useEffect(() => {
    if (!hydrated) return;
    const generation = ++saveGeneration.current;
    dirty.current = true;
    setSaveStatus('Saving…');
    const timer = setTimeout(() => {
      saveLocal(documentFor()).then(() => { if (generation === saveGeneration.current) { setSaveStatus('Saved on this device'); dirty.current = false; } }).catch(() => { if (generation === saveGeneration.current) setSaveStatus('Save a project file to keep changes'); });
    }, 750);
    return () => clearTimeout(timer);
  }, [documentFor, hydrated]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = 0; let previous = performance.now();
    const tick = (now: number) => { const delta = Math.min((now - previous) / 1000, .1); previous = now; setTime(t => (t + delta) % durationRef.current); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  useEffect(() => {
    if (dialog) { if (!dialogRef.current?.open) dialogRef.current?.showModal(); setPlaying(false); }
    else dialogRef.current?.close();
  }, [dialog]);

  useEffect(() => {
    if (dialog !== 'export') return;
    const controller = new AbortController();
    setUnrealCapability(null); setExportSummary(null);
    void getUnrealExportCapability(controller.signal).then(capability => { if (!controller.signal.aborted) setUnrealCapability(capability); });
    return () => controller.abort();
  }, [dialog]);

  const writePose = useCallback((pose: Pose) => {
    setPlaying(false);
    const snapped = Math.min(studio.duration, Math.round(timeRef.current * fps) / fps);
    const existing = studio.keys.find(key => Math.abs(key.time - snapped) < .5 / fps);
    const nextKey: PoseKey = { id: existing?.id ?? uid(), time: existing?.time ?? snapped, pose: clone(pose), label: existing?.label ?? 'New pose' };
    const keys = [...studio.keys.filter(key => key.id !== existing?.id), nextKey].sort((a, b) => a.time - b.time);
    commit({ ...studio, sourceClip: null, keys }); setTime(nextKey.time);
  }, [studio, fps, commit]);

  const addKey = useCallback(() => { writePose(currentPose); notify(selectedKey ? 'Pose updated. The motion follows automatically.' : 'New pose added. The motion follows automatically.'); }, [writePose, currentPose, selectedKey, notify]);
  const deleteKey = useCallback(() => {
    if (!selectedKey || studio.keys.length <= 2) return;
    commit({ ...studio, sourceClip: null, keys: studio.keys.filter(k => k.id !== selectedKey.id) }, 'Pose removed. Undo is always here.');
  }, [selectedKey, studio, commit]);

  const saveProject = useCallback(() => {
    try { downloadFile(JSON.stringify(documentFor()), `${studio.title.trim() || 'Untitled'}.still`, 'application/json'); dirty.current = false; notify('Editable project saved, with your character included.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save this project.'); }
  }, [documentFor, studio.title, notify]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]') || dialog || busy || !hydrated) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); }
      else if (event.code === 'Space') { event.preventDefault(); setPlaying(v => !v); }
      else if (event.key.toLowerCase() === 'k') { event.preventDefault(); addKey(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteKey(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); setTime(t => Math.max(0, Math.min(studio.duration, t + (event.key === 'ArrowLeft' ? -1 : 1) / fps))); }
      else if (event.key.toLowerCase() === 'w') setTool('move');
      else if (event.key.toLowerCase() === 'e') setTool('rotate');
      else if (event.key === 'Escape') setSelectedBone(null);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, busy, hydrated, redo, undo, saveProject, addKey, deleteKey, studio.duration, fps]);

  const handleImport = async (file: File) => {
    if (busy) return;
    const ticket = ++operation.current;
    setBusy(`Opening ${file.name}…`); setError(null); setPlaying(false);
    let nextAsset: CharacterAsset | undefined;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('Use a file smaller than 200 MB for a responsive editing session.');
      if (/\.(still|json)$/i.test(file.name)) {
        await preserveScene();
        await restoreDocument(JSON.parse(await file.text())); setDialog(null); notify('Your project is right where you left it.'); return;
      }
      nextAsset = await importCharacter(file);
      if (ticket !== operation.current) { disposeCharacter(nextAsset); return; }
      let keys: PoseKey[];
      let animationError: string | null = null;
      let importedAnimation = false;
      let duration = 4;
      if (nextAsset.clips.length) {
        try { keys = sampleClip(nextAsset, nextAsset.clips[0]); duration = Math.max(nextAsset.clips[0].duration, 1 / fps); importedAnimation = true; }
        catch (e) { keys = [{ id: uid(), time: 0, pose: clone(nextAsset.restPose) }, { id: uid(), time: 4, pose: clone(nextAsset.restPose) }]; animationError = `Character loaded, but its animation was not imported. ${e instanceof Error ? e.message : 'This animation could not be sampled.'}`; nextAsset.warnings.push(animationError); }
      } else keys = [{ id: uid(), time: 0, pose: clone(nextAsset.restPose) }, { id: uid(), time: 4, pose: clone(nextAsset.restPose) }];
      await preserveScene();
      setAsset(nextAsset); setStudio({ title: file.name.replace(/\.[^.]+$/, ''), keys, duration, settings: { ...DEFAULT_SETTINGS, interpolation: importedAnimation ? 'linear' : 'smooth' }, sourceClip: importedAnimation ? 0 : null });
      setTime(0); setSelectedBone(null); history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1);
      dirty.current = true;
      if (!nextAsset.rigged) { setRigKind('humanoid'); setDialog('rig'); }
      else { setDialog(null); if (animationError) setError(animationError); else notify(importedAnimation ? `${keys.length} frames preserved. Simplify to six poses to edit the key moments.` : 'Character ready. Its original rig and skin weights are preserved.'); }
    } catch (e) { if (nextAsset && nextAsset !== assetRef.current) disposeCharacter(nextAsset); setError(e instanceof Error ? e.message : 'That file could not be opened. Try an FBX or GLB.'); }
    finally { setBusy(null); if (importInput.current) importInput.current.value = ''; }
  };

  const switchClip = (index: number) => {
    try {
      const clip = asset.clips[index]; const keys = sampleClip(asset, clip);
      commit({ ...studio, keys, duration: Math.max(clip.duration, 1 / fps), settings: { ...studio.settings, interpolation: 'linear' }, sourceClip: index }, `Loaded ${clip.name || `animation ${index + 1}`}. Your previous edits are available with Undo.`);
      setTime(0); setPlaying(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this animation.'); }
  };

  const preserveScene = async () => {
    try { await archiveLocal(documentFor()); setArchives(await listArchives()); }
    catch { throw new Error('Your current scene could not be backed up. Save a .still file and free browser storage before replacing it.'); }
  };

  const openArchive = async (id: string) => {
    if (busy) return;
    setBusy('Restoring your scene…');
    try {
      const saved = await readArchive(id);
      await preserveScene(); await restoreDocument(saved); setDialog(null); notify('Previous scene restored. Your other scene is backed up too.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restore that scene.'); }
    finally { setBusy(null); }
  };

  const createNew = async (kind: RigKind, blank = false) => {
    if (busy) return;
    setBusy('Making room for your next move…');
    try {
    await preserveScene();
    const next = createDemoCharacter(kind); const keys = blank ? [{ id: uid(), time: 0, pose: clone(next.restPose) }, { id: uid(), time: 4, pose: clone(next.restPose) }] : createDemoKeys(next);
    setAsset(next); setStudio({ title: blank ? 'My next move' : kind === 'humanoid' ? 'A little hello' : 'Four little steps', keys, duration: 4, settings: { ...DEFAULT_SETTINGS } });
    setTime(blank ? 0 : .8); setSelectedBone(null); setPlaying(false); setDialog(null);
    history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = true; notify('Fresh canvas. Make it move.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start a new scene.'); }
    finally { setBusy(null); }
  };

  const makeRig = async () => {
    setBusy('Fitting the skeleton and skin weights…');
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      const next = autoRigCharacter(asset, rigKind); setAsset({ ...next });
      const keys = [{ id: uid(), time: 0, pose: clone(next.restPose) }, { id: uid(), time: studio.duration, pose: clone(next.restPose) }];
      setStudio({ ...studio, keys }); setSelectedBone(null); setTime(0); setDialog(null);
      history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = true; notify('Rig fitted to your geometry. Try a small bend at the shoulders, elbows and knees.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The rig could not be fitted.'); }
    finally { setBusy(null); }
  };

  const exportGLB = async () => {
    setBusy('Packing your character and motion…'); setPlaying(false);
    try {
      const clip = buildAnimationClip(asset, motionKeys, studio.duration, { ...studio.settings, interpolation: playbackMode });
      const binary = await exportCharacterGLB(asset, clip);
      downloadFile(binary, `${studio.title.trim() || 'animation'}.glb`, 'model/gltf-binary'); setDialog(null); notify('Animated GLB exported. Ready for Blender, game engines, and the web.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The animation could not be exported.'); }
    finally { applyPose(asset, currentPose); setBusy(null); }
  };

  const exportUnreal = async () => {
    if (busy || !asset.rigged || !unrealCapability?.available || exportOperation.current) return;
    const controller = new AbortController(); exportOperation.current = controller;
    setExportRunning(true); setExportCancelling(false); setExportSummary(null); setError(null); setPlaying(false);
    setBusy('Packing your character and motion…'); setProgress(0);
    try {
      // Match the preview, including generated/physics frames and their interpolation.
      const clip = buildAnimationClip(asset, motionKeys, studio.duration, { ...studio.settings, interpolation: playbackMode });
      const binary = await exportCharacterGLB(asset, clip);
      controller.signal.throwIfAborted();
      const name = studio.title.trim() || 'Animation';
      const result = await exportUnrealPackage(binary, { name, fps, rootMotion, retarget, ...(targetMesh.trim() ? { targetMesh: targetMesh.trim() } : {}) }, (message, fraction) => {
        if (!controller.signal.aborted) { setBusy(message); setProgress(fraction); }
      }, controller.signal);
      controller.signal.throwIfAborted();
      downloadFile(result.package, `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-Unreal.zip`, 'application/zip');
      setExportSummary({ warnings: result.warnings });
      notify('Unreal package downloaded. Unzip it and follow the included import guide.');
    } catch (e) {
      if (controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) setExportSummary({ warnings: [], cancelled: true });
      else setExportSummary({ warnings: [], error: e instanceof Error ? e.message : 'The Unreal package could not be exported.' });
    } finally {
      applyPose(asset, currentPose); exportOperation.current = null; setExportRunning(false); setExportCancelling(false); setProgress(null); setBusy(null);
    }
  };

  const cancelUnrealExport = () => {
    setExportCancelling(true); setBusy('Cancelling the export…'); exportOperation.current?.abort();
  };

  const assistMotion = async () => {
    setBusy('Finding a little more balance…'); setPlaying(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    try { const keys = applyPhysics(asset, studio.keys, studio.settings); commit({ ...studio, keys, sourceClip: null }, 'Quick ground pass applied. Play it back, or Undo to compare.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not apply motion assistance.'); }
    finally { applyPose(asset, currentPose); setBusy(null); }
  };

  const runMotionEngine = async (provider: EngineProvider) => {
    if (busy || !asset.rigged) return;
    setError(null); setPlaying(false);
    if (provider.limits?.humanoidOnly && asset.kind !== 'humanoid') { setError(`${provider.name} currently supports human characters. Your quadruped can still use curve interpolation and physics correction.`); return; }
    if (provider.limits?.quadrupedOnly && asset.kind !== 'quadruped') { setError(`${provider.name} needs a four-legged rig.`); return; }
    if (provider.limits?.maxDuration && studio.duration > provider.limits.maxDuration) { setError(`${provider.name} supports clips up to ${provider.limits.maxDuration} seconds. Shorten this clip before generating.`); return; }
    const controller = new AbortController(); engineOperation.current = controller;
    setBusy(provider.learned ? 'Preparing your key moments…' : 'Preparing the physical character…'); setProgress(0);
    await new Promise(resolve => setTimeout(resolve, 40));
    try {
      controller.signal.throwIfAborted();
      const anchors = studio.keys.length > 24 ? simplifyKeys(studio.keys, 6) : studio.keys;
      const settings = { ...studio.settings, interpolation: playbackMode, ...(provider.limits?.earthGravityOnly ? { gravity: 9.81 } : {}), ...(provider.limits?.requiresFloorContact ? { floorContact: true } : {}) };
      const request = makeMotionRequest(asset, motionKeys, anchors, studio.duration, settings, provider.id, seed.current++);
      const result = await generateMotion(request, (message, fraction) => { setBusy(message); setProgress(fraction); }, controller.signal);
      controller.signal.throwIfAborted();
      const generated = restoreEngineFrames(asset, motionKeys, anchors, result, playbackMode, studio.duration, provider.learned);
      const keys = provider.learned ? anchors : anchors.map(key => ({ ...key, pose: samplePose(generated, key.time, 'linear') }));
      const review = (result.metrics?.quality as { requiresReview?: boolean } | undefined)?.requiresReview === true;
      commit({ ...studio, keys, generated, generation: { name: result.provider?.name ?? provider.name, kind: request.kind, metrics: { ...result.metrics, requestedSettings: settings }, warnings: result.warnings ?? [] }, sourceClip: null }, provider.learned ? 'AI motion is ready. Your key poses are preserved. Play it, or Undo to compare.' : review ? 'Physics returned a correction that needs review. Open the pass details before exporting.' : 'Dynamics correction is ready. Play it, or Undo to compare.');
    } catch (e) {
      if (controller.signal.aborted) notify('Cancelled. Your animation is unchanged.');
      else setError(e instanceof Error ? e.message : 'The motion engine could not finish. Your animation is unchanged.');
    } finally { applyPose(asset, currentPose); engineOperation.current = null; setProgress(null); setBusy(null); void getEngineStatus().then(setEngine); }
  };

  const retryNativeCleanup = async () => {
    setBusy('Restoring the Cascadeur workspace…'); setError(null);
    try { await recoverNativeEngine(); notify('Cascadeur cleanup completed. Native engines are available again.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Native cleanup could not finish.'); }
    finally { setEngine(await getEngineStatus()); setBusy(null); }
  };

  const scrub = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect(); if (!rect) return;
    setPlaying(false); setTime(Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * studio.duration * fps) / fps);
  };
  const retimeKey = (id: string, clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect(); if (!rect) return;
    const nextTime = Math.max(0, Math.min(studio.duration, Math.round((clientX - rect.left) / rect.width * studio.duration * fps) / fps));
    if (studio.keys.some(k => k.id !== id && Math.abs(k.time - nextTime) < .5 / fps)) { notify('There is already a pose at that frame.'); return; }
    commit({ ...studio, sourceClip: null, keys: studio.keys.map(k => k.id === id ? { ...k, time: nextTime } : k).sort((a, b) => a.time - b.time) }); setTime(nextTime);
  };
  const changeDuration = (value: number) => {
    if (!Number.isFinite(value) || value < .1 || value > 120) return;
    commit({ ...studio, sourceClip: null, duration: value, keys: studio.keys.map(k => ({ ...k, time: k.time * value / studio.duration })) });
    setTime(t => Math.min(value, t * value / studio.duration));
  };

  agentSnapshot.current = () => ({
    revision: agentVersion.current.revision,
    project: { name: studio.title, duration: studio.duration, fps },
    character: { name: asset.name, kind: asset.kind, rigged: asset.rigged, boneCount: asset.bones.length },
    timeline: { time, playing, keyCount: studio.keys.length, generatedFrames: studio.generated?.length ?? 0 },
    view: { cameraView, showRig, showGhosts, tool, selectedBone },
    history: { canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 },
    providers: engine?.providers ?? [], busy, progress,
  });
  agentEditor.current = {
    asset, studio, time, fps, pose: currentPose, snapshot: () => agentSnapshot.current(), document: documentFor,
    archive: preserveScene,
    restore: async (document, signal) => { await restoreDocument(document, signal); },
    replace: (next, nextStudio, nextTime = 0) => flushSync(() => {
      setAsset(next); setStudio(nextStudio); setTime(nextTime); setSelectedBone(null); setPlaying(false); setDialog(null);
      history.current = { past: [], future: [] }; setHistoryVersion(value => value + 1); dirty.current = true;
    }),
    commit: next => flushSync(() => commit(next)),
    timeline: (nextTime, nextFps) => flushSync(() => { setTime(nextTime); setPlaying(false); if (nextFps !== undefined) setFps(nextFps); }),
    play: next => flushSync(() => setPlaying(next)),
    view: patch => flushSync(() => {
      if (patch.cameraView !== undefined) setCameraView(patch.cameraView);
      if (patch.showRig !== undefined) setShowRig(patch.showRig);
      if (patch.showGhosts !== undefined) setShowGhosts(patch.showGhosts);
      if (patch.tool !== undefined) setTool(patch.tool);
      if (patch.selectedBone !== undefined) setSelectedBone(patch.selectedBone);
    }),
    viewport: viewportAPI.current,
    undo: () => flushSync(undo), redo: () => flushSync(redo),
    progress: (message, fraction) => { setBusy(message); setProgress(fraction); },
  };

  useEffect(() => {
    if (!hydrated) return;
    return connectAgentBridge({
      name: 'Still editor', getState: () => agentSnapshot.current(), onConnection: setAgentConnection,
      execute: async (command, bridgeSignal) => {
        const readOnly = READ_COMMANDS.has(command.method);
        if (!agentEditor.current) throw new Error('The editor is still opening.');
          // Skeleton inspection evaluates transforms on the shared Three.js asset.
          // Keep it outside UI generation/export even though it restores its pose.
          if (agentController.current || (!readOnly || command.method === 'skeleton.inspect') && agentSnapshot.current().busy) throw Object.assign(new Error('The editor is busy. Finish or cancel its current operation first.'), { code: 'EDITOR_BUSY' });
        if (command.expectedRevision !== undefined && command.expectedRevision !== agentVersion.current.revision) throw Object.assign(new Error(`The scene changed. Expected revision ${command.expectedRevision}, current revision ${agentVersion.current.revision}. Inspect the scene before retrying.`), { code: 'REVISION_CONFLICT' });
        const controller = new AbortController(); agentController.current = controller;
        const signal = AbortSignal.any([bridgeSignal, controller.signal]);
        let result: Record<string, unknown>;
        flushSync(() => {
          setAgentActivity({ method: command.method, status: 'running' });
          if (!readOnly) { setPlaying(false); setDialog(null); setBusy(`Agent · ${command.method}`); setProgress(null); }
        });
        try {
          result = await executeAgentCommand(agentEditor.current!, command.method, command.params, signal);
          setAgentActivity({ method: command.method, status: 'done' });
        } catch (error) {
          setAgentActivity({ method: command.method, status: signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : 'Command failed.' });
          throw error;
        } finally {
          agentController.current = null;
          flushSync(() => { if (!readOnly) { setBusy(null); setProgress(null); } });
          // Synchronous history commits may already have rendered the new pose
          // before numerical/export helpers restore their temporary old pose.
          const latest = agentEditor.current;
          if (!readOnly && latest) applyPose(latest.asset, latest.pose);
        }
        return { ...result, revision: agentVersion.current.revision, ...(Object.hasOwn(result, 'busy') ? { busy: agentSnapshot.current().busy, progress: agentSnapshot.current().progress } : {}) };
      },
    });
  }, [hydrated]);
    camera: viewportAPI.current?.getCamera() ?? null,

  return <div className="studio-app" onDragOver={e => { e.preventDefault(); if (!busy) setDragOver(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }} onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) void handleImport(e.dataTransfer.files[0]); }} onClick={e => {
    if ((e.target as HTMLElement).closest('canvas, input, select, dialog') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = performance.now(); setSparks(s => [...s.slice(-5), { id, x: e.clientX, y: e.clientY }]); setTimeout(() => setSparks(s => s.filter(v => v.id !== id)), 700);
  }}>
    <header className="topbar">
      <a className="wordmark" href="#" aria-label="Still home" onClick={e => { e.preventDefault(); setDialog('new'); }}><span className="brand-symbol"><img src="/still-icon.png" alt=""/></span>still<span className="wordmark-dot">.</span></a>
      <div className="header-divider" />
      <div className="project-heading"><input aria-label="Project name" value={studio.title} maxLength={80} onChange={e => { dirty.current = true; setStudio({ ...studio, title: e.target.value }); }}/><ChevronDown size={13}/><span className="local-badge">LOCAL PROJECT</span></div>
      <div className="header-right"><span className="save-status"><span className="status-dot"/>{saveStatus}</span><button className="icon-button theme-toggle" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><button className={`button agent-button ${agentConnection.connected ? 'connected' : ''}`} aria-label="Agent scripting" onClick={() => setDialog('agent')}><span className="status-dot"/>Agent</button><div className="history-tools" data-version={historyVersion}><button className="icon-button" title="Undo · Ctrl Z" aria-label="Undo" disabled={!history.current.past.length} onClick={undo}><Undo2 size={17}/></button><button className="icon-button" title="Redo · Ctrl Shift Z" aria-label="Redo" disabled={!history.current.future.length} onClick={redo}><Redo2 size={17}/></button></div><button className="button export-button" onClick={() => setDialog('export')}><ArrowUpRight size={16}/>Export<span className="key-hint">↗</span></button></div>
    </header>

    <div className="workspace">
      <aside className="left-sidebar">
        <div className="sidebar-section intro-section"><div className="eyebrow">A LITTLE STILL. A LOT OF MOTION.</div><h1>Make your<br/>next move<span>.</span></h1><p>A few poses. Endless possibilities.</p></div>
        <div className="sidebar-section character-section"><div className="section-heading"><h2>Your character</h2><button className="icon-button" title="Start a new scene" aria-label="New scene" onClick={() => setDialog('new')}><Plus size={17}/></button></div>
          <div className="character-card"><div className="character-art"><div className="orbit-ring one"/><div className="orbit-ring two"/><PoseSketch index={1} quadruped={asset.kind === 'quadruped'}/><span className="character-spark">✳</span></div><div className="character-details"><strong title={asset.name}>{asset.name}</strong><span>{asset.source === 'demo' ? 'Your practice partner' : 'Original character'}</span></div><span className="ready-dot" title="Loaded"/></div>
          <div className="rig-status"><ShieldCheck size={14}/>{asset.rigged ? asset.source === 'import' ? 'Original rig preserved' : `${asset.kind === 'humanoid' ? 'Human' : 'Quadruped'} rig, ready to move` : 'Ready for a simple rig'}<span>{asset.bones.length} joints</span></div>
          <button className="import-button" onClick={() => setDialog('import')}><Upload size={17}/><span>Import a character</span><span className="plus-small">+</span></button>
          <div className="format-note">FBX, GLB, or a saved Still project</div>
        </div>

        <button className="mobile-inspector-toggle" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(v => !v)}><SlidersHorizontal size={15}/>Character &amp; joint controls{asset.warnings.length > 0 && <span>{asset.warnings.length} notes</span>}<ChevronDown size={14}/></button><div className="inspector-body" data-open={inspectorOpen}><div className="sidebar-section animation-section"><div className="section-heading"><h2>Animation</h2><span className="tiny-badge">{studio.keys.length} POSES</span></div>
          {asset.clips.length > 0 ? <label className="clip-select"><Activity size={15}/><select aria-label="Animation clip" value={studio.sourceClip ?? -1} onChange={e => { if (Number(e.target.value) >= 0) switchClip(Number(e.target.value)); }}><option value={-1}>Edited motion</option>{asset.clips.map((clip, index) => <option value={index} key={index}>{clip.name || `Animation ${index + 1}`}</option>)}</select></label> : <div className="animation-name"><span className="motion-icon"><Activity size={18}/></span><div><strong>{asset.source === 'demo' ? asset.kind === 'humanoid' ? 'A friendly wave' : 'An easy stride' : 'Your motion'}</strong><span>{studio.duration.toFixed(1)} seconds · {fps} fps</span></div><Check size={14}/></div>}
          {asset.source === 'import' && asset.rigged && <label className="clip-select">Moves like<select aria-label="Character body type" value={asset.kind} disabled={!!busy} onChange={e => { commit({ ...studio, rigKind: e.target.value as RigKind, generated: undefined, generation: undefined }, 'Motion mapping updated. Generate again for this body type; your original rig is preserved.'); }}><option value="humanoid">Two legs</option><option value="quadruped">Four legs</option></select></label>}
          {asset.warnings.length > 0 && <details className="import-notes"><summary>Import notes ({asset.warnings.length})</summary>{asset.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
        </div>

        <div className="sidebar-section selection-section"><div className="section-heading"><h2>{selectedBone === null ? 'Make it yours' : 'Selected joint'}</h2><MousePointer2 size={14}/></div>
          {selectedBone === null ? <div className="selection-empty"><div className="little-pointer"><Move size={23}/></div><strong>Grab a joint. Try something.</strong><p>Drag the dots on your character.<br/>The rest of the limb follows along.</p><button className="text-button" onClick={() => setSelectedBone(Math.max(0, asset.bones.findIndex(b => /righthand/i.test(b.name))))} disabled={!asset.bones.length}>Try the right hand <ArrowRight size={13}/></button></div> : <div className="joint-controls"><select aria-label="Selected joint" value={selectedBone} onChange={e => setSelectedBone(Number(e.target.value))}>{asset.bones.map((bone, index) => <option key={index} value={index}>{niceName(bone.name)}</option>)}</select><div className="axis-fields">{['X', 'Y', 'Z'].map((axis, i) => <label key={axis}><span>{axis}</span><input type="number" aria-label={`${axis} joint rotation`} step="5" value={selectedRotation[i]} onChange={e => { if (e.target.value === '') return; const value = Number(e.target.value); if (!Number.isFinite(value)) return; const values = [...selectedRotation]; values[i] = value; const pose = clone(currentPose); pose[selectedBone].quaternion = new Quaternion().setFromEuler(new Euler(...values.map(MathUtils.degToRad) as [number, number, number], 'XYZ')).toArray(); writePose(pose); }}/><small>°</small></label>)}</div><button className="text-button" onClick={() => { const pose = clone(currentPose); pose[selectedBone] = clone(asset.restPose[selectedBone]); writePose(pose); }}><RotateCcw size={13}/>Reset this joint</button><p className="micro-copy">Changes become a pose automatically.</p></div>}
        </div>
        </div><button className="help-card" onClick={() => setDialog('help')}><span className="help-illustration"><Hand size={22}/></span><span><strong>First time animating?</strong><small>You’re in the right place.</small></span><ArrowUpRight size={16}/></button>
        <div className="sidebar-footer"><span className="small-brand">STILL STUDIO</span><span>Made for making.</span></div>
      </aside>

      <main className="editor">
        <div className="scene-heading"><div><span className="scene-dot"/>YOUR PLAYGROUND<span className="scene-separator">/</span><span className="scene-name">{studio.title || 'Untitled'}</span></div><button className="text-button" onClick={() => setDialog('help')}><CircleHelp size={14}/><span>A quick tour</span></button></div>
        <div className="stage-and-assists">
          <section className="viewport-shell" aria-label="Character editor">
            <Viewport theme={theme} apiRef={viewportAPI} asset={asset} pose={currentPose} selectedBone={selectedBone} onSelectBone={index => { setPlaying(false); setSelectedBone(index); }} onPoseChange={writePose} showRig={showRig} showGhosts={showGhosts} ghostPoses={ghostPoses} cameraView={cameraView} tool={tool} playing={playing}/>
            <div className="viewport-top"><div className="mode-pill"><span className={playing ? 'live-dot' : 'mode-dot'}/>{playing ? 'In motion' : 'Pose mode'}<span>{selectedKey ? `Pose ${keyIndex + 1}` : 'Between poses'}</span></div><button className={`icon-button viewport-icon ${showGhosts ? 'active' : ''}`} aria-label="Toggle onion skin" aria-pressed={showGhosts} title="Show neighboring poses" onClick={() => setShowGhosts(v => !v)}><Layers2 size={17}/></button></div>
            <div className="viewport-tools"><button aria-label="Move joint" title="Move joint · W" className={tool === 'move' ? 'active' : ''} onClick={() => setTool('move')}><Move size={18}/></button><button aria-label="Rotate joint" title="Rotate joint · E" className={tool === 'rotate' ? 'active' : ''} onClick={() => setTool('rotate')}><RotateCw size={18}/></button><div/><button aria-label="Show joints" title="Show joints" aria-pressed={showRig} className={showRig ? 'active secondary' : ''} onClick={() => setShowRig(v => !v)}><Bone size={18}/></button></div>
            <div className="viewport-label"><span className="viewport-kicker">LESS LEARNING. MORE MAKING.</span><span className="viewport-big-word">Let’s move.</span></div>
            <div className="viewport-bottom"><span className="viewport-instruction"><MousePointer2 size={13}/>{selectedBone !== null ? `${niceName(asset.bones[selectedBone]?.name || '')} selected · drag to pose` : 'Drag a joint to pose · drag the background to orbit'}</span><div className="view-picker">{(['perspective', 'front', 'side'] as const).map(view => <button key={view} className={cameraView === view ? 'active' : ''} onClick={() => setCameraView(view)}>{view === 'perspective' ? '3D' : view.charAt(0).toUpperCase() + view.slice(1)}</button>)}</div></div>
            {!asset.rigged && <div className="rig-overlay"><Bone size={24}/><strong>Let’s give it some joints.</strong><p>Choose a simple skeleton to start posing.</p><button className="button primary" onClick={() => setDialog('rig')}>Add a rig <ArrowRight size={15}/></button></div>}
          </section>

          <aside className="assist-panel"><div className="assist-heading"><span className="assist-icon"><Sparkles size={19}/></span><span className="eyebrow">A LITTLE HELP</span><h2>You pose.<br/>We connect the dots.</h2><p>Good motion starts with a few good moments.</p></div>
            {engine?.recovery && <div className="assist-section generation-details needs-review" role="alert"><p>{engine.recovery.message}</p><button className="button assist-button" disabled={!!busy || !engine.recovery.canRetry} onClick={() => void retryNativeCleanup()}>Retry cleanup <RotateCcw size={14}/></button></div>}
            {getAutoRigDiagnostics(asset) && <details className="assist-section generation-details"><summary>Rig fit checks</summary><p>{getAutoRigDiagnostics(asset)?.evidence === 'clear' ? 'Body landmarks found.' : 'Some body landmarks were estimated.'} Try a small bend before animating.</p>{getAutoRigDiagnostics(asset)?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}<div className="assist-section ai-section"><div className="section-heading"><h3>AI in-betweening</h3><span className={`engine-tag ${learnedProvider ? 'ready' : ''}`}>{learnedProvider ? 'ON DEVICE' : 'NOT READY'}</span></div><p className="micro-copy">A trained motion model fills the space between your poses.</p>{learnedProviders.length > 1 && <select className="engine-select" aria-label="AI motion engine" value={learnedProvider?.id} onChange={e => setEngineChoice(e.target.value as EngineProvider['id'])}>{learnedProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>}<button className="button primary generate-button" disabled={!learnedProvider || !asset.rigged || !!busy} onClick={() => learnedProvider && void runMotionEngine(learnedProvider)}><Sparkles size={15}/>{studio.generated ? 'Generate another take' : studio.keys.length > 24 ? 'Find 6 poses & generate' : 'Generate motion'}<ArrowRight size={14}/></button><p className="engine-caption">{learnedProvider ? `${learnedProvider.name} · your key poses stay exact` : engine ? (asset.kind === 'humanoid' ? 'No validated humanoid model is installed. Use curve interpolation, or open licensed Cascadeur with its bridge for AI.' : 'No validated animal model is installed. Curve interpolation is available.') : 'Start the local engine to enable AI.'}{learnedProvider?.id === 'owned_humanoid' && ' · Limited motion coverage'}{learnedProvider?.id === 'inbetween' && ' · Commercial rights pending'}</p>{studio.generation && <details className={`generation-details ${needsReview ? 'needs-review' : ''}`}><summary><Check size={12}/>{needsReview ? 'Motion · review needed' : studio.generation.kind === 'inbetween' ? 'AI take ready' : 'Dynamics pass ready'}<span>{studio.generated?.length} frames</span></summary><p>{studio.generation.name}. Editing a pose returns to your key moments; generate again to update the motion.</p>{studio.generation.warnings.map((warning, i) => <p key={i}>{warning}</p>)}<button className="text-button" onClick={() => downloadFile(JSON.stringify(studio.generation, null, 2), 'motion-generation-report.json', 'application/json')}>Save generation report <ArrowDownToLine size={12}/></button></details>}</div>

            <div className="assist-section physics-section"><div className="section-heading"><h3>Physics correction</h3><span className={`engine-tag ${physicsProvider ? 'ready' : ''}`}>{physicsProvider ? 'DYNAMICS' : 'OFFLINE'}</span></div>{physicsProviders.length > 1 && <select className="engine-select" aria-label="Physics engine" value={physicsProvider?.id} onChange={e => setPhysicsChoice(e.target.value as EngineProvider['id'])}>{physicsProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>}<div className="setting-row"><div><Footprints size={15}/><span>Keep feet planted</span></div><Switch label="Floor contact" checked={physicsProvider?.limits?.requiresFloorContact || studio.settings.floorContact} disabled={physicsProvider?.limits?.requiresFloorContact} onChange={() => changeSettings({ floorContact: !studio.settings.floorContact })}/></div><div className="setting-row"><label htmlFor="gravity">Gravity</label><select id="gravity" disabled={physicsProvider?.limits?.earthGravityOnly} value={physicsProvider?.limits?.earthGravityOnly ? 9.81 : studio.settings.gravity} onChange={e => changeSettings({ gravity: Number(e.target.value) })}><option value="9.81">Earth</option><option value="1.62">Moon</option><option value="0">Weightless</option></select></div><div className="strength-label"><label htmlFor="strength">A helping hand</label><span>{Math.round(studio.settings.strength * 100)}%</span></div><input id="strength" type="range" min="0" max="1" step=".05" value={studio.settings.strength} onChange={e => changeSettings({ strength: Number(e.target.value) })}/><button className="button assist-button" disabled={!physicsProvider || !asset.rigged || !!busy} onClick={() => physicsProvider && void runMotionEngine(physicsProvider)}><Activity size={15}/>Correct with physics<ArrowRight size={14}/></button><p className="micro-copy physics-note">{physicsProvider?.id === 'cascadeur_physics' ? 'Native AutoPhysics · Earth gravity and floor contacts. Applies the solver result to every frame.' : physicsProvider ? 'Articulated dynamics, gravity, and contact forces. Poses may shift to improve balance.' : 'Start the local engine to enable dynamics.'}</p><button className="text-button quick-ground" disabled={!asset.rigged || !!busy} onClick={() => void assistMotion()}>Quick ground pass <Footprints size={12}/></button></div>
            <details className="assist-section curve-section"><summary>Curve interpolation<span>{studio.settings.interpolation === 'smooth' ? 'Smooth' : studio.settings.interpolation === 'linear' ? 'Direct' : 'Hold'}</span><ChevronDown size={12}/></summary><div className="blend-options">{(['smooth', 'linear', 'stepped'] as InterpolationMode[]).map(mode => <button key={mode} className={studio.settings.interpolation === mode ? 'active' : ''} onClick={() => changeSettings({ interpolation: mode })}>{mode === 'smooth' ? 'Smooth' : mode === 'linear' ? 'Direct' : 'Hold'}</button>)}</div><div className={`curve-preview ${studio.settings.interpolation}`}><svg viewBox="0 0 220 52" aria-hidden="true"><path className="curve-guide" d="M8 44H212M8 26H212M8 8H212"/><path className="curve-path" d={studio.settings.interpolation === 'smooth' ? 'M8 44C84 44 116 8 212 8' : studio.settings.interpolation === 'linear' ? 'M8 44L212 8' : 'M8 44H110V8H212'}/><circle cx="8" cy="44" r="4"/><circle cx="212" cy="8" r="4"/></svg><span>POSE A</span><span>POSE B</span></div><p className="micro-copy">{studio.settings.interpolation === 'smooth' ? 'Soft starts. Natural arcs. Your poses stay yours.' : studio.settings.interpolation === 'linear' ? 'A direct, constant-speed blend between poses.' : 'Hold each pose until the next. Great for blocking.'}</p></details>
            <div className="simplify-card"><span className="six-dots">•••<br/>•••</span><div><strong>Find the key moments.</strong><p>Turn a busy timeline into six editable poses.</p></div><button className="text-button" disabled={studio.keys.length <= 6} onClick={simplifyMotion}>Simplify to 6 poses <ArrowUpRight size={13}/></button></div>
          </aside>
        </div>

        <section className="timeline-section" aria-label="Animation timeline"><div className="timeline-heading"><div className="timeline-title"><h2>Your moments</h2><span>{studio.keys.length} poses<span className="timeline-dot">·</span>{studio.generation?.kind === 'inbetween' ? 'AI motion ready' : studio.generated ? 'dynamics applied' : 'one fluid motion'}</span></div><div className="timeline-actions">{studio.keys.length > 6 && <button className="button simplify-timeline" onClick={simplifyMotion}><Sparkles size={13}/><span>Simplify to 6</span></button>}<button className="icon-button" title="Delete selected pose" aria-label="Delete selected pose" disabled={!selectedKey || studio.keys.length <= 2} onClick={deleteKey}><Trash2 size={15}/></button><button className="button add-pose-button" disabled={!asset.rigged} onClick={addKey}><Plus size={15}/>{selectedKey ? 'Update pose' : 'Add a pose'}<kbd>K</kbd></button></div></div>
          <div className="pose-cards">{shownKeys.map((key) => <button className={`pose-card ${selectedKey?.id === key.id ? 'selected' : ''}`} key={key.id} onClick={() => { setPlaying(false); setTime(key.time); }} aria-label={`Go to pose ${studio.keys.findIndex(k => k.id === key.id) + 1}`}><div className="pose-card-top"><span>{String(studio.keys.findIndex(k => k.id === key.id) + 1).padStart(2, '0')}</span><span className="key-diamond"/></div><PoseThumbnail asset={asset} pose={key.pose}/><div className="pose-card-caption"><span>{key.label || `Pose ${studio.keys.findIndex(k => k.id === key.id) + 1}`}</span><span>{key.time.toFixed(2)}s</span></div></button>)}<button className="new-pose-card" title="Add a pose at the playhead" disabled={!asset.rigged} onClick={addKey}><Plus size={19}/><span>A new moment</span></button></div>
          <div className="scrubber" ref={timeline} onPointerDown={e => { if ((e.target as HTMLElement).closest('.timeline-key')) return; e.currentTarget.setPointerCapture(e.pointerId); scrub(e.clientX); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e.clientX); }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}><div className="ruler-labels">{Array.from({ length: 9 }, (_, i) => <span key={i}>{(studio.duration * i / 8).toFixed(1)}<small>s</small></span>)}</div><div className="timeline-track"><div className="timeline-progress" style={{ width: `${time / studio.duration * 100}%` }}/>{studio.keys.map((key, i) => <button key={key.id} className={`timeline-key ${selectedKey?.id === key.id ? 'selected' : ''}`} style={{ left: `${key.time / studio.duration * 100}%` }} aria-label={`Pose ${i + 1} at ${key.time.toFixed(2)} seconds. Drag to retime.`} title={`Pose ${i + 1} · ${key.time.toFixed(2)}s · drag to retime`} onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.startX = String(e.clientX); setPlaying(false); setTime(key.time); }} onPointerUp={e => { e.stopPropagation(); e.currentTarget.releasePointerCapture(e.pointerId); if (Math.abs(e.clientX - Number(e.currentTarget.dataset.startX)) > 4) retimeKey(key.id, e.clientX); }}/>)}</div><div className="playhead" style={{ left: `${time / studio.duration * 100}%` }}><span/></div><input className="accessible-scrubber" aria-label="Timeline playhead" type="range" min="0" max={studio.duration} step={1 / fps} value={time} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }}/></div>
          <div className="transport"><div className="playback-buttons"><button className="icon-button" aria-label="Go to beginning" onClick={() => { setPlaying(false); setTime(0); }}><SkipBack size={15}/></button><button className="icon-button" aria-label="Previous frame" onClick={() => { setPlaying(false); setTime(t => Math.max(0, t - 1 / fps)); }}><ChevronLeft size={19}/></button><button className="play-button" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</button><button className="icon-button" aria-label="Next frame" onClick={() => { setPlaying(false); setTime(t => Math.min(studio.duration, t + 1 / fps)); }}><ChevronRight size={19}/></button><button className="icon-button" aria-label="Go to end" onClick={() => { setPlaying(false); setTime(studio.duration); }}><SkipForward size={15}/></button><span className="timecode">{time.toFixed(2)}<span>/ {studio.duration.toFixed(2)} s</span></span></div><span className="transport-tip"><kbd>space</kbd> to play. Curiosity to create.</span><div className="duration-controls"><label><input aria-label="Animation duration seconds" type="number" min=".1" max="120" step=".5" value={Number(studio.duration.toFixed(3))} onChange={e => changeDuration(Number(e.target.value))}/>sec</label><select aria-label="Frames per second" value={fps} onChange={e => setFps(Number(e.target.value))}><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></div></div>
        </section>
        <footer className="editor-footer"><span><span className="status-dot"/>Everything stays on your device.</span><div className="ticker"><span>SMALL MOVES. BIG POSSIBILITIES. &nbsp;✳&nbsp; YOUR CHARACTER. YOUR WAY. &nbsp;✳&nbsp; SMALL MOVES. BIG POSSIBILITIES. &nbsp;✳&nbsp; YOUR CHARACTER. YOUR WAY.</span></div><button onClick={() => setDialog('help')}><Keyboard size={13}/><span>Shortcuts</span></button></footer>
      </main>
    </div>

    <input ref={importInput} type="file" className="hidden" accept=".fbx,.glb,.gltf,.still,.json" aria-label="Import file" onChange={e => { if (e.target.files?.[0]) void handleImport(e.target.files[0]); }}/>
    {dragOver && <div className="drop-overlay"><Upload size={38}/><h2>Drop it like it’s a character.</h2><p>FBX, GLB, or a Still project</p></div>}
    {(!hydrated || busy) && <div className="busy-overlay" role="status"><LoaderCircle size={24} className="spin"/><strong>{busy || 'Setting the stage…'}</strong>{agentActivity?.status === 'running' && <>{progress !== null && <progress className="engine-progress" aria-label="Agent command progress" max="1" value={progress}/>}<button className="button secondary" onClick={() => agentController.current?.abort()}>Stop agent command</button></>}{progress !== null && !exportRunning && agentActivity?.status !== 'running' && <><progress className="engine-progress" aria-label="Motion generation progress" max="1" value={progress}/><button className="button secondary" onClick={() => engineOperation.current?.abort()}>Cancel generation</button></>}</div>}
    {notice && <div className="toast" role="status"><Check size={17}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14}/></button></div>}
    {error && <div className="error-toast" role="alert"><CircleHelp size={19}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={16}/></button></div>}
    {sparks.map(s => <span className="click-spark" key={s.id} style={{ left: s.x, top: s.y }}>✳</span>)}

    <dialog ref={dialogRef} className={`modal ${dialog === 'help' ? 'help-modal' : ''}`} onCancel={e => { if (exportRunning) e.preventDefault(); else setDialog(null); }} onClick={e => { if (e.target === e.currentTarget && !exportRunning) setDialog(null); }}><div className="modal-inner"><button className="icon-button modal-close" aria-label="Close dialog" disabled={exportRunning} onClick={() => setDialog(null)}><X size={19}/></button>
      {dialog === 'agent' && <><span className="modal-icon"><Keyboard size={25}/></span><div className="eyebrow">YOUR AGENT. YOUR ANIMATION.</div><h2>Make moves<br/>with a little code.</h2><p>Give an AI agent control of this scene through local scripts or MCP. It can inspect joints, edit poses, run AI and physics, save projects, and export to Unreal.</p><div className="modal-tip"><span className="status-dot"/><span><strong>{agentConnection.connected ? 'Ready for scripts' : 'Waiting for the local service'}</strong><br/>{agentConnection.connected ? 'This tab can stay in the background while your agent works.' : agentConnection.error || 'Start Still with its launcher to connect.'}</span></div>{agentConnection.sessionId && <p className="agent-session">Session: {agentConnection.sessionId}</p>}<p>Start in the project folder:</p><pre className="agent-command">node scripts/still-agent.mjs sessions{`\n`}node scripts/still-agent.mjs schema</pre><p>Give your agent <strong>docs/agent-scripting.md</strong>. For MCP, launch <strong>node scripts/still-mcp.mjs</strong> from your agent’s MCP configuration.</p><div className="agent-actions"><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(`Use Still's local agent API to work on my animation. Read docs/agent-scripting.md in the Still project. Target session ${agentConnection.sessionId || '(list sessions first)'}. Inspect the scene and schema before changing it, use expectedRevision for edits, and save a .still backup before replacing my work.`).then(() => notify('Instructions copied for your agent.')).catch(() => notify('Select the session ID and use docs/agent-scripting.md.')); }}><Copy size={15}/>Copy agent instructions</button></div><div className="agent-last">{agentActivity ? <><strong>{agentActivity.status === 'done' ? 'Completed' : agentActivity.status === 'error' ? 'Needs attention' : agentActivity.status === 'cancelled' ? 'Stopped' : 'Working'} · {agentActivity.method}</strong>{agentActivity.message && <p>{agentActivity.message}</p>}</> : 'Pose edits use Undo. Replacing a scene keeps a Recent scenes backup. Access stays on this computer.'}</div></>}
      {dialog === 'import' && <><span className="modal-icon"><Upload size={25}/></span><div className="eyebrow">BRING YOUR CHARACTER</div><h2>Already has a rig?<br/>Keep it.</h2><p>Drop in your Mixamo FBX or a GLB. Your skeleton and skin weights stay intact, so you can get straight to moving.</p><button className="modal-dropzone" onClick={() => importInput.current?.click()}><Upload size={27}/><strong>Choose a file, or drop it here</strong><span>FBX · GLB · .still project · up to 150 MB</span></button><div className="modal-tip"><ShieldCheck size={19}/><span>For Mixamo, download <strong>FBX Binary → With Skin</strong>. Embedded textures work best.</span></div><p className="micro-copy">No skeleton? You can fit a basic human or quadruped rig after importing. Upright, neutral poses work best.</p></>}
      {dialog === 'export' && <><span className="modal-icon"><ArrowUpRight size={25}/></span><div className="eyebrow">TAKE YOUR MOTION WITH YOU</div><h2>Made a move?<br/>Make it useful.</h2><p>Take your character and the motion you’re previewing into your next project.</p>
        <button className={`export-choice unreal-export ${unrealCapability?.available && asset.rigged ? 'recommended' : ''}`} disabled={!asset.rigged || !unrealCapability?.available || !!busy} onClick={() => void exportUnreal()} aria-describedby="unreal-export-note"><Box size={24}/><span><strong>Unreal Engine · FBX</strong><small>Character + animation + textures + import guide</small><span className="export-recommendation">{!asset.rigged ? 'A rig is needed first' : unrealCapability?.available ? 'Recommended for Unreal' : unrealCapability === null ? 'Checking local exporter…' : 'Exporter unavailable'}</span></span>{unrealCapability === null ? <LoaderCircle size={19} className="spin"/> : <Download size={19}/>}</button>
        <div className="unreal-options"><label>Movement<select value={rootMotion} onChange={event => setRootMotion(event.target.value as typeof rootMotion)}><option value="preserve">Original movement</option><option value="extract">Gameplay root motion</option><option value="in-place">In place</option></select></label><label>Unreal character<select value={retarget} onChange={event => setRetarget(event.target.value as typeof retarget)}><option value="none">My original skeleton</option><option value="manny">Manny / Quinn</option><option value="metahuman">MetaHuman body</option></select></label>{retarget !== 'none' && <label>Target skeletal mesh{retarget === 'manny' ? ' (optional)' : ''}<input maxLength={512} value={targetMesh} onChange={event => setTargetMesh(event.target.value)} placeholder="/Game/Characters/MyBody.MyBody"/><small>{retarget === 'manny' ? 'The import helper can find Manny in your Unreal project.' : 'Choose the body mesh asset path from your Unreal project.'}</small></label>}</div><p id="unreal-export-note" className="export-caption">{!asset.rigged ? 'Fit a rig before Unreal export. Close this dialog and choose Add a rig.' : unrealCapability?.available ? `ZIP package · ${fps} fps · ${rootMotion === 'extract' ? 'Gameplay root motion' : rootMotion === 'in-place' ? 'In place' : 'Original movement'}` : unrealCapability?.reason || (unrealCapability === null ? 'Checking this computer’s export tools.' : 'Start Still with its launcher to enable Unreal export.')}</p>
        {exportSummary && <div className={`export-result ${exportSummary.error ? 'export-error' : ''}`} role={exportSummary.error ? 'alert' : 'status'}><strong>{exportSummary.error ? <CircleHelp size={15}/> : <Check size={15}/>}{exportSummary.error ? 'Export could not finish' : exportSummary.cancelled ? 'Export cancelled' : 'Unreal package downloaded'}</strong><p>{exportSummary.error || (exportSummary.cancelled ? 'Your character and animation are unchanged.' : 'Unzip the package and follow its import guide. Import the character first, then its animation onto the same skeleton.')}</p>{exportSummary.warnings.length > 0 && <details open><summary>Export notes</summary>{exportSummary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}</div>}
        {needsReview && <div className="modal-tip"><CircleHelp size={18}/><span>This motion has review flags. Check the pass details and playback before using the exported animation.</span></div>}
        <button className="export-choice" onClick={() => void exportGLB()}><Box size={24}/><span><strong>Animated character</strong><small>GLB · mesh, skeleton, and baked animation</small></span><Download size={19}/></button><button className="export-choice" onClick={saveProject}><Save size={24}/><span><strong>Editable Still project</strong><small>.still · character, poses, and settings</small></span><Download size={19}/></button><div className="modal-tip"><ShieldCheck size={19}/><span>The package preserves your original rig. Its Unreal import helper can also create a retargeted animation for Manny or your MetaHuman body mesh.</span></div></>}
      {dialog === 'new' && <><span className="modal-icon"><Sparkles size={25}/></span><div className="eyebrow">A FRESH START</div><h2>What’s your<br/>next move?</h2><p>Try a practice character, start from a blank pose, or bring one of your own. Your last five replaced scenes stay available here on this device. Save a project file for a permanent copy.</p><button className="button secondary full-width" onClick={saveProject}><Save size={16}/>Save current project</button><div className="new-choices"><button onClick={() => createNew('humanoid')}><PoseSketch index={3}/><strong>A friendly wave</strong><span>Human · 6 poses</span></button><button onClick={() => createNew('quadruped')}><PoseSketch quadruped/><strong>Four little steps</strong><span>Quadruped · 6 poses</span></button></div><button className="export-choice compact" onClick={() => createNew('humanoid', true)}><Plus size={20}/><span><strong>Start from a blank pose</strong></span><ArrowRight size={17}/></button><button className="export-choice compact" onClick={() => setDialog('import')}><Upload size={20}/><span><strong>Import your own character</strong></span><ArrowRight size={17}/></button></>}
      {dialog === 'new' && archives.length > 0 && <div className="recent-scenes"><h3>Recent scenes</h3>{archives.map(entry => <button key={entry.id} onClick={() => void openArchive(entry.id)}><RotateCcw size={13}/><span>{entry.name}</span><small>{new Date(entry.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></button>)}</div>}
      {dialog === 'rig' && <><span className="modal-icon"><Bone size={25}/></span><div className="eyebrow">A SIMPLE STARTING SKELETON</div><h2>A little structure.<br/>A lot of freedom.</h2><p>Pick the shape that fits your character. We’ll fit joints to the shape of your mesh and blend the skin around its limbs.</p><div className="new-choices rig-choices">{(['humanoid', 'quadruped'] as RigKind[]).map(kind => <button key={kind} className={rigKind === kind ? 'selected' : ''} onClick={() => setRigKind(kind)}><PoseSketch quadruped={kind === 'quadruped'}/><strong>{kind === 'humanoid' ? 'Two legs' : 'Four legs'}</strong><span>{kind === 'humanoid' ? 'Upright human · A or T pose' : 'Animal · head facing +Z'}</span></button>)}</div><div className="modal-tip"><CircleHelp size={19}/><span>Use an upright, neutral pose. Geometry fitting checks the skin binding; inspect a small bend before making larger poses.</span></div><button className="button primary full-width" onClick={() => void makeRig()} disabled={asset.rigged}>Fit my rig <ArrowRight size={16}/></button></>}
      {dialog === 'help' && <><span className="modal-icon"><Hand size={25}/></span><div className="eyebrow">YOU ALREADY KNOW ENOUGH</div><h2>Three steps.<br/>Your first animation.</h2><div className="tour-step"><span>01</span><div><strong>Bring a character.</strong><p>Use the practice partner or import an FBX from Mixamo. Existing rigs are preserved.</p></div></div><div className="tour-step"><span>02</span><div><strong>Make a few moments.</strong><p>Move the playhead. Drag a joint into place. Your pose is saved automatically. Drag a diamond to change its timing.</p></div></div><div className="tour-step"><span>03</span><div><strong>Let them flow.</strong><p>Choose Generate motion to fill the gaps with AI. Preview with Space, correct with physics, then export an animated GLB.</p></div></div><div className="shortcut-grid"><span><kbd>Space</kbd>Play / pause</span><span><kbd>K</kbd>Save a pose</span><span><kbd>W / E</kbd>Move / rotate</span><span><kbd>← →</kbd>One frame</span><span><kbd>Ctrl Z</kbd>Undo</span><span><kbd>Ctrl S</kbd>Save project</span></div><p className="help-honesty">AI in-betweening runs trained human or animal motion models on this computer. The owned models have limited training coverage; inspect difficult contacts and acrobatics. Physics offers articulated-body correction and native Cascadeur AutoPhysics when installed. Curve interpolation and the quick ground pass are lightweight procedural tools. Generated motion stays separate from your editable key poses.</p><button className="button primary full-width" onClick={() => setDialog(null)}>Let’s make something move <ArrowRight size={16}/></button></>}
      {busy && <div className="modal-busy" role="status"><LoaderCircle size={25} className="spin"/><strong>{busy}</strong>{exportRunning && <><progress className="engine-progress" aria-label="Unreal export progress" max="1" value={progress ?? 0}/><button className="button secondary" disabled={exportCancelling} onClick={cancelUnrealExport}>{exportCancelling ? 'Cancelling…' : 'Cancel export'}</button><p className="micro-copy">Preparing the package locally. Your animation stays unchanged.</p></>}</div>}
    </div></dialog>
  </div>;
}
