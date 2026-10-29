import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme';
import './unreal-export.css';
import './agent-scripting.css';
import './timeline.css';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bone, Box, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, Download, Expand, Footprints, Hand, Keyboard, Layers2, Leaf, LoaderCircle, Maximize2, MousePointer2, Move, Move3d, Pause, Play, Plus, Redo2, RotateCcw, RotateCw, Save, Settings2, Shirt, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Spline, Trash2, Undo2, Upload, X } from 'lucide-react';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import Viewport from './components/Viewport';
import type { ViewportAPI } from './components/Viewport';
import { connectAgentBridge } from './engine/agentBridge';
import type { AgentConnection } from './engine/agentBridge';
import { executeAgentCommand, READ_COMMANDS } from './engine/agentCommands';
import type { AgentEditor } from './engine/agentCommands';
import PoseThumbnail from './components/PoseThumbnail';
import AnimationTracks from './components/AnimationTracks';
import { activeTrack, combinedInterpolation, combinedKeys, coveringTrackNames, createAnimationTrack, createLayerSampler, editableKeys, editAnimationTrack, fitEmptyTracks, putLayerKey, recordTrackKey, trackEditDuration, trackFields, underlyingTrackSampler } from './engine/tracks';
import PhysicsComparison from './components/PhysicsComparison';
import SceneLibrary from './components/SceneLibrary';
import KeyframeProperties from './components/KeyframeProperties';
import FaceShapes from './components/FaceShapes';
import ClipTools from './components/ClipTools';
import AnimationImport from './components/AnimationImport';
import MotionLibrary from './components/MotionLibrary';
import { saveMotionMapping } from './engine/motionLibrary';
import HandRigSetup from './components/HandRigSetup';
import PartFit from './components/PartFit';
import CreatureRigSetup from './components/CreatureRigSetup';
import AnimationSources from './components/AnimationSources';
import { DEFAULT_CREATURE_RIG, type CreatureRigOptions } from './engine/creatureRig';
import { isFingerBone } from './engine/handRig';
import type { AnatomicalFit } from './engine/anatomicalRig';
import { assertMatchingRig, composeMotion, editMotion, rangeSpeedTime } from './engine/clipEditing';
import type { ClipEdit, MotionSequence } from './engine/clipEditing';
import UpdatesDialog, { useUpdates } from './components/UpdatesDialog';
import { applyPose, autoRigCharacter, createDemoCharacter, createRigPreview, disposeCharacter, estimateAutoRig, exportCharacterGLB, getAutoRigDiagnostics, importCharacter, restoreCharacter, swapCharacterLook } from './engine/character';
import { applyPhysics, buildAnimationClip, createDemoKeys, sampleClip, samplePose, simplifyKeys } from './engine/motion';
import { DEFAULT_FOLLOW_FEEL } from './engine/followChain';
import { generateMotion, getEngineStatus, makeMotionRequest, restoreEngineFrames } from './engine/assistance';
import type { EngineProvider, EngineStatus } from './engine/assistance';
import { exportUnrealPackage, getUnrealExportCapability, isUnrealAssetPath, readExportPreference, rememberExportPreference } from './engine/unrealExport';
import type { UnrealExportCapability } from './engine/unrealExport';
import { archiveLocal, downloadFile, editScene, embedCharacter, initializeCharacterLibrary, listArchives, listCharacters, listScenes, loadSession, readArchive, readCharacter, readScene, renameCharacter, saveLocal, saveSceneCopy, validateProject } from './engine/project';
import type { ArchiveEntry, SceneEntry, SceneWriteToken } from './engine/project';
import type { CharacterEntry } from './engine/characterLibrary';
import { characterFingerprint } from './engine/characterLibrary';
import { sceneThumbnail } from './engine/sceneThumbnail';
import { DEFAULT_SETTINGS } from './types';
import { duplicateMoment, MAX_ANIMATION_DURATION, moveMoment, nearestFreeKeyTime, pasteMoments, rippleMoment } from './engine/keyframeEditing';
import { applyKeyframeProperty, offsetKeyframes, setModelPosition } from './engine/poseProperties';
import { morphKeyData } from './engine/morphs';
import type { PoseProperty, PoseReference, PropertyAxes } from './engine/poseProperties';
import type { AnimationTrack, CharacterAsset, InterpolationMode, MotionGeneration, MotionSettings, Pose, PoseKey, ProjectDocument, RigKind, TrackState, Vec3 } from './types';

interface Studio extends TrackState { title: string; keys: PoseKey[]; generated?: PoseKey[]; generation?: MotionGeneration; duration: number; settings: MotionSettings; sourceClip?: number | null; rigKind?: RigKind }
interface KeyDrag { id: string; pointerId: number; startX: number; startTime: number; time: number; beforeTime: number; moved: boolean; ripple: boolean; result?: { keys: PoseKey[]; duration: number; time: number }; studio: Studio; asset: CharacterAsset; fps: number }
type Dialog = 'import' | 'animation' | 'export' | 'help' | 'shortcuts' | 'viewport' | 'rig' | 'new' | 'agent' | 'updates' | 'physics' | 'library' | null;
const SHORTCUTS = [['S', 'Toggle Select / regular mode'], ['Esc or V', 'Return to regular mode'], ['R', 'Toggle Ripple editing'], ['M', 'Move selected keyframe to a time'], ['Space', 'Play / pause'], ['← / →', 'Step one frame'], ['Home / End', 'Go to clip start / end'], ['K', 'Add or update a pose'], ['Ctrl C / V', 'Copy / paste keyframes'], ['Ctrl D', 'Duplicate current keyframe'], ['Ctrl A', 'Select all keyframes'], ['Delete', 'Delete selected keyframes'], ['Ctrl Z', 'Undo'], ['Ctrl Shift Z / Ctrl Y', 'Redo'], ['Ctrl S', 'Save scene'], ['Ctrl Shift S', 'Export a .still backup'], ['G', 'Move the whole model'], ['W / E', 'Move / rotate joints'], ['F', 'Follow: a moved head drags its neck along'], ['? or F1', 'Show keyboard shortcuts']];
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
  const { theme, toggleTheme } = useTheme();
  const updateState = useUpdates();
  const [asset, setAsset] = useState<CharacterAsset>(() => createDemoCharacter('humanoid'));
  const [studio, setStudio] = useState<Studio>(() => ({ title: 'A little hello', keys: createDemoKeys(asset), duration: 4, settings: { ...DEFAULT_SETTINGS } }));
  const [time, setTime] = useState(0.8);
  const [fps, setFps] = useState(30);
  const [playing, setPlaying] = useState(false);
  const [comparisonView, setComparisonView] = useState<'before' | 'split' | 'after'>('after');
  const [dragPreview, setDragPreview] = useState<{ id: string; time: number; keys: PoseKey[]; duration: number; ripple: boolean } | null>(null);
  const [ripple, setRipple] = useState(false);
  const [keyClipboard, setKeyClipboard] = useState<{ keys: PoseKey[]; character: string; channels?: AnimationTrack['channels']; morphs?: string[] } | null>(null);
  const [moveTime, setMoveTime] = useState('');
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [timelineToolsOpen, setTimelineToolsOpen] = useState(false);
  const [durationInput, setDurationInput] = useState('4');
  const [timelineWindow, setTimelineWindow] = useState(4);
  const [timelineStart, setTimelineStart] = useState(0);
  useEffect(() => { setDurationInput(String(Number(studio.duration.toFixed(3)))); }, [studio.duration]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [poseReference, setPoseReference] = useState<(PoseReference & { storedPose?: Pose }) | null>(null);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const selectionDrag = useRef<{ pointerId: number; start: number; previous: Set<string>; base: Set<string> } | null>(null);
  const keyDrag = useRef<KeyDrag | null>(null);
  const [selectedBone, setSelectedBone] = useState<number | null>(null);
  const [showRig, setShowRig] = useState(true);
  const [showFingerJoints, setShowFingerJoints] = useState(false);
  const [showGhosts, setShowGhosts] = useState(false);
  const [cameraView, setCameraView] = useState<'perspective' | 'front' | 'side'>('perspective');
  const [tool, setTool] = useState<'move' | 'rotate'>('move');
  const [moveModel, setMoveModel] = useState(false);
  const [follow, setFollow] = useState(() => {
    try { return localStorage.getItem('still.follow') === 'true'; } catch { return false; }
  });
  const [followFeel, setFollowFeel] = useState(() => {
    try { const saved = localStorage.getItem('still.follow-feel'); return saved !== null && Number.isFinite(Number(saved)) ? Math.max(0, Math.min(1, Number(saved))) : DEFAULT_FOLLOW_FEEL; } catch { return DEFAULT_FOLLOW_FEEL; }
  });
  useEffect(() => { try { localStorage.setItem('still.follow', String(follow)); localStorage.setItem('still.follow-feel', String(followFeel)); } catch { /* Keep the session preference if storage is unavailable. */ } }, [follow, followFeel]);
  const [zoomToCursor, setZoomToCursor] = useState(() => {
    try { return localStorage.getItem('still.zoom-to-cursor') !== 'false'; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem('still.zoom-to-cursor', String(zoomToCursor)); } catch { /* Keep the session preference if storage is unavailable. */ } }, [zoomToCursor]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [animationImportMode, setAnimationImportMode] = useState<'apply' | 'append'>('apply');
  const [libraryPreview, setLibraryPreview] = useState<{ keys: PoseKey[]; duration: number; name: string } | null>(null);
  const [libraryImportFile, setLibraryImportFile] = useState<File | null>(null);
  const [libraryImportClipIndex, setLibraryImportClipIndex] = useState(0);
  const [libraryFitError, setLibraryFitError] = useState<string | null>(null);
  const [rigKind, setRigKind] = useState<RigKind>('humanoid');
  const [rigFingers, setRigFingers] = useState(true);
  const [creatureRig, setCreatureRig] = useState<CreatureRigOptions>({ ...DEFAULT_CREATURE_RIG });
  const [rigDraft, setRigDraft] = useState<{ preview: CharacterAsset; initial: AnatomicalFit; fit: AnatomicalFit; source: CharacterAsset } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [engineChoice, setEngineChoice] = useState<EngineProvider['id']>('motionbricks');
  const [physicsChoice, setPhysicsChoice] = useState<EngineProvider['id']>('physics');
  const [progress, setProgress] = useState<number | null>(null);
  const engineOperation = useRef<AbortController | null>(null);
  const exportOperation = useRef<AbortController | null>(null);
  const [unrealCapability, setUnrealCapability] = useState<UnrealExportCapability | null>(null);
  const [rootMotion, setRootMotion] = useState<'preserve' | 'extract' | 'in-place'>(() => { const saved = readExportPreference('root-motion'); return saved === 'preserve' || saved === 'in-place' ? saved : 'extract'; });
  const [retarget, setRetarget] = useState<'none' | 'manny' | 'metahuman' | 'skeleton'>(() => { const saved = readExportPreference('retarget'); return saved === 'manny' || saved === 'metahuman' || saved === 'skeleton' ? saved : 'none'; });
  const [targetMesh, setTargetMesh] = useState('');
  const [targetSkeleton, setTargetSkeleton] = useState(() => readExportPreference('target-skeleton'));
  const [referenceOverride, setReferenceOverride] = useState<{ sceneId: string; assetId: string; bytes: ArrayBuffer; name: string } | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [exportOptionError, setExportOptionError] = useState<string | null>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const [saveIntoFolder, setSaveIntoFolder] = useState(() => readExportPreference('save-into-folder') === 'true');
  const [exportFolder, setExportFolder] = useState(() => readExportPreference('folder'));
  const [exportRunning, setExportRunning] = useState(false);
  const [exportCancelling, setExportCancelling] = useState(false);
  const [exportSummary, setExportSummary] = useState<{ warnings: string[]; error?: string; cancelled?: boolean; existingSkeleton?: boolean; savedTo?: string; saveError?: string } | null>(null);
  const seed = useRef(42);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Saved on this device');
  const [dragOver, setDragOver] = useState(false);
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [scenes, setScenes] = useState<SceneEntry[]>([]);
  const [characters, setCharacters] = useState<CharacterEntry[]>([]);
  const [characterId, setCharacterId] = useState<string>();
  const [libraryCharacterId, setLibraryCharacterId] = useState<string>();
  const [hasActiveScene, setHasActiveScene] = useState(true);
  const currentCharacter = characters.find(character => character.id === characterId);
  const [sceneId, setSceneId] = useState<string>(uid);
  const activeSceneId = useRef(sceneId);
  activeSceneId.current = sceneId;
  const sceneTokens = useRef(new Map<string, SceneWriteToken>());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const [lookRevision, setLookRevision] = useState(0);
  // Fit a part previews on the live meshes; any dialog (Export above all) closes it, dropping an unapplied preview.
  useEffect(() => { if (dialog) setFitOpen(false); }, [dialog]);
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
  const lookInput = useRef<HTMLInputElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const timelineScroll = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const assetRef = useRef(asset);
  const durationRef = useRef(studio.duration);
  const timeRef = useRef(time);
  const operation = useRef(0);
  const dirty = useRef(false);
  const saveGeneration = useRef(0);
  const embedded = useMemo(() => embedCharacter(asset), [asset, lookRevision]);
  const editingTrack = activeTrack(studio);
  const editKeys = editableKeys(studio);
  const emptyTrack = !!editingTrack && !editingTrack.channels.length && !editingTrack.morphs.length;
  const trackMuted = editingTrack ? editingTrack.muted : !!studio.baseTrackMuted;
  const poseKeys = dragPreview?.keys ?? editKeys;
  const authoredEnd = Math.max(studio.keys.at(-1)!.time, ...(studio.tracks ?? []).filter(t => t.channels.length || t.morphs.length).map(t => t.keys.at(-1)!.time));
  const timelineDuration = libraryPreview?.duration ?? dragPreview?.duration ?? studio.duration;
  const previewStudio = useMemo(() => !dragPreview ? studio : editingTrack
    ? { ...studio, duration: dragPreview.duration, tracks: studio.tracks!.map(t => t.id === editingTrack.id ? { ...t, keys: dragPreview.keys } : t) }
    : { ...studio, duration: dragPreview.duration, keys: dragPreview.keys, generated: undefined }, [studio, dragPreview, editingTrack]);
  const baseMotionKeys = studio.generated ?? studio.keys;
  const basePlaybackMode = studio.generated ? 'linear' : studio.settings.interpolation;
  const motionKeys = useMemo(() => combinedKeys(previewStudio, asset.restPose, asset.restMorphs, fps), [previewStudio, asset, fps]);
  const playbackMode = combinedInterpolation(previewStudio);
  const sampleLayers = useMemo(() => createLayerSampler(previewStudio, asset.restPose, asset.restMorphs), [previewStudio, asset]);
  const currentPose = useMemo(() => sampleLayers(time).pose, [sampleLayers, time]);
  const visibleTimelineSeconds = Math.min(timelineWindow, timelineDuration);
  const rulerStep = visibleTimelineSeconds / 8;
  const rulerFirst = Math.max(0, Math.floor(Math.min(timelineStart, Math.max(0, timelineDuration - visibleTimelineSeconds)) / rulerStep) - 1);
  const rulerTimes = Array.from({ length: 12 }, (_, index) => (rulerFirst + index) * rulerStep).filter(value => value <= timelineDuration);
  if (timelineStart + visibleTimelineSeconds >= timelineDuration && !rulerTimes.some(value => Math.abs(value - timelineDuration) < 1e-8)) rulerTimes.push(timelineDuration);
  // A new scene starts fitted; changing its end keeps the current seconds-per-pixel scale.
  useEffect(() => { setTimelineWindow(studio.duration); setTimelineStart(0); }, [sceneId]);
  useEffect(() => {
    const scroll = timelineScroll.current, track = timeline.current;
    if (!scroll || !track || keyDrag.current || selectionDrag.current) return;
    const x = time / timelineDuration * track.clientWidth;
    if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 12) scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
  }, [time, timelineDuration, timelineWindow]);
  const comparison = studio.generated && studio.generation?.kind === 'physics' ? studio.generation.comparison : undefined;
  const viewingBefore = !!comparison && comparisonView === 'before' && !dragPreview;
  const viewingSplit = !!comparison && comparisonView === 'split' && !dragPreview;
  const beforePose = useMemo(() => comparison ? samplePose(comparison.before, time, comparison.interpolation) : undefined, [comparison, time]);
  const previewPose = libraryPreview ? samplePose(libraryPreview.keys, time, 'linear') : viewingBefore ? beforePose! : currentPose;
  useEffect(() => { setComparisonView(studio.generation?.comparison ? 'split' : 'after'); }, [studio.generation]);
  const compatible = (provider: EngineProvider) => asset.kind !== 'creature' && !(provider.limits?.humanoidOnly && asset.kind !== 'humanoid') && !(provider.limits?.quadrupedOnly && asset.kind !== 'quadruped');
  const learnedProviders = engine?.providers.filter(provider => provider.kind !== 'physics' && provider.learned && compatible(provider)) ?? [];
  const learnedProvider = learnedProviders.find(provider => provider.id === engineChoice) ?? learnedProviders[0];
  const learnedDurationLimit = learnedProvider?.limits?.maxDuration;
  const learnedClipTooLong = learnedDurationLimit !== undefined && studio.duration > learnedDurationLimit;
  const physicsProviders = engine?.providers.filter(provider => (provider.kind === 'physics' || provider.id === 'physics') && compatible(provider)) ?? [];
  const physicsProvider = physicsProviders.find(provider => provider.id === physicsChoice) ?? physicsProviders[0];
  const needsReview = !!studio.generated && (studio.generation?.metrics.quality as { requiresReview?: boolean } | undefined)?.requiresReview === true;
  const selectedKey = poseKeys.find(key => Math.abs(key.time - time) < 0.5 / fps);
  useEffect(() => { setMovingKey(null); }, [sceneId, selectedKey?.id]);
  useEffect(() => { setPoseReference(null); }, [asset.root, sceneId]);
  useEffect(() => { if (dialog !== 'rig') setRigDraft(null); }, [dialog]);
  useEffect(() => () => { if (rigDraft) disposeCharacter(rigDraft.preview); }, [rigDraft?.preview]);
  useEffect(() => {
    setPoseReference(reference => reference?.keyId && !editKeys.some(key => key.id === reference.keyId && JSON.stringify(key.pose) === JSON.stringify(reference.storedPose ?? reference.after)) ? null : reference);
  }, [editKeys]);
  useEffect(() => { cancelSelection(); setSelectedIds(new Set()); }, [editKeys, studio.activeTrackId, sceneId]);
  const keyIndex = selectedKey ? poseKeys.indexOf(selectedKey) : -1;
  const shownKeys = useMemo(() => {
    const shown = poseKeys.length <= 8 ? poseKeys : simplifyKeys(poseKeys, 6);
    return selectedKey && !shown.some(key => key.id === selectedKey.id) ? [...shown, selectedKey].sort((a, b) => a.time - b.time) : shown;
  }, [poseKeys, selectedKey]);
  const ghostPoses = useMemo(() => showGhosts ? [sampleLayers(Math.max(0, time - .22)).pose, sampleLayers(Math.min(studio.duration, time + .22)).pose] : [], [showGhosts, sampleLayers, studio.duration, time]);
  const selectedRotation = useMemo(() => {
    if (selectedBone === null || !currentPose[selectedBone]) return [0, 0, 0];
    const e = new Euler().setFromQuaternion(new Quaternion().fromArray(currentPose[selectedBone].quaternion), 'XYZ');
    return [e.x, e.y, e.z].map(v => Math.round(MathUtils.radToDeg(v) * 10) / 10);
  }, [selectedBone, currentPose]);

  function cancelKeyDrag(pointerId?: number) {
    const drag = keyDrag.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    keyDrag.current = null;
    setDragPreview(null);
    if (drag.studio === agentVersion.current.studio && drag.asset === agentVersion.current.asset && drag.fps === agentVersion.current.fps) setTime(Math.min(drag.beforeTime, drag.studio.duration));
    if (timeline.current?.hasPointerCapture(drag.pointerId)) timeline.current.releasePointerCapture(drag.pointerId);
  }
  function cancelSelection() {
    const drag = selectionDrag.current;
    if (drag) setSelectedIds(drag.previous);
    selectionDrag.current = null; setSelectionRange(null);
    if (drag && timeline.current?.hasPointerCapture(drag.pointerId)) timeline.current.releasePointerCapture(drag.pointerId);
  }
  const setTimelineMode = useCallback((selecting: boolean) => {
    setSelectionMode(selecting); setSelectedIds(new Set()); setRipple(false); setPlaying(false); setMovingKey(null); setMoveModel(false);
  }, []);
  const toggleModelMove = useCallback(() => {
    if (trackMuted) return;
    setTimelineMode(false); setSelectedBone(null); setMoveModel(!moveModel);
  }, [moveModel, setTimelineMode, trackMuted]);
  useEffect(() => {
    const drag = keyDrag.current;
    if (drag && (drag.studio !== studio || drag.asset !== asset || drag.fps !== fps || dialog || busy)) cancelKeyDrag();
    if (dialog || busy) cancelSelection();
  }, [studio, asset, fps, dialog, busy]);
  useEffect(() => {
    const cancel = () => { cancelKeyDrag(); cancelSelection(); setDragOver(false); };
    const clearDrop = () => setDragOver(false);
    window.addEventListener('blur', cancel);
    window.addEventListener('dragend', clearDrop);
    window.addEventListener('drop', clearDrop);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('dragend', clearDrop); window.removeEventListener('drop', clearDrop); };
  }, []);

  useEffect(() => { durationRef.current = libraryPreview?.duration ?? studio.duration; }, [studio.duration, libraryPreview?.duration]);
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
    next = fitEmptyTracks(next);
    setLibraryPreview(null);
    // Editing a key invalidates its generated in-betweens, keeping the simple pose timeline.
    if (next.keys !== studio.keys && next.generated === studio.generated) next = { ...next, generated: undefined, generation: next.sourceClip === null && next.generation?.source ? { ...next.generation, comparison: undefined } : undefined };
    history.current.past.push(clone({ ...studio, rigKind: asset.kind }));
    if (history.current.past.length > 60) history.current.past.shift();
    history.current.future = [];
    dirty.current = true;
    setComparisonView('after');
    setHistoryVersion(v => v + 1); setStudio(next);
    if (next.rigKind) setAsset(current => current.kind === next.rigKind ? current : { ...current, kind: next.rigKind! });
    if (studio.generated && !next.generated && studio.generation?.kind === 'inbetween') notify(`${message ? `${message} ` : ''}AI take cleared. Generate again for your current poses, or Undo to restore it.`);
    else if (message) notify(message);
  }, [studio, asset.kind, notify]);

  const commitEditingKeys = useCallback((keys: PoseKey[], message?: string, duration = studio.duration, captureChanges = false, interpolation?: InterpolationMode, captureBefore = editKeys) => {
    if (trackMuted) { notify('Unmute this track to edit it.'); return; }
    duration = trackEditDuration(studio, duration);
    if (editingTrack) {
      let next = { ...editingTrack, keys, ...(interpolation ? { interpolation } : {}) };
      if (captureChanges) for (const key of keys) {
        const original = captureBefore.find(k => k.id === key.id);
        if (original && original !== key) next = recordTrackKey(next, key, { pose: original.pose, morphs: original.morphs ?? {} }, underlyingTrackSampler(studio, editingTrack.id, asset.restPose, asset.restMorphs));
      }
      commit({ ...studio, duration, tracks: studio.tracks!.map(t => t.id === next.id ? next : t) }, message);
    } else commit({ ...studio, sourceClip: null, keys, duration, ...(interpolation ? { settings: { ...studio.settings, interpolation } } : {}) }, message);
  }, [studio, editingTrack, editKeys, trackMuted, commit, notify, asset]);
  const selectTrack = (id: string | null) => {
    if (id === (studio.activeTrackId ?? null)) return;
    cancelKeyDrag(); cancelSelection(); setPlaying(false); setSelectedIds(new Set()); setPoseReference(null);
    setStudio(current => ({ ...current, activeTrackId: id }));
  };
  const addTrack = () => {
    const track = createAnimationTrack(`Track ${(studio.tracks?.length ?? 0) + 2}`, studio, asset.restPose, asset.restMorphs);
    commit({ ...studio, tracks: [...studio.tracks ?? [], track], activeTrackId: track.id }, 'Track added. Anything you change goes here; your other motion keeps playing.');
    setPlaying(false); setPoseReference(null);
  };
  const updateTrack = (id: string | null, patch: Partial<Pick<AnimationTrack, 'name' | 'muted'>>) => {
    if (id === null) commit({ ...studio, ...(patch.name !== undefined ? { baseTrackName: patch.name } : {}), ...(patch.muted !== undefined ? { baseTrackMuted: patch.muted } : {}) });
    else commit({ ...studio, tracks: studio.tracks!.map(t => t.id === id ? { ...t, ...patch } : t) });
  };
  const copyTrack = (id: string | null) => {
    const source = studio.tracks?.find(t => t.id === id);
    const track: AnimationTrack = source ? { ...clone(source), id: uid(), name: `${source.name.slice(0, 73)} (copy)` } : {
      id: uid(), name: `${(studio.baseTrackName ?? 'Base motion').slice(0, 73)} (copy)`, muted: false,
      keys: clone(baseMotionKeys), interpolation: basePlaybackMode,
      channels: asset.bones.flatMap((_, bone) => (['position', 'quaternion', 'scale'] as const).map(property => ({ bone, property }))),
      morphs: [...new Set(baseMotionKeys.flatMap(k => Object.keys(k.morphs ?? {})))],
    };
    track.keys = track.keys.map(k => ({ ...k, id: uid() }));
    commit({ ...studio, tracks: [...studio.tracks ?? [], track], activeTrackId: track.id }, 'Track duplicated. Drag its strip to shift the timing.');
  };
  const reorderTrack = (id: string, direction: number) => {
    const tracks = [...studio.tracks ?? []], index = tracks.findIndex(t => t.id === id), next = index + direction;
    if (index < 0 || next < 0 || next >= tracks.length) return;
    [tracks[index], tracks[next]] = [tracks[next], tracks[index]];
    commit({ ...studio, tracks });
  };
  const moveTrack = (id: string, offset: number) => {
    const track = studio.tracks?.find(t => t.id === id); if (!track || track.muted || !offset) return;
    const keys = track.keys.map(k => ({ ...k, time: k.time + offset }));
    commit({ ...studio, tracks: studio.tracks!.map(t => t.id === id ? { ...t, keys } : t), duration: Math.max(studio.duration, ...keys.map(k => k.time)) });
    setPlaying(false);
  };
  const moveTrackKey = (id: string | null, keyId: string, wanted: number) => {
    const track = studio.tracks?.find(t => t.id === id);
    if (track?.muted || !track && studio.baseTrackMuted) return;
    const keys = track?.keys ?? studio.keys;
    const time = nearestFreeKeyTime(keys, keyId, wanted, studio.duration, fps);
    if (time === null) return;
    const next = keys.map(k => k.id === keyId ? { ...k, time } : k).sort((a, b) => a.time - b.time);
    commit(track ? { ...studio, activeTrackId: id, tracks: studio.tracks!.map(t => t.id === id ? { ...t, keys: next } : t) } : { ...studio, activeTrackId: null, keys: next, sourceClip: null });
    setTime(time); setPlaying(false);
  };
  const changeSettings = (patch: Partial<MotionSettings>) => {
    if (editingTrack && patch.interpolation) {
      commit({ ...studio, tracks: studio.tracks!.map(t => t.id === editingTrack.id ? { ...t, interpolation: patch.interpolation! } : t) }); return;
    }
    commit({ ...studio, ...(patch.interpolation ? { generated: undefined, generation: undefined } : {}), settings: { ...studio.settings, ...patch } });
  };
  const restoreBeforePhysics = () => {
    if (!comparison || busy) return;
    const original = comparison.before;
    const keys = studio.keys.map(key => ({ ...key, pose: samplePose(original, key.time, comparison.interpolation) }));
    commit({ ...studio, keys, generated: comparison.interpolation === 'linear' ? clone(original) : undefined, generation: undefined, sourceClip: null, settings: { ...studio.settings, interpolation: comparison.interpolation } }, 'Original motion restored. Undo brings the physics correction back.');
    setPlaying(false); setDialog(null);
  };
  const comparePhysics = (atTime?: number) => {
    if (!comparison || busy) return;
    setDialog(null); setSelectedBone(null); setComparisonView('split');
    setTime(atTime === undefined ? 0 : Math.max(0, Math.min(studio.duration, atTime)));
    setPlaying(atTime === undefined);
  };
  const simplifyMotion = () => commitEditingKeys(simplifyKeys(editKeys, 6, asset.restMorphs), 'Reduced this track to six key moments. Undo restores it.', studio.duration, false, 'smooth');
  const undo = useCallback(() => {
    setLibraryPreview(null);
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(clone({ ...studio, rigKind: asset.kind }));
    notify('Undid last change.');
    setStudio(previous); setTime(t => Math.min(t, previous.duration)); setPlaying(false); setHistoryVersion(v => v + 1); dirty.current = true;
    if (previous.rigKind) setAsset(current => current.kind === previous.rigKind ? current : { ...current, kind: previous.rigKind! });
  }, [studio, asset.kind, notify]);
  const redo = useCallback(() => {
    setLibraryPreview(null);
    const next = history.current.future.pop();
    if (!next) return;
    notify('Redid last change.');
    history.current.past.push(clone({ ...studio, rigKind: asset.kind })); setStudio(next); setTime(t => Math.min(t, next.duration)); setPlaying(false); setHistoryVersion(v => v + 1); dirty.current = true;
    if (next.rigKind) setAsset(current => current.kind === next.rigKind ? current : { ...current, kind: next.rigKind! });
  }, [studio, asset.kind, notify]);

  const documentFor = useCallback((): ProjectDocument => ({ version: 1, characterId, name: studio.title, duration: studio.duration, fps, ...trackFields(studio), keys: studio.keys, generated: studio.generated, generation: studio.generation, settings: studio.settings, sourceClip: studio.sourceClip ?? null, boneNames: asset.bones.map(b => b.name), character: embedded }), [studio, fps, asset, embedded, characterId]);
  const persistDocument = useCallback(async (document: ProjectDocument, id: string, thumbnail?: string) => {
    let token = sceneTokens.current.get(id);
    if (!token) { token = { id, revision: 0 }; sceneTokens.current.set(id, token); }
    const result = await saveLocal(document, id, thumbnail, token);
    if (activeSceneId.current === id || activeSceneId.current === result.id) setCharacterId(result.characterId);
    sceneTokens.current.set(result.id, token);
    if (result.forked && activeSceneId.current === id) {
      activeSceneId.current = result.id; setSceneId(result.id);
      notify('Another window changed this scene. Your version was saved as a separate library copy.');
    }
    return result;
  }, [notify]);
  const saveCurrentScene = useCallback(async () => {
    if (!hasActiveScene) return;
    if (!storageReady) throw new Error('Saved scenes could not be loaded. Reopen Still before replacing this scene.');
    const document = documentFor(), id = sceneId, generation = ++saveGeneration.current;
    const thumbnail = await sceneThumbnail(viewportAPI.current?.capture);
    if (generation !== saveGeneration.current) return;
    await persistDocument(document, id, thumbnail);
    setScenes(await listScenes()); setCharacters(await listCharacters());
    if (generation === saveGeneration.current) { dirty.current = false; setSaveStatus('Saved in your library'); }
  }, [documentFor, sceneId, storageReady, hasActiveScene, persistDocument]);
  const openLibrary = async (focusCharacterId?: string) => {
    if (busy || !hydrated) return;
    setBusy('Saving your scene…'); setPlaying(false);
    try { if (storageReady) await saveCurrentScene(); else setScenes(await listScenes()); setCharacters(await listCharacters()); setLibraryCharacterId(focusCharacterId); setDialog('library'); }
    catch { setError('Your scene could not be saved. Export a .still copy and free storage before switching scenes.'); }
    finally { setBusy(null); }
  };
  useEffect(() => window.stillDesktop?.updates.onOpen(() => setDialog('updates')), []);
  async function installDownloadedUpdate() {
    if (!hydrated || !storageReady || busy || engine?.busy || agentController.current || exportOperation.current || keyDrag.current || updateState?.status !== 'ready') return;
    // Lock before awaiting the save so an agent cannot mutate the snapshot.
    flushSync(() => { setBusy('Saving your scene for the update…'); setPlaying(false); });
    ++saveGeneration.current;
    try {
      if (hasActiveScene) await persistDocument(documentFor(), sceneId);
      dirty.current = false;
      setSaveStatus('Saved on this device');
      const result = await window.stillDesktop!.updates.install();
      if (result.status !== 'installing') { setBusy(null); setError(result.message); }
    } catch { setBusy(null); setError('Your scene could not be saved or the update service is unavailable. The app has stayed open.'); }
  }
  const restoreDocument = useCallback(async (input: unknown, signal?: AbortSignal, id: string = uid(), beforeApply?: () => Promise<string>) => {
    const document = validateProject(input);
    const nextAsset = document.character.type === 'demo'
      ? createDemoCharacter(document.character.kind)
      : await restoreCharacter(document.character.object, document.character.kind, document.character.name);
    if (nextAsset.bones.length !== document.boneNames.length || nextAsset.bones.some((b, i) => b.name !== document.boneNames[i])) {
      disposeCharacter(nextAsset); throw new Error('The saved skeleton does not match its pose data.');
    }
    try {
      if (beforeApply) id = await beforeApply();
      else {
        const token = { id, revision: 0 };
        const saved = await saveLocal(document, id, undefined, token);
        id = saved.id; sceneTokens.current.set(id, token);
      }
    }
    catch (error) { disposeCharacter(nextAsset); throw error; }
    if (signal?.aborted) { disposeCharacter(nextAsset); signal.throwIfAborted(); }
    const apply = () => {
      activeSceneId.current = id;
      setSceneId(id); setCharacterId(document.characterId); setHasActiveScene(true);
      setAsset(nextAsset); setStudio({ title: document.name, ...trackFields(document), keys: document.keys, generated: document.generated, generation: document.generation, duration: document.duration, settings: document.settings, sourceClip: document.sourceClip != null && document.sourceClip < nextAsset.clips.length ? document.sourceClip : null });
      setFps(document.fps); setTime(0); setSelectedBone(null); setPlaying(false);
      history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = false;
    };
    if (signal) flushSync(apply); else apply();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let libraryReady = true;
      try { await initializeCharacterLibrary(); }
      catch { libraryReady = false; }
      const [saved, library, entries, backups] = await Promise.all([loadSession(), listCharacters(), listScenes(), listArchives()]);
      if (cancelled) return;
      setCharacters(library); setScenes(entries); setArchives(backups);
      if (saved.document) {
        sceneTokens.current.set(saved.sceneId, { id: saved.sceneId, revision: saved.revision });
        await restoreDocument(saved.document, undefined, saved.sceneId, async () => saved.sceneId);
      } else if (library.length || entries.length) { setHasActiveScene(false); setDialog('library'); }
      if (!cancelled) {
        setStorageReady(libraryReady);
        if (!libraryReady) { setSaveStatus('Character library unavailable'); setError('The character library could not be updated. Your saved scenes are available for recovery in Characters. Export a .still backup and free storage before making changes.'); }
      }
    })().catch(() => { if (!cancelled) { setSaveStatus('Local recovery unavailable'); setError('Your recovery scene could not be opened. Choose a saved character and scene from Characters, or reopen Still to retry. Your saved work has not been changed.'); } }).finally(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [restoreDocument]);

  useEffect(() => {
    if (!hydrated || !storageReady || !hasActiveScene) return;
    const generation = ++saveGeneration.current;
    dirty.current = true;
    setSaveStatus('Saving…');
    const document = documentFor(), id = sceneId;
    const timer = setTimeout(() => {
      void sceneThumbnail(viewportAPI.current?.capture).then(async thumbnail => {
        if (generation !== saveGeneration.current) return;
        await persistDocument(document, id, thumbnail);
        if (generation === saveGeneration.current) { setSaveStatus('Saved in your library'); dirty.current = false; setScenes(await listScenes()); setCharacters(await listCharacters()); }
      }).catch(() => { if (generation === saveGeneration.current) setSaveStatus('Save a project file to keep changes'); });
    }, 750);
    return () => clearTimeout(timer);
  }, [documentFor, hydrated, sceneId, storageReady, hasActiveScene, persistDocument]);

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

  const writePose = useCallback((pose: Pose, message?: string) => {
    if (libraryPreview || trackMuted) return;
    setPlaying(false);
    const snapped = Math.min(studio.duration, Math.round(timeRef.current * fps) / fps);
    const existing = editKeys.find(key => Math.abs(key.time - snapped) < .5 / fps);
    const before = sampleLayers(timeRef.current);
    const nextKey: PoseKey = { id: existing?.id ?? uid(), time: existing?.time ?? snapped, pose: clone(pose), label: existing?.label ?? 'New pose', morphs: before.morphs };
    const next = putLayerKey(studio, nextKey, before, asset.restPose, asset.restMorphs);
    if (!next.generated && studio.generation?.source) next.generation = { ...studio.generation, comparison: undefined };
    const storedPose = editableKeys(next).find(k => k.id === nextKey.id)!.pose;
    setPoseReference(previous => ({ storedPose, keyId: nextKey.id, time: nextKey.time, before: previous?.keyId === nextKey.id && JSON.stringify(previous.after) === JSON.stringify(currentPose) ? previous.before : clone(currentPose), after: clone(pose), bone: selectedBone }));
    commit(next, message); setTime(nextKey.time);
  }, [studio, fps, commit, currentPose, selectedBone, editKeys, sampleLayers, libraryPreview, trackMuted, asset]);

  const applyProperty = (property: PoseProperty, axes: PropertyAxes, mode: 'offset' | 'match') => {
    if (!poseReference || busy || keyDrag.current || selectionDrag.current || !selectedIds.size) return;
    try {
      // Unowned values are placeholders. Paste against the current lower motion,
      // retaining this row's own channels and excluding higher rows.
      const sampleEditable = editingTrack ? createLayerSampler({ ...studio, tracks: studio.tracks!.slice(0, studio.tracks!.indexOf(editingTrack) + 1) }, asset.restPose, asset.restMorphs) : null;
      const before = sampleEditable ? editKeys.map(key => selectedIds.has(key.id) ? { ...key, ...sampleEditable(key.time) } : key) : editKeys;
      const keys = applyKeyframeProperty(asset, before, selectedIds, poseReference, property, axes, mode);
      if (keys === before) { notify('The selected poses already match. The source pose is kept as corrected.'); return; }
      const count = keys.filter((key, index) => key !== before[index]).length;
      commitEditingKeys(keys, `${count} poses updated on this track. One Undo restores them.`, studio.duration, true, undefined, before);
      setPlaying(false);
    } catch (error) { setError(error instanceof Error ? error.message : 'The property could not be applied.'); }
  };
  const moveAnimation = (delta: Vec3) => {
    if (busy || keyDrag.current || selectionDrag.current) return false;
    try {
      const keys = offsetKeyframes(asset, studio.keys, delta);
      if (keys === studio.keys) return false;
      const generated = studio.generated ? offsetKeyframes(asset, studio.generated, delta) : undefined;
      // A translated take keeps its motion, but floor-dependent physics measurements are stale.
      const physics = studio.generation?.kind === 'physics' ? studio.generation : undefined;
      const warning = 'Animation moved after physics. Run physics again to refresh floor and contact measurements.';
      const generation = physics ? { ...physics,
        metrics: { originalClipBackupId: studio.generation?.metrics.originalClipBackupId, quality: { requiresReview: true, reasons: [warning] } },
        warnings: [...new Set([...physics.warnings, warning])],
        comparison: physics.comparison ? { ...physics.comparison, before: offsetKeyframes(asset, physics.comparison.before, delta) } : undefined,
      } : studio.generation ? { ...studio.generation } : undefined;
      if (generation?.source) generation.source = { ...generation.source, before: offsetKeyframes(asset, generation.source.before, delta) };
      commit({ ...studio, sourceClip: null, keys, generated, generation, tracks: studio.tracks?.map(t => ({ ...t, keys: offsetKeyframes(asset, t.keys, delta) })) }, 'Entire animation moved, including generated frames. One Undo restores it.');
      setPlaying(false);
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : 'The animation could not be moved.'); return false; }
  };

  const activeMotion = (): MotionSequence => ({ keys: studio.generated ?? studio.keys, duration: studio.duration, interpolation: basePlaybackMode });
  const editClip = (edit: ClipEdit) => {
    if (busy || keyDrag.current || selectionDrag.current || !hydrated || viewingBefore) return;
    try {
      const authored = editMotion(asset, { keys: studio.keys, duration: studio.duration, interpolation: studio.settings.interpolation }, edit, fps);
      const take = studio.generated ? editMotion(asset, activeMotion(), edit, fps) : undefined;
      const warning = 'Clip edited after generation. Review contacts and rerun physics to refresh its measurements.';
      const original = studio.generation?.source;
      const editedSource = original ? editMotion(asset, { keys: original.before, duration: studio.duration, interpolation: original.interpolation }, edit, fps) : undefined;
      const generation = (take || editedSource) && studio.generation ? { ...studio.generation, source: editedSource ? { before: editedSource.keys, interpolation: editedSource.interpolation } : undefined, comparison: undefined, metrics: { originalClipBackupId: studio.generation?.metrics.originalClipBackupId, quality: { requiresReview: true, reasons: [warning] } }, warnings: [...new Set([...studio.generation.warnings, warning])] } : undefined;
      const tracks = studio.tracks?.flatMap(track => { const edited = editAnimationTrack(asset, track, studio.duration, edit, fps); return edited ? [edited] : []; });
      commit({ ...studio, tracks, activeTrackId: tracks?.some(t => t.id === studio.activeTrackId) ? studio.activeTrackId : null, keys: authored.keys, generated: take?.keys, generation, duration: authored.duration, sourceClip: null, settings: { ...studio.settings, interpolation: authored.interpolation } }, 'Clip edited. One Undo restores the entire motion. Review playback and contacts.');
      setTime(edit.kind === 'trim' ? Math.max(0, Math.min(authored.duration, time - edit.start)) : edit.kind === 'speed' ? time / edit.factor : edit.kind === 'speed-range' ? rangeSpeedTime(edit, time) : edit.kind === 'reverse' ? studio.duration - time : Math.min(time, authored.duration));
      setPlaying(false); setPoseReference(null);
    } catch (error) { setError(error instanceof Error ? error.message : 'This clip could not be edited.'); }
  };
  const appendMotion = (sequence: MotionSequence, blend: number) => {
    const combined = composeMotion(asset, activeMotion(), sequence, blend, fps);
    commit({ ...studio, baseMotionName: 'Combined motion', keys: combined.keys, generated: undefined, generation: undefined, duration: combined.duration, sourceClip: null, settings: { ...studio.settings, interpolation: combined.interpolation } }, 'Clips blended with aligned position and heading. One Undo restores your take. Review foot contacts.');
    setTime(Math.max(0, studio.duration - blend)); setPlaying(false); setPoseReference(null);
  };
  const appendClip = (index: number, blend: number) => {
    if (busy || keyDrag.current || selectionDrag.current || !hydrated || viewingBefore) return;
    try {
      const clip = asset.clips[index];
      if (!clip) throw new Error('Choose an animation from this character.');
      appendMotion({ keys: sampleClip(asset, clip), duration: clip.duration, interpolation: 'linear' }, blend);
    } catch (error) { setError(error instanceof Error ? error.message : 'The clip could not be appended.'); }
    finally { applyPose(asset, currentPose); }
  };
  const openAnimationImport = (mode: 'apply' | 'append' = 'apply') => {
    if (!asset.rigged || busy || !hydrated || keyDrag.current || selectionDrag.current) return;
    setPlaying(false); setError(null); setLibraryPreview(null); setLibraryImportFile(null); setLibraryFitError(null); setAnimationImportMode(mode); setDialog('animation');
  };
  const applyImportedAnimation = (keys: PoseKey[], duration: number, mode: 'apply' | 'append', blend: number, name: string) => {
    if (busy || !hydrated || keyDrag.current || selectionDrag.current) throw new Error('The scene is busy. Try applying the animation again.');
    setLibraryPreview(null);
    if (mode === 'append') appendMotion({ keys, duration, interpolation: 'linear' }, blend);
    else {
      commit({ ...studio, baseMotionName: name.slice(0, 200), keys, duration: trackEditDuration({ ...studio, activeTrackId: null }, duration), generated: undefined, generation: undefined, sourceClip: null, settings: { ...studio.settings, interpolation: 'linear' } }, `${name} applied to the base track.${studio.tracks?.length ? ' Other tracks keep their timing.' : ''} One Undo restores the previous motion.`);
      setTime(0); setPlaying(false); setPoseReference(null);
    }
    setDialog(null);
  };
  const appendSavedTake = async (file: File, blend: number) => {
    if (busy || keyDrag.current || selectionDrag.current || !hydrated || viewingBefore) return;
    const version = agentVersion.current;
    flushSync(() => { setBusy('Opening the saved take…'); setPlaying(false); });
    let source: CharacterAsset | undefined;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('Use a saved take smaller than 200 MB.');
      const document = validateProject(JSON.parse(await file.text()));
      source = document.character.type === 'demo' ? createDemoCharacter(document.character.kind) : await restoreCharacter(document.character.object, document.character.kind, document.character.name);
      if (version !== agentVersion.current) throw new Error('Your scene changed while opening the take. Try appending it again.');
      if (source.bones.some((bone, i) => bone.name !== document.boneNames[i]) || source.bones.length !== document.boneNames.length) throw new Error('The saved take’s pose data does not match its skeleton.');
      assertMatchingRig(asset, source);
      appendMotion({ keys: combinedKeys(document, source.restPose, source.restMorphs, fps), duration: document.duration, interpolation: combinedInterpolation(document) }, blend);
    } catch (error) { setError(error instanceof Error ? error.message : 'The saved take could not be appended.'); }
    finally { if (source) disposeCharacter(source); setBusy(null); }
  };

  const addKey = useCallback(() => { if (trackMuted) { notify('Unmute this track to edit it.'); return; } writePose(currentPose, selectedKey ? 'Pose updated. The motion follows automatically.' : 'New pose added. The motion follows automatically.'); }, [writePose, currentPose, selectedKey, notify, trackMuted]);
  const duplicateKey = useCallback(() => {
    if (!selectedKey || keyDrag.current) return;
    const duplicate = duplicateMoment(editKeys, selectedKey, studio.duration, fps);
    if (!duplicate) { notify(selectedKey.time === studio.duration && studio.duration === MAX_ANIMATION_DURATION ? 'This moment is at the 10-minute limit. Move it earlier to make room for a copy.' : 'The timeline has no empty frames. Increase its duration or remove a pose.'); return; }
    commitEditingKeys(duplicate.keys, 'Moment duplicated on this track. Drag its diamond to change the timing.', duplicate.duration);
    setPlaying(false); setTime(duplicate.key.time);
  }, [selectedKey, studio, fps, editKeys, commitEditingKeys, notify]);

  const copyKeyframes = useCallback(() => {
    if (busy || !asset.rigged || keyDrag.current) return;
    const keys = selectionMode ? editKeys.filter(key => selectedIds.has(key.id)) : selectedKey ? [selectedKey] : [];
    if (!keys.length) { notify('Click a keyframe diamond to copy it.'); return; }
    setKeyClipboard({ keys: clone(keys), channels: editingTrack ? clone(editingTrack.channels) : undefined, morphs: editingTrack ? [...editingTrack.morphs] : undefined, character: characterFingerprint(embedded, asset.bones.map(bone => bone.name)) });
    notify(`${keys.length === 1 ? 'Keyframe' : `${keys.length} keyframes`} copied. Click a time on the timeline, then Paste.`);
  }, [busy, asset, selectionMode, editKeys, selectedIds, selectedKey, embedded, notify, editingTrack]);
  const pasteKeyframes = useCallback(() => {
    if (!keyClipboard || trackMuted || busy || keyDrag.current || !asset.rigged) return;
    try {
      if (keyClipboard.character !== characterFingerprint(embedded, asset.bones.map(bone => bone.name))) throw new Error('These keyframes belong to another character. Open a scene for that character to paste them.');
      const result = pasteMoments(editKeys, keyClipboard.keys, time, studio.duration, fps);
      let next = { ...studio, duration: result.duration };
      const pastedIds = new Set(result.pasted.map(k => k.id));
      const retained = result.keys.filter(k => !pastedIds.has(k.id));
      const sample = createLayerSampler({ ...studio, tracks: editingTrack ? studio.tracks!.slice(0, studio.tracks!.indexOf(editingTrack) + 1) : [] }, asset.restPose, asset.restMorphs);
      for (const pasted of result.pasted) {
        const before = sample(pasted.time), key = clone(pasted);
        if (keyClipboard.channels) {
          key.pose = clone(before.pose); key.morphs = { ...before.morphs };
          for (const { bone, property } of keyClipboard.channels) Object.assign(key.pose[bone], { [property]: [...pasted.pose[bone][property]] });
          for (const name of keyClipboard.morphs ?? []) key.morphs[name] = pasted.morphs?.[name] ?? asset.restMorphs?.[name] ?? 0;
        }
        next = putLayerKey(next, key, before, asset.restPose, asset.restMorphs);
      }
      const keys = editableKeys(next).filter(k => pastedIds.has(k.id) || retained.some(old => old.id === k.id));
      next = editingTrack ? { ...next, tracks: next.tracks!.map(t => t.id === editingTrack.id ? { ...t, keys } : t) } : { ...next, keys, sourceClip: null };
      commit(next, `${result.pasted.length === 1 ? 'Keyframe' : `${result.pasted.length} keyframes`} pasted at ${result.pasted[0].time.toFixed(2)}s.${result.replaced ? ` Replaced ${result.replaced} existing ${result.replaced === 1 ? 'pose' : 'poses'}.` : ''} Undo restores your previous motion.`);
      setPlaying(false); setSelectionMode(false); setTime(result.pasted[0].time);
    } catch (error) { setError(error instanceof Error ? error.message : 'The keyframes could not be pasted.'); }
  }, [keyClipboard, busy, asset, embedded, studio, time, fps, commit, editKeys, editingTrack, trackMuted]);
  const moveSelectedKey = () => {
    if (!selectedKey || trackMuted || busy || !moveTime.trim()) return;
    const wanted = Number(moveTime);
    if (!Number.isFinite(wanted) || wanted < 0 || wanted > MAX_ANIMATION_DURATION) { setError('Enter a time between 0 and 600 seconds.'); return; }
    const result = moveMoment(editKeys, selectedKey.id, wanted, Math.max(studio.duration, wanted), fps);
    if (!result) { setError('Keep at least two poses. Move this keyframe to another time.'); return; }
    commitEditingKeys(result.keys, `Keyframe moved to ${result.time.toFixed(2)}s.${result.replaced ? ' Replaced the pose at that time.' : ''} Undo restores it.`, result.duration);
    setPlaying(false); setTime(result.time); setMovingKey(null);
  };
  const removeKeys = useCallback((keys: PoseKey[], message: string) => {
    if (trackMuted) return;
    if (editingTrack) { commitEditingKeys(keys, message); return; }
    // Removing an ending must not replace the retained take with newly interpolated motion.
    const end = keys.at(-1)!.time;
    const retainedIds = new Set(keys.map(key => key.id));
    const trailingOnly = studio.keys.filter(key => !retainedIds.has(key.id)).every(key => key.time > end);
    let generated: PoseKey[] | undefined;
    if (trailingOnly && end > 0 && (studio.generated || studio.settings.interpolation === 'smooth' && !studio.generation?.source)) {
      if (studio.generated) {
        generated = studio.generated.filter(key => key.time <= end);
        if (!generated.length) generated.push({ id: uid(), time: 0, pose: samplePose(studio.generated, 0, 'linear'), ...morphKeyData(studio.generated, 0, 'linear', asset.restMorphs) });
        if (!generated.some(key => Math.abs(key.time - end) < 1e-9)) generated.push({ id: uid(), time: end, pose: samplePose(studio.generated, end, 'linear'), ...morphKeyData(studio.generated, end, 'linear', asset.restMorphs) });
      } else generated = editMotion(asset, { keys: studio.keys, duration: studio.duration, interpolation: studio.settings.interpolation }, { kind: 'trim', start: 0, end }, fps).keys;
    }
    const warning = 'Ending keyframes removed. Retained playback is preserved; rerun physics to refresh measurements.';
    const generation = (generated || studio.generation?.source) && studio.generation ? { ...studio.generation, comparison: undefined, metrics: { originalClipBackupId: studio.generation?.metrics.originalClipBackupId, quality: { requiresReview: true, reasons: [warning] } }, warnings: [...new Set([...studio.generation.warnings, warning])] } : undefined;
    commit({ ...studio, keys, generated, generation, sourceClip: null }, `${message} Remaining keyframes keep their timing.${trailingOnly ? ' Use Remove empty tail to end the clip here.' : ''}`);
  }, [studio, asset, fps, commit, trackMuted, editingTrack, commitEditingKeys]);
  const deleteKey = useCallback(() => {
    if (selectionMode) {
      if (!selectedIds.size) return;
      const keys = editKeys.filter(key => !selectedIds.has(key.id));
      if (keys.length < 2) { notify('Keep at least two poses. Select a smaller range to delete.'); return; }
      removeKeys(keys, `${editKeys.length - keys.length} poses removed. Undo restores them together.`);
      setSelectedIds(new Set()); return;
    }
    if (!selectedKey || editKeys.length <= 2) return;
    removeKeys(editKeys.filter(k => k.id !== selectedKey.id), 'Pose removed. Undo is always here.');
  }, [selectedKey, editKeys, removeKeys, selectionMode, selectedIds, notify]);

  const saveProject = useCallback(() => {
    try { downloadFile(JSON.stringify(documentFor()), `${studio.title.trim() || 'Untitled'}.still`, 'application/json'); dirty.current = false; notify('Editable project saved, with your character included.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save this project.'); }
  }, [documentFor, studio.title, notify]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (selectionDrag.current) { if (event.key === 'Escape') { event.preventDefault(); cancelSelection(); setTimelineMode(false); } return; }
      if (keyDrag.current) { if (event.key === 'Escape') { event.preventDefault(); cancelKeyDrag(); setTimelineMode(false); } return; }
      if (!dialog && libraryPreview) {
        if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (event.key === 'Escape') { event.preventDefault(); setLibraryPreview(null); setPlaying(false); setTime(t => Math.min(t, studio.duration)); }
        else if (event.code === 'Space') { event.preventDefault(); setPlaying(value => !value); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); setTime(t => Math.max(0, Math.min(libraryPreview.duration, t + (event.key === 'ArrowLeft' ? -1 : 1) / fps))); }
        else if (event.ctrlKey || event.metaKey || event.key.toLowerCase() === 'k' || event.key === 'Delete' || event.key === 'Backspace') event.preventDefault();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]') || dialog || busy || !hydrated || !hasActiveScene) return;
      if (target?.matches('input[type="range"]') && !mod && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      if (!mod && !event.altKey && event.repeat && ['s', 'v', 'r', 'm', 'w', 'e', 'f', 'g', ' '].includes(key)) { event.preventDefault(); return; }
      if (mod && key === 'a') { event.preventDefault(); setTimelineMode(true); setSelectedIds(new Set(editKeys.map(key => key.id))); }
      else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (mod && key === 'y') { event.preventDefault(); redo(); }
      else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (event.shiftKey) saveProject(); else void saveCurrentScene().catch(() => setError('Could not save this scene. Export a .still copy to keep your work.')); }
      else if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); if (!selectionMode) duplicateKey(); }
      else if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); copyKeyframes(); }
      else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteKeyframes(); }
      else if (mod || event.altKey) return;
      else if (key === 's') { event.preventDefault(); setTimelineMode(!selectionMode); }
      else if (key === 'v') { event.preventDefault(); setTimelineMode(false); }
      else if (key === 'g') { event.preventDefault(); toggleModelMove(); }
      else if (key === 'f') { event.preventDefault(); setTimelineMode(false); setMoveModel(false); setTool('move'); setFollow(value => !value); }
      else if (key === 'r') { event.preventDefault(); setSelectionMode(false); setSelectedIds(new Set()); setRipple(value => !value); setPlaying(false); }
      else if (key === 'm' && selectedKey && !selectionMode) { event.preventDefault(); setMovingKey(selectedKey.id); setMoveTime(String(selectedKey.time)); setPlaying(false); }
      else if (key === '?' || event.key === 'F1') { event.preventDefault(); setDialog('shortcuts'); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setPlaying(false); setTime(event.key === 'Home' ? 0 : studio.duration); }
      else if (event.code === 'Space') { event.preventDefault(); setPlaying(v => !v); }
      else if (event.key.toLowerCase() === 'k') { event.preventDefault(); addKey(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteKey(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); setTime(t => Math.max(0, Math.min(studio.duration, t + (event.key === 'ArrowLeft' ? -1 : 1) / fps))); }
      else if (event.key.toLowerCase() === 'w') { setTimelineMode(false); setTool('move'); }
      else if (event.key.toLowerCase() === 'e') { setTimelineMode(false); setTool('rotate'); }
      else if (event.key === 'Escape') { event.preventDefault(); setSelectedBone(null); setTimelineMode(false); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, busy, hydrated, hasActiveScene, redo, undo, saveProject, saveCurrentScene, addKey, duplicateKey, copyKeyframes, pasteKeyframes, deleteKey, editKeys, studio.duration, fps, selectionMode, selectedKey, setTimelineMode, toggleModelMove]);

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
      setSceneId(uid()); setCharacterId(undefined); setHasActiveScene(true); setAsset(nextAsset); setStudio({ title: file.name.replace(/\.[^.]+$/, ''), keys, duration, settings: { ...DEFAULT_SETTINGS, interpolation: importedAnimation ? 'linear' : 'smooth' }, sourceClip: importedAnimation ? 0 : null });
      setTime(0); setSelectedBone(null); history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1);
      dirty.current = true;
      if (!nextAsset.rigged) { setRigKind(nextAsset.kind); setDialog('rig'); }
      else { setDialog(null); if (animationError) setError(animationError); else notify(importedAnimation ? `${keys.length} frames preserved. Simplify to six poses to edit the key moments.` : 'Character ready. Its original rig and skin weights are preserved.'); }
    } catch (e) { if (nextAsset && nextAsset !== assetRef.current) disposeCharacter(nextAsset); setError(e instanceof Error ? e.message : 'That file could not be opened. Try an FBX or GLB.'); }
    finally { setBusy(null); if (importInput.current) importInput.current.value = ''; }
  };

  const swapLook = async (file: File) => {
    if (busy || !hydrated || keyDrag.current || selectionDrag.current) return;
    setBusy(`Dressing the rig in ${file.name}…`); setError(null); setPlaying(false);
    let source: CharacterAsset | undefined;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('Use a file smaller than 200 MB for a responsive editing session.');
      source = await importCharacter(file);
      await preserveScene();
      const next = swapCharacterLook(asset, source);
      setSceneId(uid()); setCharacterId(undefined); setHasActiveScene(true); setAsset(next); dirty.current = true;
      notify(`${file.name.replace(/\.[^.]+$/, '')} saved as a new character with this motion. Your original character and scenes stay saved.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'That look could not be fitted to this skeleton.'); }
    finally { if (source) disposeCharacter(source); setBusy(null); if (lookInput.current) lookInput.current.value = ''; }
  };

  const switchClip = (index: number) => {
    try {
      const clip = asset.clips[index]; const keys = sampleClip(asset, clip);
      commit({ ...studio, baseMotionName: (clip.name || 'Imported animation').slice(0, 200), keys, duration: trackEditDuration({ ...studio, activeTrackId: null }, Math.max(clip.duration, 1 / fps)), settings: { ...studio.settings, interpolation: 'linear' }, sourceClip: index }, `Loaded ${clip.name || `animation ${index + 1}`} on the base track.${studio.tracks?.length ? ' Other tracks keep their timing.' : ''} Undo restores your previous motion.`);
      setTime(0); setPlaying(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not open this animation.'); }
  };

  const preserveScene = async () => {
    if (!hasActiveScene) return;
    try { await saveCurrentScene(); await archiveLocal(documentFor()); setArchives(await listArchives()); }
    catch { throw new Error('Your current scene could not be backed up. Save a .still file and free browser storage before replacing it.'); }
  };

  const openSavedScene = async (id: string) => {
    if (busy || hasActiveScene && id === sceneId) { if (!busy) setDialog(null); return; }
    setBusy('Opening your scene…'); setPlaying(false);
    try {
      const { document: saved, revision } = await readScene(id);
      if (storageReady) await saveCurrentScene();
      const token = { id, revision }; sceneTokens.current.set(id, token);
      await restoreDocument(saved, undefined, id, async () => {
        const result = await saveLocal(saved, id, undefined, token);
        sceneTokens.current.set(result.id, token);
        if (result.forked) notify('Another window changed that scene. Your opened version is saved as a separate library copy.');
        return result.id;
      });
      setStorageReady(true); setError(null); setScenes(await listScenes()); setDialog(null); notify('Scene opened. Your other work is safe in the library.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not open this scene.'); }
    finally { setBusy(null); }
  };

  const changeSavedScene = async (id: string, change: 'rename' | 'duplicate' | 'delete', name?: string): Promise<boolean> => {
    if (busy) return false;
    setBusy('Updating your library…');
    try {
      await saveCurrentScene();
      const targetId = id === sceneId ? activeSceneId.current : id;
      if (targetId === activeSceneId.current && change === 'rename') {
        const title = name?.trim();
        if (!title || title.length > 200) throw new Error('Give this scene a name of 1–200 characters.');
        await persistDocument({ ...documentFor(), name: title }, targetId);
        setStudio(current => ({ ...current, title }));
      } else {
        if (change === 'delete' && targetId === activeSceneId.current) ++saveGeneration.current;
        await editScene(targetId, change, name);
        if (change === 'delete' && targetId === activeSceneId.current) {
          setHasActiveScene(false); dirty.current = false; setPlaying(false);
          setSaveStatus('Choose a scene'); setDialog('library');
        }
      }
      setScenes(await listScenes()); notify(change === 'duplicate' ? 'Scene duplicated. Open the copy to try another direction.' : change === 'delete' ? 'Scene deleted from the library.' : 'Scene renamed.');
      return true;
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update this scene.'); return false; }
    finally { setBusy(null); }
  };

  const openArchive = async (id: string) => {
    if (busy) return;
    setBusy('Restoring your scene…');
    try {
      const saved = await readArchive(id);
      if (storageReady) await preserveScene();
      const restoredId = uid(), token = { id: restoredId, revision: 0 };
      await restoreDocument(saved, undefined, restoredId, async () => {
        const result = await saveLocal(saved, restoredId, undefined, token);
        sceneTokens.current.set(result.id, token); return result.id;
      });
      setStorageReady(true); setError(null); setScenes(await listScenes()); setDialog(null); notify('Previous scene restored and saved in your library.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restore that scene.'); }
    finally { setBusy(null); }
  };

  const changeCharacterName = async (id: string, name: string): Promise<boolean> => {
    if (busy || !storageReady) return false;
    setBusy('Renaming your character…');
    try { await renameCharacter(id, name); setCharacters(await listCharacters()); notify('Character renamed. Its model, rig and scenes are preserved.'); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not rename this character.'); return false; }
    finally { setBusy(null); }
  };

  const createCharacterScene = async (id: string) => {
    if (busy || !storageReady || !hydrated) return;
    flushSync(() => { setBusy('Starting a scene with your saved character…'); setPlaying(false); });
    let next: CharacterAsset | undefined;
    let applied = false;
    try {
      await preserveScene();
      const saved = await readCharacter(id);
      next = saved.model.type === 'demo' ? createDemoCharacter(saved.kind) : await restoreCharacter(saved.model.object, saved.kind, saved.model.name);
      if (!next.rigged || next.bones.length !== saved.boneNames.length || next.bones.some((bone, index) => bone.name !== saved.boneNames[index])) throw new Error('This saved character’s rig could not be restored.');
      const existing = (await listScenes()).filter(scene => scene.characterId === id);
      let number = 1;
      while (existing.some(scene => scene.name === `Scene ${number}`)) number++;
      const keys = [0, 4].map(time => ({ id: uid(), time, pose: clone(next!.restPose), ...(next!.restMorphs ? { morphs: clone(next!.restMorphs) } : {}) }));
      const document: ProjectDocument = { version: 1, characterId: id, name: `Scene ${number}`, duration: 4, fps: 30, keys, settings: { ...DEFAULT_SETTINGS }, sourceClip: null, boneNames: saved.boneNames, character: saved.model };
      const newId = uid(), token = { id: newId, revision: 0 };
      const result = await saveLocal(document, newId, saved.thumbnail, token);
      sceneTokens.current.set(result.id, { id: result.id, revision: result.revision }); activeSceneId.current = result.id;
      ++saveGeneration.current;
      setSceneId(result.id); setCharacterId(result.characterId); setHasActiveScene(true);
      setAsset(next); setStudio({ title: document.name, duration: 4, keys, settings: document.settings, sourceClip: null });
      applied = true;
      setFps(30); setTime(0); setSelectedBone(null); setDialog(null); setError(null);
      history.current = { past: [], future: [] }; setHistoryVersion(value => value + 1); dirty.current = false;
      setScenes(await listScenes()); setCharacters(await listCharacters());
      notify(`New scene for ${saved.name}. Your saved rig is ready.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not create a scene for this character.'); }
    finally { if (next && !applied) disposeCharacter(next); setBusy(null); }
  };

  const createNew = async (kind: RigKind, blank = false) => {
    if (busy) return;
    setBusy('Making room for your next move…');
    try {
    await preserveScene();
    const next = createDemoCharacter(kind); const keys = blank ? [{ id: uid(), time: 0, pose: clone(next.restPose) }, { id: uid(), time: 4, pose: clone(next.restPose) }] : createDemoKeys(next);
    setSceneId(uid()); setCharacterId(undefined); setHasActiveScene(true); setAsset(next); setStudio({ title: blank ? 'My next move' : kind === 'humanoid' ? 'A little hello' : 'Four little steps', keys, duration: 4, settings: { ...DEFAULT_SETTINGS } });
    setTime(blank ? 0 : .8); setSelectedBone(null); setPlaying(false); setDialog(null);
    history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = true; notify('Fresh canvas. Make it move.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start a new scene.'); }
    finally { setBusy(null); }
  };

  const prepareRig = async () => {
    if (busy || asset.rigged || !hydrated) return;
    if (rigKind !== 'creature' && (rigKind !== 'humanoid' || !rigFingers)) { void makeRig(); return; }
    flushSync(() => { setBusy(rigKind === 'creature' ? 'Preparing creature chains…' : 'Finding the hands and finger joints…'); setPlaying(false); setError(null); });
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      const fit = estimateAutoRig(asset, rigKind, true, creatureRig), preview = createRigPreview(asset, fit);
      setRigDraft({ fit, initial: clone(fit), preview, source: asset });
    } catch (error) { setError(error instanceof Error ? error.message : 'The hand joints could not be detected.'); }
    finally { setBusy(null); }
  };
  const makeRig = async (fit?: AnatomicalFit) => {
    if (busy || asset.rigged || !hydrated || fit && rigDraft?.source !== asset) return;
    setBusy('Fitting the skeleton and skin weights…'); setError(null);
    await new Promise(resolve => setTimeout(resolve, 50));
    try {
      await saveCurrentScene();
      const next = autoRigCharacter(asset, rigKind, { fingers: rigFingers, fit, creature: creatureRig }); setAsset({ ...next });
      const keys = [{ id: uid(), time: 0, pose: clone(next.restPose) }, { id: uid(), time: studio.duration, pose: clone(next.restPose) }];
      setStudio({ ...studio, tracks: undefined, activeTrackId: null, baseTrackMuted: false, keys, generated: undefined, generation: undefined, sourceClip: null }); setSelectedBone(null); setTime(0); setDialog(null); setShowFingerJoints(!!next.bones.find(b => isFingerBone(b.name)));
      history.current = { past: [], future: [] }; setHistoryVersion(v => v + 1); dirty.current = true; notify(rigKind === 'creature' ? 'Creature bound. Use Rotate to test each chain and jaw separately.' : fit?.diagnostics.hands ? 'Hands and body bound. Select a finger and use Rotate to check a small bend.' : 'Rig fitted to your geometry. Try a small bend at the shoulders, elbows and knees.');
    } catch (e) { setError(e instanceof Error ? e.message : 'The rig could not be fitted.'); }
    finally { setBusy(null); }
  };

  const exportSavedScene = async (id: string, format: 'glb' | 'unreal' | 'still') => {
    if (busy) return;
    if (id === sceneId) {
      if (format === 'still') { saveProject(); return; }
      if (format === 'glb') { await exportGLB(); return; }
      if (!asset.rigged) { setError('Fit a rig before Unreal export. Open the scene and choose Add a rig.'); return; }
      const capability = await getUnrealExportCapability();
      if (!capability.available) { setError(capability.reason || 'Start Still with its launcher to enable Unreal export.'); return; }
      setRootMotion(readExportPreference('root-motion') === 'preserve' || readExportPreference('root-motion') === 'in-place' ? readExportPreference('root-motion') as typeof rootMotion : 'extract');
      setDialog('export');
      return;
    }
    setBusy(format === 'still' ? 'Preparing your scene file…' : 'Packing your character and motion…'); setPlaying(false);
    let source: CharacterAsset | undefined;
    try {
      const { document } = await readScene(id);
      if (format === 'still') {
        downloadFile(JSON.stringify(document), `${document.name.trim() || 'Untitled'}.still`, 'application/json');
        notify('Editable scene saved with its character included.');
        return;
      }
      source = document.character.type === 'demo' ? createDemoCharacter(document.character.kind) : await restoreCharacter(document.character.object, document.character.kind, document.character.name);
      if (!source.rigged) throw new Error('This saved scene has no rig yet. Open it and choose Add a rig before exporting.');
      if (source.bones.length !== document.boneNames.length || source.bones.some((bone, i) => bone.name !== document.boneNames[i])) throw new Error('The saved skeleton does not match its pose data. Open the scene to check it before exporting.');
      const sceneStudio: Studio = { title: document.name, keys: document.keys, generated: document.generated, generation: document.generation, duration: document.duration, settings: document.settings, sourceClip: document.sourceClip ?? null, tracks: document.tracks, baseTrackName: document.baseTrackName, baseTrackMuted: document.baseTrackMuted, activeTrackId: document.activeTrackId, baseMotionName: document.baseMotionName };
      const keys = combinedKeys(sceneStudio, source.restPose, source.restMorphs, document.fps);
      const mode = combinedInterpolation(sceneStudio);
      const clip = buildAnimationClip(source, keys, document.duration, { ...document.settings, interpolation: mode });
      const binary = await exportCharacterGLB(source, clip);
      const name = document.name.trim() || 'Animation';
      if (format === 'glb') {
        downloadFile(binary, `${name}.glb`, 'model/gltf-binary');
        notify('Animated GLB exported. Ready for Blender, game engines, and the web.');
        return;
      }
      const capability = await getUnrealExportCapability();
      if (!capability.available) throw new Error(capability.reason || 'Start Still with its launcher to enable Unreal export.');
      const result = await exportUnrealPackage(binary, { name, fps: document.fps, rootMotion: 'extract', retarget: 'none' }, message => setBusy(message), new AbortController().signal);
      if (result.package) downloadFile(result.package, `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-Unreal.zip`, 'application/zip');
      const notes = [result.savedTo ? `Saved to ${result.savedTo}` : result.saveError || 'Unreal package downloaded. Unzip it and follow the included import guide.', ...result.warnings.map(warning => `Note: ${warning}`)];
      notify(notes.join(' '));
    } catch (e) { setError(e instanceof Error ? e.message : 'That saved scene could not be exported.'); }
    finally { if (source && source !== asset) disposeCharacter(source); setBusy(null); }
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

  useEffect(() => { setReferenceOverride(null); setExportOptionError(null); }, [sceneId, asset.root.uuid]);
  const useReferenceOverride = referenceOverride?.sceneId === sceneId && referenceOverride.assetId === asset.root.uuid;
  const referenceFbx = useReferenceOverride ? referenceOverride.bytes : asset.referenceFbx;
  const referenceFbxName = useReferenceOverride ? referenceOverride.name : asset.referenceFbxName;
  const exportBlocked = retarget === 'skeleton' && referenceLoading ? 'Reading the character FBX.' : retarget === 'skeleton' && !targetSkeleton.trim() ? 'Enter the Skeleton asset path to export animation onto your Unreal character.' : retarget === 'skeleton' && !isUnrealAssetPath(targetSkeleton.trim()) ? 'Enter a valid Unreal Skeleton asset path, such as /Game/KarateBear/SKEL_KarateBear.SKEL_KarateBear.' : retarget === 'skeleton' && !referenceFbx?.byteLength ? 'Choose the character FBX you imported into Unreal.' : saveIntoFolder && !exportFolder.trim() ? 'Enter an existing folder path.' : '';
  const chooseReferenceFbx = async (file?: File) => {
    if (!file) return;
    setReferenceLoading(true); setExportOptionError(null);
    try {
      if (!/\.fbx$/i.test(file.name) || file.size > 150 * 1024 * 1024) throw new Error('Choose a character FBX of at most 150 MB.');
      const bytes = await file.arrayBuffer();
      const magic = 'Kaydara FBX Binary  \0';
      if (new TextDecoder().decode(bytes.slice(0, magic.length)) !== magic) throw new Error('Choose a binary FBX. ASCII FBX is not supported for this export.');
      setReferenceOverride({ sceneId, assetId: asset.root.uuid, bytes, name: file.name });
    } catch (e) { setExportOptionError(e instanceof Error ? e.message : 'The character FBX could not be read.'); }
    finally { setReferenceLoading(false); }
  };
  const browseExportFolder = async () => {
    setExportOptionError(null);
    try { const folder = await window.stillDesktop?.pickFolder(); if (folder) { setExportFolder(folder); rememberExportPreference('folder', folder); } }
    catch (e) { setExportOptionError(e instanceof Error ? e.message : 'The folder picker could not open.'); }
  };

  const exportUnreal = async () => {
    if (busy || exportBlocked || !asset.rigged || !unrealCapability?.available || exportOperation.current) return;
    const controller = new AbortController(); exportOperation.current = controller;
    setExportRunning(true); setExportCancelling(false); setExportSummary(null); setExportOptionError(null); setError(null); setPlaying(false);
    setBusy('Packing your character and motion…'); setProgress(0);
    try {
      // Match the preview, including generated/physics frames and their interpolation.
      const clip = buildAnimationClip(asset, motionKeys, studio.duration, { ...studio.settings, interpolation: playbackMode });
      const binary = await exportCharacterGLB(asset, clip);
      controller.signal.throwIfAborted();
      const name = studio.title.trim() || 'Animation';
      const result = await exportUnrealPackage(binary, { name, fps, rootMotion, retarget, ...(retarget === 'skeleton' ? { targetSkeleton: targetSkeleton.trim(), referenceFbx } : targetMesh.trim() ? { targetMesh: targetMesh.trim() } : {}), ...(saveIntoFolder ? { saveFolder: exportFolder.trim() } : {}) }, (message, fraction) => {
        if (!controller.signal.aborted) { setBusy(message); setProgress(fraction); }
      }, controller.signal);
      controller.signal.throwIfAborted();
      if (result.package) downloadFile(result.package, `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-Unreal.zip`, 'application/zip');
      setExportSummary({ warnings: result.warnings, existingSkeleton: retarget === 'skeleton' || (retarget === 'none' && !!targetMesh.trim()), savedTo: result.savedTo, saveError: result.saveError });
      notify(result.savedTo ? `Saved to ${result.savedTo}` : result.saveError || 'Unreal package downloaded. Unzip it and follow the included import guide.');
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
    if (busy || !asset.rigged || keyDrag.current) return;
    setError(null); setPlaying(false);
    if (provider.limits?.humanoidOnly && asset.kind !== 'humanoid') { setError(`${provider.name} currently supports human characters. Use pose interpolation for other anatomy.`); return; }
    if (provider.limits?.quadrupedOnly && asset.kind !== 'quadruped') { setError(`${provider.name} needs a four-legged rig.`); return; }
    if (provider.limits?.maxDuration && studio.duration > provider.limits.maxDuration) { setError(`${provider.name} supports clips up to ${provider.limits.maxDuration} seconds. Shorten this clip before generating.`); return; }
    const controller = new AbortController(); engineOperation.current = controller;
    setBusy(provider.learned ? 'Preparing your key moments…' : 'Preparing the physical character…'); setProgress(0);
    await new Promise(resolve => setTimeout(resolve, 40));
    let createdBackupId: string | undefined;
    try {
      controller.signal.throwIfAborted();
      const anchors = studio.keys.length > 24 ? simplifyKeys(studio.keys, 6) : studio.keys;
      if (provider.id === 'motionbricks') {
        if (anchors.length < 2 || Math.abs(anchors[0].time) > 1e-6 || Math.abs(anchors[anchors.length - 1].time - studio.duration) > 1e-5) throw new Error('Add a pose at the beginning and at the clip end before generating with MotionBricks.');
        if (anchors.some((key, i) => i > 0 && key.time - anchors[i - 1].time < 1 / 30 - 1e-6)) throw new Error('Space your key poses at least one frame apart (1/30 second) before generating.');
      }
      let originalClipBackupId = (provider.id === 'motionbricks' || !provider.learned) && studio.generation?.source && typeof studio.generation.metrics.originalClipBackupId === 'string' ? studio.generation.metrics.originalClipBackupId : undefined;
      if (originalClipBackupId && !(await listScenes()).some(scene => scene.id === originalClipBackupId)) originalClipBackupId = undefined;
      let source = baseMotionKeys, sourceMode = basePlaybackMode;
      let sourceWarning: string | undefined;
      if (provider.id === 'motionbricks' && (studio.generated || studio.generation?.source)) {
        if (studio.generation?.source) { source = studio.generation.source.before; sourceMode = studio.generation.source.interpolation; }
        else if (studio.generation?.name === 'MotionBricks') {
          source = studio.keys; sourceMode = studio.settings.interpolation;
          sourceWarning = 'This older take has no original motion guide. Your authored poses guide this new take.';
        }
      }
      const settings = { ...studio.settings, interpolation: sourceMode, ...(provider.limits?.earthGravityOnly ? { gravity: 9.81 } : {}), ...(provider.limits?.requiresFloorContact ? { floorContact: true } : {}) };
      const request = makeMotionRequest(asset, source, anchors, studio.duration, { ...settings, interpolation: sourceMode }, provider.id, seed.current++);
      const result = await generateMotion(request, (message, fraction) => { setBusy(message); setProgress(fraction); }, controller.signal);
      controller.signal.throwIfAborted();
      const generated = restoreEngineFrames(asset, source, anchors, result, sourceMode, studio.duration, provider.learned);
      if (provider.id === 'motionbricks' && anchors.length < studio.keys.length) {
        setBusy('Keeping your original clip safe in Scenes…');
        try {
          originalClipBackupId = await saveSceneCopy(documentFor(), `${studio.title.slice(0, 180)} · original clip`, await sceneThumbnail(viewportAPI.current?.capture));
          createdBackupId = originalClipBackupId;
        } catch (error) { throw new Error(error instanceof Error && error.name === 'QuotaExceededError' ? 'There isn’t enough storage to keep your original clip safe. Export a .still copy and free some space, then generate again. Your animation is unchanged.' : 'Your original clip could not be saved. Export a .still copy before trying again. Your animation is unchanged.'); }
        controller.signal.throwIfAborted();
        setScenes(await listScenes());
      }
      controller.signal.throwIfAborted();
      // Physics adjusts poses without discarding authored key identities or timing.
      const keys = provider.learned ? anchors : studio.keys.map(key => ({ ...key, pose: samplePose(generated, key.time, 'linear') }));
      const review = (result.metrics?.quality as { requiresReview?: boolean } | undefined)?.requiresReview === true;
      commit({ ...studio, keys, generated, generation: { name: result.provider?.name ?? provider.name, kind: request.kind, metrics: { ...result.metrics, requestedSettings: settings, ...(originalClipBackupId ? { originalClipBackupId } : {}) }, ...(provider.id === 'motionbricks' ? { source: { before: clone(source), interpolation: sourceMode } } : !provider.learned && studio.generation?.source ? { source: clone(studio.generation.source) } : {}), warnings: [...result.warnings ?? [], ...(sourceWarning ? [sourceWarning] : []), ...(originalClipBackupId ? ['Your full original clip is saved as a separate scene in Scenes.'] : [])], ...(!provider.learned ? { comparison: { before: clone(baseMotionKeys), interpolation: basePlaybackMode } } : {}) }, sourceClip: null }, provider.learned ? 'AI motion is ready. Your key poses are preserved. Play it, or Undo to compare.' : review ? 'Physics applied, but needs review. Open the pass details before exporting.' : 'Dynamics correction is ready. Play it, or Undo to compare.');
    } catch (e) {
      let cleanupFailed = false;
      if (createdBackupId) {
        try { await editScene(createdBackupId, 'delete'); setScenes(await listScenes()); }
        catch { cleanupFailed = true; }
      }
      if (controller.signal.aborted) {
        notify('Cancelled. Your animation is unchanged.');
        if (cleanupFailed) setError('The safety copy could not be removed. Your original clip is still in Scenes; your animation is unchanged.');
      }
      else setError(e instanceof Error ? e.message : 'The motion engine could not finish. Your animation is unchanged.');
    } finally { applyPose(asset, currentPose); engineOperation.current = null; setProgress(null); setBusy(null); void getEngineStatus().then(setEngine); }
  };

  const scrub = (clientX: number) => {
    const rect = timeline.current?.getBoundingClientRect(); if (!rect) return;
    setPlaying(false); setTime(Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * studio.duration * fps) / fps);
  };
  const selectionTime = (clientX: number) => {
    const rect = timeline.current!.getBoundingClientRect();
    return Math.max(0, Math.min(studio.duration, (clientX - rect.left) / Math.max(1, rect.width) * studio.duration));
  };
  const extendSelection = (clientX: number) => {
    const drag = selectionDrag.current;
    if (!drag) return;
    const end = selectionTime(clientX), low = Math.min(drag.start, end), high = Math.max(drag.start, end);
    setSelectionRange({ start: low, end: high });
    setSelectedIds(new Set([...drag.base, ...editKeys.filter(key => key.time >= low - 1e-6 && key.time <= high + 1e-6).map(key => key.id)]));
  };
  const startSelection = (clientX: number, pointerId: number, additive: boolean, key?: PoseKey) => {
    setPlaying(false);
    if (key && additive) { setSelectedIds(previous => { const next = new Set(previous); if (next.has(key.id)) next.delete(key.id); else next.add(key.id); return next; }); return; }
    selectionDrag.current = { pointerId, start: key?.time ?? selectionTime(clientX), previous: selectedIds, base: additive ? selectedIds : new Set() };
    timeline.current!.setPointerCapture(pointerId); extendSelection(clientX);
    if (key) setSelectedIds(new Set([key.id]));
  };
  const previewKeyDrag = (clientX: number, pointerId: number) => {
    const drag = keyDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const current = agentVersion.current;
    if (drag.studio !== current.studio || drag.asset !== current.asset || drag.fps !== current.fps) { cancelKeyDrag(pointerId); return; }
    if (!drag.moved && Math.abs(clientX - drag.startX) <= 4) return;
    const rect = timeline.current?.getBoundingClientRect(); if (!rect) return;
    if (rect.width <= 0) return;
    const wanted = drag.startTime + (clientX - drag.startX) / rect.width * drag.studio.duration;
    const result = drag.ripple ? rippleMoment(editableKeys(drag.studio), drag.id, wanted, drag.studio.duration, drag.fps) : moveMoment(editableKeys(drag.studio), drag.id, wanted, drag.studio.duration, drag.fps);
    if (!result) return;
    result.duration = trackEditDuration(drag.studio, result.duration);
    drag.moved = true; drag.time = result.time; drag.result = result;
    setDragPreview(current => current?.id === drag.id && current.time === result.time ? current : { id: drag.id, ...result, ripple: drag.ripple });
    setTime(result.time);
  };
  const finishKeyDrag = (clientX: number, pointerId: number) => {
    const drag = keyDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const current = agentVersion.current;
    if (drag.studio !== current.studio || drag.asset !== current.asset || drag.fps !== current.fps) { cancelKeyDrag(pointerId); return; }
    previewKeyDrag(clientX, pointerId);
    keyDrag.current = null; setDragPreview(null);
    if (drag.moved && drag.result && drag.time !== drag.startTime) {
      const replaced = editKeys.length - drag.result.keys.length;
      commitEditingKeys(drag.result.keys, `Keyframe moved to ${drag.time.toFixed(2)}s.${replaced ? ' Replaced the pose at that time. Undo restores it.' : ''}`, drag.result.duration);
      setTime(drag.time);
    }
  };
  const nudgeKey = (key: PoseKey, direction: number, rippleEdit: boolean) => {
    if (busy || keyDrag.current) return;
    if (rippleEdit) {
      const result = rippleMoment(editKeys, key.id, key.time + direction / fps, studio.duration, fps);
      if (!result || result.time === key.time) return;
      commitEditingKeys(result.keys, undefined, result.duration);
      setPlaying(false); setTime(result.time);
      return;
    }
    const nextTime = nearestFreeKeyTime(editKeys, key.id, key.time + direction / fps, studio.duration, fps, direction);
    if (nextTime === null || direction * (nextTime - key.time) <= 0) return;
    commitEditingKeys(editKeys.map(item => item.id === key.id ? { ...item, time: nextTime } : item).sort((a, b) => a.time - b.time));
    setPlaying(false); setTime(nextTime);
  };
  const changeDuration = (value: number) => {
    if (busy || keyDrag.current || selectionDrag.current) return;
    if (!Number.isFinite(value) || value < .1 || value > MAX_ANIMATION_DURATION) { setDurationInput(String(studio.duration)); setError('Set the clip end between 0.1 and 600 seconds.'); return; }
    if (value === studio.duration || value === Number(studio.duration.toFixed(3))) return;
    const shortened = value < studio.duration;
    const trim = (keys: PoseKey[], interpolation: InterpolationMode) => {
      const retained = keys.filter(key => key.time <= value);
      if (!retained.length || retained[0].time > 0) retained.unshift({ id: uid(), time: 0, pose: samplePose(keys, 0, interpolation), ...morphKeyData(keys, 0, interpolation, asset.restMorphs) });
      if (retained.some(key => Math.abs(key.time - value) < 1e-9)) return retained;
      return [...retained, { id: uid(), time: value, pose: samplePose(keys, value, interpolation), ...morphKeyData(keys, value, interpolation, asset.restMorphs) }];
    };
    const keys = shortened ? trim(studio.keys, studio.settings.interpolation) : studio.keys;
    const generated = shortened && studio.generated ? trim(studio.generated, 'linear') : studio.generated;
    const warning = 'Clip end changed after generation. Review playback and rerun physics to refresh its measurements.';
    const generation = studio.generation ? { ...studio.generation, source: studio.generation.source ? { ...studio.generation.source, before: shortened ? trim(studio.generation.source.before, studio.generation.source.interpolation) : studio.generation.source.before } : undefined, comparison: undefined, metrics: { originalClipBackupId: studio.generation?.metrics.originalClipBackupId, quality: { requiresReview: true, reasons: [warning] } }, warnings: [...new Set([...studio.generation.warnings, warning])] } : undefined;
    const tracks = shortened ? studio.tracks?.flatMap(track => { const edited = editAnimationTrack(asset, track, studio.duration, { kind: 'trim', start: 0, end: value }, fps); return edited ? [edited] : []; }) : studio.tracks;
    commit({ ...studio, tracks, activeTrackId: tracks?.some(t => t.id === studio.activeTrackId) ? studio.activeTrackId : null, sourceClip: null, duration: value, keys, generated, generation }, shortened ? `Clip ends at ${value.toFixed(2)}s. Earlier keyframes keep their timing. Undo restores the trimmed end.` : `Clip extended to ${value.toFixed(2)}s. Your keyframe timing is unchanged.`);
    setPlaying(false); setTime(t => Math.min(value, t));
  };

  agentSnapshot.current = () => ({
    revision: agentVersion.current.revision,
    project: { name: studio.title, duration: studio.duration, fps },
    character: { name: asset.name, kind: asset.kind, rigged: asset.rigged, boneCount: asset.bones.length },
    timeline: { time, playing, activeTrackId: editingTrack?.id ?? null, tracks: [{ id: null, name: studio.baseTrackName ?? 'Base motion', muted: !!studio.baseTrackMuted, keyCount: studio.keys.length }, ...(studio.tracks ?? []).map(t => ({ id: t.id, name: t.name, muted: t.muted, keyCount: t.keys.length }))], keyCount: editKeys.length, generatedFrames: studio.generated?.length ?? 0 },
    view: { cameraView, showRig, showGhosts, tool, selectedBone },
    camera: viewportAPI.current?.getCamera() ?? null,
    history: { canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 },
    providers: engine?.providers ?? [], busy: busy ?? (!hasActiveScene ? 'Choose a saved scene or create a new scene.' : null), progress,
  });
  agentEditor.current = {
    asset, studio, time, fps, pose: currentPose, snapshot: () => agentSnapshot.current(), document: documentFor,
    archive: preserveScene, save: saveCurrentScene,
    restore: async (document, signal) => { await restoreDocument(document, signal); },
    replace: (next, nextStudio, nextTime = 0) => flushSync(() => {
      setSceneId(uid()); setCharacterId(undefined); setHasActiveScene(true); setAsset(next); setStudio(nextStudio); setTime(nextTime); setSelectedBone(null); setPlaying(false); setDialog(null);
      history.current = { past: [], future: [] }; setHistoryVersion(value => value + 1); dirty.current = true;
    }),
    commit: next => flushSync(() => commit(next)),
    timeline: (nextTime, nextFps) => flushSync(() => { setTime(nextTime); setPlaying(false); if (nextFps !== undefined) setFps(nextFps); }),
    play: next => flushSync(() => setPlaying(next)),
    view: patch => flushSync(() => {
      if (patch.cameraView !== undefined) setCameraView(patch.cameraView);
      if (patch.showRig !== undefined) setShowRig(patch.showRig);
      if (patch.showGhosts !== undefined) setShowGhosts(patch.showGhosts);
      if (patch.tool !== undefined) { setTool(patch.tool); setMoveModel(false); }
      if (patch.selectedBone !== undefined) { setSelectedBone(patch.selectedBone); setMoveModel(false); }
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

  return <div className="studio-app" onDragOver={e => { if (!Array.from(e.dataTransfer.types).includes('Files')) return; e.preventDefault(); if (!busy && !keyDrag.current) setDragOver(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }} onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files[0]) { cancelKeyDrag(); void handleImport(e.dataTransfer.files[0]); } }} onClick={e => {
    if ((e.target as HTMLElement).closest('canvas, input, select, dialog') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = performance.now(); setSparks(s => [...s.slice(-5), { id, x: e.clientX, y: e.clientY }]); setTimeout(() => setSparks(s => s.filter(v => v.id !== id)), 700);
  }}>
    <header className="topbar">
      {window.stillDesktop && <button className={`button updates-button ${updateState?.status === 'ready' ? 'ready' : ''}`} onClick={() => setDialog('updates')}><Download size={14}/>{updateState?.status === 'ready' ? 'Update ready' : 'Updates'}</button>}
      <a className="wordmark" href="#" aria-label="Still home" onClick={e => { e.preventDefault(); void openLibrary(); }}><span className="brand-symbol"><img src="/still-icon.png" alt=""/></span>still<span className="wordmark-dot">.</span></a>
      <div className="header-divider" />
      <div className="project-heading"><button className="button library-button" aria-label="Character library" disabled={!!busy || !hydrated} onClick={() => void openLibrary()}><Layers2 size={15}/><span>Characters</span></button>{hasActiveScene && <button className="character-breadcrumb" aria-label={`Scenes for ${currentCharacter?.name ?? asset.name}`} disabled={!!busy || !hydrated} onClick={() => void openLibrary(characterId)}><ChevronRight size={13}/><span>{currentCharacter?.name ?? asset.name}</span><ChevronRight size={13}/></button>}<input disabled={!hasActiveScene || !!libraryPreview} aria-label="Scene name" value={studio.title} maxLength={200} onChange={e => { dirty.current = true; setStudio({ ...studio, title: e.target.value }); }}/></div>
      <div className="header-right"><span className="save-status"><span className="status-dot"/>{saveStatus}</span><button className="icon-button theme-toggle" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}</button><button className={`button agent-button ${agentConnection.connected ? 'connected' : ''}`} aria-label="Agent scripting" onClick={() => setDialog('agent')}><span className="status-dot"/>Agent</button><div className="history-tools" data-version={historyVersion}><button className="icon-button" title="Undo · Ctrl Z" aria-label="Undo" disabled={!!libraryPreview || !history.current.past.length} onClick={undo}><Undo2 size={17}/></button><button className="icon-button" title="Redo · Ctrl Shift Z" aria-label="Redo" disabled={!!libraryPreview || !history.current.future.length} onClick={redo}><Redo2 size={17}/></button></div><button className="button export-button" disabled={!hasActiveScene || !!libraryPreview} title={libraryPreview ? 'Apply the previewed motion before exporting' : undefined} onClick={() => setDialog('export')}><ArrowUpRight size={16}/>Export<span className="key-hint">↗</span></button></div>
    </header>

    <div className="workspace" inert={!hasActiveScene}>
      <aside className="left-sidebar">
        <div className="sidebar-section intro-section"><div className="eyebrow">A LITTLE STILL. A LOT OF MOTION.</div><h1>Make your<br/>next move<span>.</span></h1><p>A few poses. Endless possibilities.</p></div>
        <div className="sidebar-section character-section"><div className="section-heading"><h2>Your character</h2><button className="icon-button" title="Browse saved characters" aria-label="Browse characters" onClick={() => void openLibrary()}><Plus size={17}/></button></div>
          <div className="character-card"><div className="character-art"><div className="orbit-ring one"/><div className="orbit-ring two"/><PoseSketch index={1} quadruped={asset.kind === 'quadruped'}/><span className="character-spark">✳</span></div><div className="character-details"><strong title={currentCharacter?.name ?? asset.name}>{currentCharacter?.name ?? asset.name}</strong><span>{asset.rigged ? 'Saved model · locked rig' : 'Add a rig to save this character'}</span></div><span className="ready-dot" title="Loaded"/></div>
          <div className="rig-status"><ShieldCheck size={14}/>{asset.rigged ? getAutoRigDiagnostics(asset) ? getAutoRigDiagnostics(asset)?.hands ? 'Body and finger rig fitted' : 'Body rig fitted' : asset.source === 'import' ? 'Original rig preserved' : `${asset.kind === 'humanoid' ? 'Human' : 'Quadruped'} rig, ready to move` : 'Ready for a simple rig'}<span>{asset.bones.length} joints</span></div>
          <div className="character-import-actions"><button className="import-button" onClick={() => setDialog('import')}><Upload size={17}/><span>Import a character</span><span className="plus-small">+</span></button><button className="import-button animation-import-button" aria-label="Import animation" disabled={!asset.rigged || !!busy || !hydrated} onClick={() => openAnimationImport()}><Activity size={17}/><span>Import animation</span><span className="plus-small" aria-hidden="true">+</span></button><button className="import-button animation-import-button" aria-label="Swap look" title="Put a new mesh and paint on this skeleton. Bones and keys stay exactly the same." disabled={!asset.rigged || !!busy || !hydrated} onClick={() => lookInput.current?.click()}><Shirt size={17}/><span>Swap look</span><span className="plus-small" aria-hidden="true">+</span></button><button className="import-button animation-import-button" aria-label="Fit a part" aria-expanded={fitOpen} title="Move, turn or resize one piece of the look, like a hat, on its bones." disabled={asset.source === 'demo' || !!busy || !hydrated} onClick={() => setFitOpen(open => !open)}><Move3d size={17}/><span>Fit a part</span><ChevronDown size={13} className="plus-small" aria-hidden="true"/></button></div>
          {fitOpen && asset.source !== 'demo' && <PartFit key={asset.root.uuid} asset={asset} disabled={!!busy || !hydrated} onApply={message => { setLookRevision(value => value + 1); dirty.current = true; notify(message); }} onClose={() => setFitOpen(false)}/>}
          <button className="button secondary character-new-scene" aria-label="New scene with this character" disabled={!asset.rigged || !!busy || !hydrated || !characterId} onClick={() => characterId && void createCharacterScene(characterId)}><Plus size={15}/>New scene with this character</button><button className="text-button" disabled={!!busy || !characterId} onClick={() => void openLibrary(characterId)}><Layers2 size={13}/>All scenes for this character</button><div className="format-note">FBX, GLB, or a saved .still scene</div>
        </div>
        <MotionLibrary target={asset} disabled={!asset.rigged || !!busy || !hydrated} onPreview={(keys, duration, name) => { setLibraryPreview({ keys, duration, name }); setTime(0); setPlaying(true); }} onClear={() => { setLibraryPreview(null); setPlaying(false); setTime(value => Math.min(value, studio.duration)); }} onApply={applyImportedAnimation} onNeedsMapping={(file, mode, clipIndex, reason) => { setLibraryPreview(null); setLibraryFitError(reason ?? null); setLibraryImportFile(file); setLibraryImportClipIndex(clipIndex); setAnimationImportMode(mode); setDialog('animation'); }}/>

        <button className="mobile-inspector-toggle" aria-expanded={inspectorOpen} disabled={!!libraryPreview} onClick={() => setInspectorOpen(v => !v)}><SlidersHorizontal size={15}/>Character &amp; joint controls{asset.warnings.length > 0 && <span>{asset.warnings.length} notes</span>}<ChevronDown size={14}/></button><div className="inspector-body" data-open={inspectorOpen} inert={!!libraryPreview}><div className="sidebar-section animation-section"><div className="section-heading"><h2>Animation</h2><span className="tiny-badge">{emptyTrack ? 'READY' : `${editKeys.length} POSES`}</span></div>
          {asset.clips.length > 0 ? <label className="clip-select"><Activity size={15}/><select aria-label="Animation clip" value={studio.sourceClip ?? -1} onChange={e => { if (Number(e.target.value) >= 0) switchClip(Number(e.target.value)); }}><option value={-1}>Edited motion</option>{asset.clips.map((clip, index) => <option value={index} key={index}>{clip.name || `Animation ${index + 1}`}</option>)}</select></label> : <div className="animation-name"><span className="motion-icon"><Activity size={18}/></span><div><strong>{studio.baseMotionName ?? studio.baseTrackName ?? (asset.source === 'demo' ? asset.kind === 'humanoid' ? 'A friendly wave' : 'An easy stride' : 'Base motion')}</strong><span>{studio.duration.toFixed(1)} seconds · {fps} fps</span></div><Check size={14}/></div>}
          {asset.source === 'import' && asset.rigged && <label className="clip-select">Moves like<select aria-label="Character body type" value={asset.kind} disabled={!!busy} onChange={e => { commit({ ...studio, rigKind: e.target.value as RigKind, generated: undefined, generation: undefined }, 'Motion mapping updated. Generate again for this body type; your original rig is preserved.'); }}><option value="humanoid">Two legs</option><option value="quadruped">Four legs</option><option value="creature">Creature / other anatomy</option></select></label>}
          {asset.warnings.length > 0 && <details className="import-notes"><summary>Import notes ({asset.warnings.length})</summary>{asset.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
        </div>

        <div className="sidebar-section selection-section"><div className="section-heading"><h2>{selectedBone === null ? 'Make it yours' : 'Selected joint'}</h2><MousePointer2 size={14}/></div>
          {selectedBone === null ? <div className="selection-empty"><div className="little-pointer"><Move size={23}/></div><strong>Grab a joint. Try something.</strong><p>Drag the dots on your character.<br/>The rest of the limb follows along.</p><button className="text-button" onClick={() => setSelectedBone(Math.max(0, asset.bones.findIndex(b => /righthand/i.test(b.name))))} disabled={!asset.bones.length}>Try the right hand <ArrowRight size={13}/></button></div> : <div className="joint-controls"><select aria-label="Selected joint" value={selectedBone} onChange={e => setSelectedBone(Number(e.target.value))}>{asset.bones.map((bone, index) => <option key={index} value={index}>{niceName(bone.name)}</option>)}</select><div className="axis-fields">{['X', 'Y', 'Z'].map((axis, i) => <label key={axis}><span>{axis}</span><input type="number" aria-label={`${axis} joint rotation`} step="5" value={selectedRotation[i]} onChange={e => { if (e.target.value === '') return; const value = Number(e.target.value); if (!Number.isFinite(value)) return; const values = [...selectedRotation]; values[i] = value; const pose = clone(currentPose); pose[selectedBone].quaternion = new Quaternion().setFromEuler(new Euler(...values.map(MathUtils.degToRad) as [number, number, number], 'XYZ')).toArray(); writePose(pose); }}/><small>°</small></label>)}</div><button className="text-button" onClick={() => { const pose = clone(currentPose); pose[selectedBone] = clone(asset.restPose[selectedBone]); writePose(pose); }}><RotateCcw size={13}/>Reset this joint</button><p className="micro-copy">Changes become a pose automatically.</p></div>}
          {asset.bones.some(b => isFingerBone(b.name)) && <><div className="finger-display-control"><span>Finger joints</span><Switch label="Show finger joints" checked={showFingerJoints} onChange={() => { if (!showFingerJoints) setShowRig(true); setShowFingerJoints(value => !value); }}/></div><button className="text-button finger-focus-button" onClick={() => {
            applyPose(asset, currentPose);
            const bone = selectedBone !== null ? asset.bones[selectedBone] : asset.bones.find(b => /hand$/i.test(b.name));
            if (!bone || !viewportAPI.current) return;
            const target = bone.getWorldPosition(new Vector3());
            viewportAPI.current.setCamera({ target: target.toArray(), position: target.clone().add(new Vector3(0, .25, 1.25)).toArray(), fov: 20 }); setShowRig(true); setShowFingerJoints(true);
          }}><Hand size={13}/>Focus selected hand / joint</button></>}
        </div>
        </div><button className="help-card" onClick={() => setDialog('help')}><span className="help-illustration"><Hand size={22}/></span><span><strong>First time animating?</strong><small>You’re in the right place.</small></span><ArrowUpRight size={16}/></button>
        <div className="sidebar-footer"><span className="small-brand">STILL STUDIO</span><span>Made for making.</span></div>
      </aside>

      <main className="editor">
        <div className="scene-heading"><div><span className="scene-dot"/>YOUR PLAYGROUND<span className="scene-separator">/</span><span className="scene-name">{studio.title || 'Untitled'}</span></div><button className="text-button" onClick={() => setDialog('help')}><CircleHelp size={14}/><span>A quick tour</span></button></div>
        <div className="stage-and-assists">
          <section className="viewport-shell" aria-label="Character editor">
            <Viewport theme={theme} apiRef={viewportAPI} asset={asset} pose={previewPose} comparisonPose={viewingSplit && !libraryPreview ? beforePose : undefined} selectedBone={selectedBone} onSelectBone={index => { setPlaying(false); setSelectedBone(index); }} onPoseChange={writePose} editable={!viewingBefore && !busy && !libraryPreview && !trackMuted} moveModel={moveModel && !viewingBefore && !libraryPreview && !trackMuted} zoomToCursor={zoomToCursor} showRig={showRig} showFingerJoints={showFingerJoints} showGhosts={showGhosts && !viewingBefore && !libraryPreview} ghostPoses={ghostPoses} cameraView={cameraView} tool={tool} follow={follow && tool === 'move' ? followFeel : null} playing={playing}/>
            <div className={`viewport-top ${studio.generation?.kind === 'physics' ? 'has-physics-comparison' : ''}`}><div className="mode-pill"><span className={playing ? 'live-dot' : 'mode-dot'}/>{libraryPreview ? `Preview · ${libraryPreview.name}` : viewingBefore ? 'Before physics' : playing ? 'In motion' : 'Pose mode'}<span>{libraryPreview ? `${libraryPreview.duration.toFixed(2)}s · scene unchanged` : selectedKey ? `Pose ${keyIndex + 1}` : 'Between poses'}</span></div>{!libraryPreview && studio.generated && studio.generation?.kind === 'physics' && <div className="physics-compare-switch viewport-compare-switch" role="group" aria-label="Compare physics motion"><button aria-label="Before physics" aria-pressed={viewingBefore} disabled={!comparison || !!busy || !!dragPreview} onClick={() => { setSelectedBone(null); setComparisonView('before'); }}>Before</button><button aria-label="Side-by-side physics comparison" aria-pressed={viewingSplit} disabled={!comparison || !!busy || !!dragPreview} onClick={() => { setSelectedBone(null); setComparisonView('split'); }}>Side by side</button><button aria-label="After physics" aria-pressed={!viewingBefore && !viewingSplit} disabled={!!busy || !!dragPreview} onClick={() => setComparisonView('after')}>After</button></div>}<button className={`icon-button viewport-icon ${showGhosts ? 'active' : ''}`} aria-label="Toggle onion skin" aria-pressed={showGhosts && !viewingBefore} disabled={viewingBefore} title={viewingBefore ? 'Onion skin is available in After physics' : 'Show neighboring poses'} onClick={() => setShowGhosts(v => !v)}><Layers2 size={17}/></button></div>
            <div className="viewport-tools"><button aria-label="Move joint" title="Move joint · W" className={!moveModel && tool === 'move' ? 'active' : ''} onClick={() => { setTimelineMode(false); setTool('move'); }}><Move size={18}/></button><button aria-label="Rotate joint" title="Rotate joint · E" className={!moveModel && tool === 'rotate' ? 'active' : ''} onClick={() => { setTimelineMode(false); setTool('rotate'); }}><RotateCw size={18}/></button><button aria-label="Follow chain" title="Follow · F · Move a head and its neck bends after it" aria-pressed={follow} className={`follow-toggle ${follow ? 'active secondary' : ''}`} onClick={() => { setTimelineMode(false); setMoveModel(false); setTool('move'); setFollow(value => !value); }}><Spline size={18}/></button>{follow && <label className="follow-feel" title="How the neck bends behind the head"><span>Snaky</span><input type="range" min="0" max="1" step="0.05" aria-label="Follow feel, snaky to robotic" value={followFeel} onChange={event => setFollowFeel(Number(event.target.value))}/><span>Robotic</span></label>}<div/><button aria-label="Show joints" title="Show joints" aria-pressed={showRig} className={showRig ? 'active secondary' : ''} onClick={() => setShowRig(v => !v)}><Bone size={18}/></button></div>
            <button className="button model-move-toggle" aria-label="Move whole model" aria-pressed={moveModel && !trackMuted} aria-keyshortcuts="G" title="Move whole model · G. Drag across the floor; Shift-drag to change height." disabled={trackMuted || !asset.rigged || !!busy || viewingBefore} onClick={toggleModelMove}><Move size={16}/>Move model<kbd>G</kbd></button>
            {!viewingSplit && <div className="viewport-label"><span className="viewport-kicker">LESS LEARNING. MORE MAKING.</span><span className="viewport-big-word">Let’s move.</span></div>}
            <div className="viewport-bottom"><span className="viewport-instruction"><MousePointer2 size={13}/>{libraryPreview ? 'Preview only · use Apply or Append in Motion Library' : moveModel && !viewingBefore ? 'Move this pose: drag the character across the floor · Shift-drag for height · Esc to exit' : viewingSplit ? 'Shared camera · edit poses on the right' : viewingBefore ? 'Before physics · drag the background to orbit' : selectedBone !== null ? `${niceName(asset.bones[selectedBone]?.name || '')} selected · drag to pose` : 'Drag a joint to pose · drag the background to orbit'}</span><div className="view-picker">{(['perspective', 'front', 'side'] as const).map(view => <button key={view} className={cameraView === view ? 'active' : ''} onClick={() => setCameraView(view)}>{view === 'perspective' ? '3D' : view.charAt(0).toUpperCase() + view.slice(1)}</button>)}<button aria-label="Viewport settings" title="Viewport settings" onClick={() => setDialog('viewport')}><Settings2 size={13}/></button></div></div>
            {!asset.rigged && <div className="rig-overlay"><Bone size={24}/><strong>Let’s give it some joints.</strong><p>Choose a simple skeleton to start posing.</p><button className="button primary" onClick={() => setDialog('rig')}>Add a rig <ArrowRight size={15}/></button></div>}
          </section>

          <aside className="assist-panel" inert={!!libraryPreview}><div className="assist-heading"><span className="assist-icon"><Sparkles size={19}/></span><span className="eyebrow">A LITTLE HELP</span><h2>You pose.<br/>We connect the dots.</h2><p>Good motion starts with a few good moments.</p></div>
            <FaceShapes key={`face:${sceneId}:${asset.root.uuid}`} asset={asset} keys={motionKeys} moments={editKeys} pose={currentPose} time={time} duration={studio.duration} fps={fps} interpolation={playbackMode} disabled={trackMuted || !!busy || !!dragPreview || !!selectionRange || !hydrated || viewingBefore} onPause={() => setPlaying(false)} onCommit={key => { if (trackMuted) return; commit(putLayerKey(studio, key, sampleLayers(time), asset.restPose, asset.restMorphs)); setPlaying(false); setTime(key.time); }}/>
            {getAutoRigDiagnostics(asset) && <details className="assist-section generation-details"><summary>Rig fit checks</summary><p>{getAutoRigDiagnostics(asset)?.evidence === 'clear' ? 'Body landmarks found.' : 'Joint positions are estimates to review.'} Try a small bend before animating.</p>{getAutoRigDiagnostics(asset)?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}<div className="assist-section ai-section"><div className="section-heading"><h3>AI in-betweening</h3><span className={`engine-tag ${learnedProvider ? 'ready' : ''}`}>{learnedProvider ? 'ON DEVICE' : 'NOT READY'}</span></div><p className="micro-copy">A trained motion model fills the space between your poses.</p>{studio.generation?.source && <p className="micro-copy">Following your original motion. <button className="text-button" disabled={!!busy || !hydrated || viewingBefore} onClick={() => commit({ ...studio, generated: undefined, generation: undefined }, studio.generated ? 'Original guide and generated take removed. Your authored poses are unchanged.' : 'Original guide removed. Your authored poses are unchanged.')}>Use only my poses</button></p>}{learnedProvider?.id === 'motionbricks' && studio.keys.length > 24 && <p className="micro-copy">We’ll keep your full original clip in Scenes before finding six key poses.</p>}{learnedProviders.length > 1 && <select className="engine-select" aria-label="AI motion engine" value={learnedProvider?.id} onChange={e => setEngineChoice(e.target.value as EngineProvider['id'])}>{learnedProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>}<button className="button primary generate-button" disabled={!learnedProvider || learnedClipTooLong || !asset.rigged || !!busy} onClick={() => learnedProvider && void runMotionEngine(learnedProvider)}><Sparkles size={15}/>{studio.generated ? (learnedProvider?.id === 'motionbricks' ? 'Regenerate motion' : 'Generate another take') : studio.keys.length > 24 ? 'Find 6 poses & generate' : 'Generate motion'}<ArrowRight size={14}/></button><p className="engine-caption">{learnedProvider ? (learnedClipTooLong ? `${learnedProvider.name} supports clips up to ${learnedDurationLimit} seconds. ${learnedProviders.some(provider => provider.id !== learnedProvider.id && (provider.limits?.maxDuration ?? Infinity) >= studio.duration) ? 'Choose another AI motion engine above.' : 'Shorten this clip to generate.'}` : `${learnedProvider.name} · your key poses stay exact`) : engine ? (asset.kind === 'creature' ? 'Creature rigs use imported clips and editable pose interpolation. Human and quadruped AI models do not support this anatomy.' : asset.kind === 'humanoid' ? (engine.unavailableProviders?.find(provider => provider.id === 'motionbricks')?.message ?? 'No human motion model is installed. Install MotionBricks or use pose interpolation and imported clips.') : 'No validated animal model is installed. Curve interpolation is available.') : 'Start the local engine to enable AI.'}{learnedProvider?.id === 'owned_humanoid' && ' · Limited motion coverage'}{learnedProvider?.id === 'inbetween' && ' · Commercial rights pending'}</p>{studio.generated && studio.generation?.kind === 'inbetween' && <details className={`generation-details ${needsReview ? 'needs-review' : ''}`}><summary><Check size={12}/>{needsReview ? 'Motion · review needed' : studio.generation.kind === 'inbetween' ? 'AI take ready' : 'Dynamics pass ready'}<span>{studio.generated?.length} frames</span></summary><p>{studio.generation.name}. Editing a pose returns to your key moments; generate again to update the motion.</p>{studio.generation.warnings.map((warning, i) => <p key={i}>{warning}</p>)}<button className="text-button" onClick={() => downloadFile(JSON.stringify(studio.generation, null, 2), 'motion-generation-report.json', 'application/json')}>Save generation report <ArrowDownToLine size={12}/></button></details>}</div>

            <div className="assist-section physics-section"><div className="section-heading"><h3>Physics correction</h3><span className={`engine-tag ${physicsProvider ? 'ready' : ''}`}>{physicsProvider ? 'DYNAMICS' : 'OFFLINE'}</span></div>{physicsProviders.length > 1 && <select className="engine-select" aria-label="Physics engine" value={physicsProvider?.id} onChange={e => setPhysicsChoice(e.target.value as EngineProvider['id'])}>{physicsProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select>}<div className="setting-row"><div><Footprints size={15}/><span>Keep feet planted</span></div><Switch label="Floor contact" checked={physicsProvider?.limits?.requiresFloorContact || studio.settings.floorContact} disabled={asset.kind === 'creature' || physicsProvider?.limits?.requiresFloorContact} onChange={() => changeSettings({ floorContact: !studio.settings.floorContact })}/></div><div className="setting-row"><label htmlFor="gravity">Gravity</label><select id="gravity" disabled={physicsProvider?.limits?.earthGravityOnly} value={physicsProvider?.limits?.earthGravityOnly ? 9.81 : studio.settings.gravity} onChange={e => changeSettings({ gravity: Number(e.target.value) })}><option value="9.81">Earth</option><option value="1.62">Moon</option><option value="0">Weightless</option></select></div><div className="strength-label"><label htmlFor="strength">A helping hand</label><span>{Math.round(studio.settings.strength * 100)}%</span></div><input id="strength" type="range" min="0" max="1" step=".05" value={studio.settings.strength} onChange={e => changeSettings({ strength: Number(e.target.value) })}/><button className="button assist-button" disabled={!physicsProvider || !asset.rigged || !!busy} onClick={() => physicsProvider && void runMotionEngine(physicsProvider)}><Activity size={15}/>Correct with physics<ArrowRight size={14}/></button><p className="micro-copy physics-note">{physicsProvider ? 'Articulated dynamics, gravity, and contact forces. Poses may shift to improve balance.' : asset.kind === 'creature' ? 'These physics engines require human or quadruped anatomy. Creature poses use interpolation.' : 'Start the local engine to enable dynamics.'}</p>{studio.generated && studio.generation?.kind === 'physics' && !comparison && needsReview && <p className="micro-copy">Clip edited. Run physics again to refresh contact measurements and comparison.</p>}{studio.generated && studio.generation?.kind === 'physics' && (comparison || !needsReview) && <button className="button physics-report-button" onClick={() => setDialog('physics')}>{needsReview ? 'Review physics changes' : 'See physics changes'}<ArrowUpRight size={13}/></button>}<button className="text-button quick-ground" disabled={asset.kind === 'creature' || !asset.rigged || !!busy} onClick={() => void assistMotion()}>Quick ground pass <Footprints size={12}/></button></div>
            <details className="assist-section curve-section"><summary>Curve interpolation<span>{(editingTrack?.interpolation ?? studio.settings.interpolation) === 'smooth' ? 'Smooth' : (editingTrack?.interpolation ?? studio.settings.interpolation) === 'linear' ? 'Direct' : 'Hold'}</span><ChevronDown size={12}/></summary><div className="blend-options">{(['smooth', 'linear', 'stepped'] as InterpolationMode[]).map(mode => <button key={mode} className={(editingTrack?.interpolation ?? studio.settings.interpolation) === mode ? 'active' : ''} onClick={() => changeSettings({ interpolation: mode })}>{mode === 'smooth' ? 'Smooth' : mode === 'linear' ? 'Direct' : 'Hold'}</button>)}</div><div className={`curve-preview ${(editingTrack?.interpolation ?? studio.settings.interpolation)}`}><svg viewBox="0 0 220 52" aria-hidden="true"><path className="curve-guide" d="M8 44H212M8 26H212M8 8H212"/><path className="curve-path" d={(editingTrack?.interpolation ?? studio.settings.interpolation) === 'smooth' ? 'M8 44C84 44 116 8 212 8' : (editingTrack?.interpolation ?? studio.settings.interpolation) === 'linear' ? 'M8 44L212 8' : 'M8 44H110V8H212'}/><circle cx="8" cy="44" r="4"/><circle cx="212" cy="8" r="4"/></svg><span>POSE A</span><span>POSE B</span></div><p className="micro-copy">{(editingTrack?.interpolation ?? studio.settings.interpolation) === 'smooth' ? 'Soft starts. Natural arcs. Your poses stay yours.' : (editingTrack?.interpolation ?? studio.settings.interpolation) === 'linear' ? 'A direct, constant-speed blend between poses.' : 'Hold each pose until the next. Great for blocking.'}</p></details>
            <ClipTools key={`${sceneId}:${asset.root.uuid}`} duration={studio.duration} fps={fps} clips={asset.clips} disabled={!asset.rigged || !!busy || !!dragPreview || !!selectionRange || !hydrated || viewingBefore} onPause={() => setPlaying(false)} onEdit={editClip} onAppend={appendClip} onAppendProject={(file, blend) => void appendSavedTake(file, blend)} onImportAnimation={() => openAnimationImport('append')}/>
            <div className="simplify-card"><span className="six-dots">•••<br/>•••</span><div><strong>Find the key moments.</strong><p>Turn a busy timeline into six editable poses.</p></div><button className="text-button" disabled={editKeys.length <= 6 || trackMuted} onClick={simplifyMotion}>Simplify to 6 poses <ArrowUpRight size={13}/></button></div>
          </aside>
        </div>

        <section className="timeline-section compact-timeline" inert={!!libraryPreview} aria-label="Animation timeline" onDragStart={e => e.preventDefault()}>
          <AnimationTracks coveredBy={coveringTrackNames(studio, time)} tracks={studio.tracks ?? []} baseName={studio.baseTrackName ?? 'Base motion'} baseMuted={!!studio.baseTrackMuted} baseKeys={studio.keys} activeId={editingTrack?.id ?? null} duration={studio.duration} time={time} fps={fps} disabled={!!busy || !!dragPreview || !hydrated || !asset.rigged}
            onAdd={addTrack} onSelect={selectTrack} onTime={value => { setPlaying(false); setTime(Math.min(studio.duration, Math.round(value * fps) / fps)); }} onUpdate={updateTrack} onCopy={copyTrack} onReorder={reorderTrack} onMove={moveTrack} onMoveKey={moveTrackKey}
            onDelete={id => { commit({ ...studio, tracks: studio.tracks!.filter(t => t.id !== id), activeTrackId: null }, 'Track deleted. Undo brings it back.'); setPlaying(false); }}/>
<div className="timeline-heading"><div className="timeline-title"><h2>{editingTrack?.name ?? studio.baseTrackName ?? 'Base motion'}</h2><span>{emptyTrack ? 'Ready to animate' : `${editKeys.length} poses`}<span className="timeline-dot">·</span>{studio.generation?.kind === 'inbetween' ? 'AI motion ready' : studio.generation?.kind === 'physics' ? 'dynamics applied' : 'one fluid motion'}</span></div><div className="timeline-actions"><button className="button" aria-expanded={timelineToolsOpen} aria-controls="timeline-details" onClick={() => setTimelineToolsOpen(open => !open)}>Clip &amp; position<ChevronDown size={13}/></button>{editKeys.length > 6 && <button className="button simplify-timeline" onClick={simplifyMotion}><Sparkles size={13}/><span>Simplify to 6</span></button>}<button className="button duplicate-pose-button" title="Duplicate selected moment · Ctrl D" aria-label="Duplicate selected moment" disabled={trackMuted || !selectedKey || !asset.rigged || !!dragPreview || selectionMode} onClick={duplicateKey}><Copy size={14}/><span>Duplicate</span></button>{!selectionMode && <button className="icon-button" title="Delete selected pose" aria-label="Delete selected pose" disabled={trackMuted || !selectedKey || editKeys.length <= 2} onClick={deleteKey}><Trash2 size={15}/></button>}<button className="button add-pose-button" disabled={trackMuted || !asset.rigged} onClick={addKey}><Plus size={15}/>{selectedKey ? 'Update pose' : 'Add a pose'}<kbd>K</kbd></button></div></div>
          <div className="timeline-toolbar">
          <div className="keyframe-clipboard" aria-label="Keyframe editing tools">
            <button className="button" aria-label="Move selected keyframe" title="Move selected keyframe to a time · M" aria-keyshortcuts="M" disabled={trackMuted || !selectedKey || selectionMode || !!busy || !!dragPreview} onClick={() => { setPlaying(false); setMovingKey(selectedKey!.id); setMoveTime(selectedKey!.time.toFixed(3)); }}><Move size={14}/>Move…</button>
            <button className="button" aria-label="Copy keyframes" title="Copy selected keyframes · Ctrl C" disabled={selectionMode ? !selectedIds.size || !!busy || !!selectionRange : !selectedKey || !!busy || !!dragPreview} onClick={copyKeyframes}><Copy size={14}/>Copy</button>
            <button className="button" aria-label="Paste keyframes at playhead" title="Paste at the playhead · Ctrl V" disabled={trackMuted || !keyClipboard || !!busy || !!dragPreview || !!selectionRange} onClick={pasteKeyframes}><Save size={14}/>Paste here</button>
            <span className={keyClipboard ? 'clipboard-status' : 'editing-hint'}>{keyClipboard ? keyClipboard.keys.length + ' copied · paste at ' + time.toFixed(2) + 's' : 'Click a diamond to select it. Move it, or Copy → click a time → Paste.'}</span>
          </div>
          <div className="timeline-edit-tools"><button className="button ripple-button" aria-label="Select keyframes" title="Toggle Select / regular mode · S (Esc returns to regular mode)" aria-keyshortcuts="S" aria-pressed={selectionMode} disabled={!!busy || !!dragPreview} onClick={() => setTimelineMode(!selectionMode)}><MousePointer2 size={13}/>{selectionMode ? 'Select mode' : 'Select'}<kbd>S</kbd></button><button className="button ripple-button" aria-label="Ripple edit" aria-pressed={ripple} title="Move a pose and all later poses together · R" aria-keyshortcuts="R" disabled={!!busy || !!dragPreview || selectionMode} onClick={() => setRipple(value => !value)}><ArrowRight size={13}/>Ripple<span>{ripple ? 'On' : 'Off'}</span><kbd>R</kbd></button>{selectionMode ? <><span className="editing-hint">Drag across diamonds. Ctrl-click to add or remove. Esc returns to regular mode.</span><button className="button selection-delete" disabled={trackMuted || !selectedIds.size || !!selectionRange} onClick={deleteKey}><Trash2 size={13}/>Delete {selectedIds.size || ''} selected</button><span role="status">{selectedIds.size} selected · keep at least 2 poses</span></> : <span className="editing-hint">{ripple ? 'Drag a diamond to move it and all later poses.' : 'Drag a diamond to move it. Drop on a pose to replace it. Shift-drag moves later poses.'}</span>}{dragPreview?.ripple && <output>{dragPreview.duration.toFixed(2)}s total</output>}</div>
          <div className="timeline-view-tools" aria-label="Timeline zoom"><button className="button" aria-label="Zoom timeline out" disabled={visibleTimelineSeconds >= timelineDuration} onClick={() => setTimelineWindow(Math.min(timelineDuration, visibleTimelineSeconds * 2))}>−</button><button className="button" aria-label="Zoom timeline in" disabled={visibleTimelineSeconds <= Math.min(.1, timelineDuration)} onClick={() => setTimelineWindow(Math.max(Math.min(.1, timelineDuration), visibleTimelineSeconds / 2))}>+</button><button className="button" onClick={() => setTimelineWindow(timelineDuration)}>Fit clip</button><span>{visibleTimelineSeconds.toFixed(2)}s view</span></div>
          </div>
          {movingKey && selectedKey && <form className="keyframe-move" onSubmit={event => { event.preventDefault(); moveSelectedKey(); }}><label>Move keyframe to <input autoFocus aria-label="Move keyframe to seconds" type="number" min="0" max={MAX_ANIMATION_DURATION} step={1 / fps} value={moveTime} onChange={event => setMoveTime(event.target.value)}/> seconds</label><button className="button primary" disabled={!!busy || !moveTime.trim()}>Move keyframe</button><button type="button" className="text-button" onClick={() => setMovingKey(null)}>Cancel</button><small>A pose at that time is replaced. Undo restores it.</small></form>}
          <div className="timeline-details" id="timeline-details" hidden={!timelineToolsOpen}>
          <div className="clip-length-tools" aria-label="Clip length tools"><label>Clip end <input aria-label="Clip end seconds" type="number" min=".1" max={MAX_ANIMATION_DURATION} step={1 / fps} value={durationInput} disabled={!!busy || !!dragPreview || !!selectionRange} onChange={event => setDurationInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); changeDuration(durationInput.trim() ? Number(durationInput) : NaN); } }}/> s</label><button className="button" disabled={!!busy || !!dragPreview || !!selectionRange} onClick={() => changeDuration(durationInput.trim() ? Number(durationInput) : NaN)}>Set end</button><button className="button" aria-label="End clip at playhead" disabled={time < .1 || time >= studio.duration || !!busy || !!dragPreview || !!selectionRange} onClick={() => changeDuration(time)}>End clip here</button><button className="button" aria-label="Remove empty clip tail" disabled={authoredEnd < .1 || authoredEnd >= studio.duration - 1e-9 || !!busy || !!dragPreview || !!selectionRange} onClick={() => changeDuration(authoredEnd)}>Remove empty tail</button><span>Trims the end. Earlier keyframes stay in place.</span></div>
          {asset.rigged && <KeyframeProperties key={`${sceneId}:${asset.root.uuid}`} asset={asset} pose={currentPose} selectedBone={selectedBone} reference={poseReference} selectedCount={selectedIds.size} selectionMode={selectionMode} disabled={trackMuted || !!busy || !!dragPreview || !!selectionRange || !hydrated || viewingBefore}
            onPosition={position => { try { const pose = setModelPosition(asset, currentPose, position); if (pose !== currentPose) writePose(pose); } catch (error) { setError(error instanceof Error ? error.message : 'The model could not be moved.'); } }}
            onCopy={() => { setPlaying(false); setPoseReference({ storedPose: selectedKey?.pose, keyId: selectedKey?.id ?? null, time, before: clone(currentPose), after: clone(currentPose), bone: selectedBone }); notify('Property values copied. Select poses and choose the axes to paste.'); }}
            onSelect={() => { setSelectionMode(true); setSelectedIds(new Set()); setRipple(false); setPlaying(false); }} onPause={() => setPlaying(false)} onApply={applyProperty} onOffset={moveAnimation}/>}
          </div>
          <details className="track-pose-previews"><summary>Pose previews</summary><div className="pose-cards">{shownKeys.map((key) => <button className={`pose-card ${selectedKey?.id === key.id ? 'selected' : ''}`} key={key.id} onClick={() => { setPlaying(false); setTime(key.time); }} aria-label={`Go to pose ${poseKeys.findIndex(k => k.id === key.id) + 1}`}><div className="pose-card-top"><span>{String(poseKeys.findIndex(k => k.id === key.id) + 1).padStart(2, '0')}</span><span className="key-diamond"/></div><PoseThumbnail asset={asset} pose={key.pose}/><div className="pose-card-caption"><span>{key.label || `Pose ${poseKeys.findIndex(k => k.id === key.id) + 1}`}</span><span>{key.time.toFixed(2)}s</span></div></button>)}<button className="new-pose-card" title="Add a pose at the playhead" disabled={!asset.rigged || trackMuted} onClick={addKey}><Plus size={19}/><span>A new moment</span></button></div></details>
          <div className="timeline-scroll" ref={timelineScroll} onScroll={event => { if (timeline.current) setTimelineStart(event.currentTarget.scrollLeft / timeline.current.clientWidth * timelineDuration); }}><div className="scrubber" ref={timeline} style={{ width: `${timelineDuration / visibleTimelineSeconds * 100}%` }} data-dragging={!!dragPreview} data-selecting={selectionMode}
            onPointerDown={e => { if (busy || e.button !== 0 || keyDrag.current || (e.target as HTMLElement).closest('.timeline-key, input')) return; e.preventDefault(); if (selectionMode) startSelection(e.clientX, e.pointerId, e.ctrlKey || e.metaKey); else { e.currentTarget.setPointerCapture(e.pointerId); scrub(e.clientX); } }}
            onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; if (selectionDrag.current) extendSelection(e.clientX); else if (keyDrag.current) previewKeyDrag(e.clientX, e.pointerId); else scrub(e.clientX); }}
            onPointerUp={e => { if (selectionDrag.current) { extendSelection(e.clientX); selectionDrag.current = null; setSelectionRange(null); } else if (keyDrag.current) finishKeyDrag(e.clientX, e.pointerId); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
            onPointerCancel={e => { cancelKeyDrag(e.pointerId); cancelSelection(); }} onLostPointerCapture={e => { cancelKeyDrag(e.pointerId); cancelSelection(); }}>
            <div className="ruler-labels">{rulerTimes.map(value => <span key={value} style={{ position: 'absolute', left: `${value / timelineDuration * 100}%`, transform: value === 0 ? undefined : value === timelineDuration ? 'translateX(-100%)' : 'translateX(-50%)' }}>{value.toFixed(rulerStep >= .1 ? 1 : 2)}<small>s</small></span>)}</div>
            <div className="timeline-track"><div className="timeline-progress" style={{ width: `${time / timelineDuration * 100}%` }}/>{selectionRange && <div className="timeline-selection-range" style={{ left: `${selectionRange.start / timelineDuration * 100}%`, width: `${(selectionRange.end - selectionRange.start) / timelineDuration * 100}%` }}/>}{poseKeys.map((key, i) => <button key={key.id} className={`timeline-key ${selectedKey?.id === key.id ? 'selected' : ''} ${selectedIds.has(key.id) ? 'multi-selected' : ''} ${dragPreview?.id === key.id ? 'dragging' : ''} ${dragPreview?.ripple && key.time >= dragPreview.time ? 'ripple-moving' : ''}`} style={{ left: `${key.time / timelineDuration * 100}%` }}
              aria-pressed={selectionMode ? selectedIds.has(key.id) : undefined} aria-label={`Pose ${i + 1} at ${key.time.toFixed(2)} seconds. ${selectionMode ? 'Select for bulk editing.' : 'Drag or Alt arrows to retime. Hold Shift to move all later poses.'}`} title={`Pose ${i + 1} · ${key.time.toFixed(2)}s · ${selectionMode ? 'select for bulk editing' : 'drag or Alt ← → to retime · Shift moves all later poses'}`} disabled={!!busy || trackMuted}
              onKeyDown={e => { if (selectionMode && (e.code === 'Space' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); setSelectedIds(previous => { const next = new Set(previous); if (next.has(key.id)) next.delete(key.id); else next.add(key.id); return next; }); } else if (!selectionMode && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); e.stopPropagation(); nudgeKey(key, e.key === 'ArrowLeft' ? -1 : 1, ripple || e.shiftKey); } }}
              onClick={e => { if (e.detail === 0) { if (selectionMode) setSelectedIds(previous => { const next = new Set(previous); if (next.has(key.id)) next.delete(key.id); else next.add(key.id); return next; }); else { setPlaying(false); setTime(key.time); } } }}
              onPointerDown={e => { e.stopPropagation(); if (e.button !== 0 || !timeline.current || keyDrag.current) return; e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); if (selectionMode) { startSelection(e.clientX, e.pointerId, e.ctrlKey || e.metaKey, key); return; } keyDrag.current = { id: key.id, pointerId: e.pointerId, startX: e.clientX, startTime: key.time, time: key.time, beforeTime: time, moved: false, ripple: ripple || e.shiftKey, studio, asset, fps }; timeline.current.setPointerCapture(e.pointerId); setPlaying(false); setTime(key.time); }}/>)}</div>
            <div className="playhead" style={{ left: `${time / timelineDuration * 100}%` }}><span/></div><input className="accessible-scrubber" aria-label="Timeline playhead" type="range" min="0" max={timelineDuration} step={1 / fps} value={time} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }}/>
          </div>
          </div>
          <div className="transport"><div className="playback-buttons"><button className="icon-button" aria-label="Go to beginning" onClick={() => { setPlaying(false); setTime(0); }}><SkipBack size={15}/></button><button className="icon-button" aria-label="Previous frame" onClick={() => { setPlaying(false); setTime(t => Math.max(0, t - 1 / fps)); }}><ChevronLeft size={19}/></button><button className="play-button" aria-label={playing ? 'Pause animation' : 'Play animation'} onClick={() => setPlaying(v => !v)}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</button><button className="icon-button" aria-label="Next frame" onClick={() => { setPlaying(false); setTime(t => Math.min(studio.duration, t + 1 / fps)); }}><ChevronRight size={19}/></button><button className="icon-button" aria-label="Go to end" onClick={() => { setPlaying(false); setTime(studio.duration); }}><SkipForward size={15}/></button><span className="timecode">{time.toFixed(2)}<span>/ {timelineDuration.toFixed(2)} s</span></span></div><span className="transport-tip"><kbd>space</kbd> to play. Curiosity to create.</span><div className="duration-controls"><label><input aria-label="Animation duration seconds" title="Clip end: adds or removes time without stretching keyframes" type="number" min=".1" max={MAX_ANIMATION_DURATION} step=".5" value={dragPreview ? String(Number(timelineDuration.toFixed(3))) : durationInput} disabled={!!busy || !!dragPreview || !!selectionRange} onChange={e => setDurationInput(e.target.value)} onBlur={() => changeDuration(durationInput.trim() ? Number(durationInput) : NaN)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>sec</label><select aria-label="Frames per second" value={fps} onChange={e => setFps(Number(e.target.value))}><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></div></div>
        </section>
        <footer className="editor-footer"><span><span className="status-dot"/>Scenes stay on your device. Meshy runs only when you opt in.</span><div className="ticker"><span>SMALL MOVES. BIG POSSIBILITIES. &nbsp;✳&nbsp; YOUR CHARACTER. YOUR WAY. &nbsp;✳&nbsp; SMALL MOVES. BIG POSSIBILITIES. &nbsp;✳&nbsp; YOUR CHARACTER. YOUR WAY.</span></div><button title="Keyboard shortcuts · ? or F1" aria-keyshortcuts="? F1" onClick={() => setDialog('shortcuts')}><Keyboard size={13}/><span>Shortcuts</span><kbd>?</kbd></button></footer>
      </main>
    </div>

    <input ref={lookInput} type="file" className="hidden" accept=".fbx,.glb,.gltf" aria-label="Swap look file" onChange={e => { if (e.target.files?.[0]) void swapLook(e.target.files[0]); }}/>
    <input ref={importInput} type="file" className="hidden" accept=".fbx,.glb,.gltf,.still,.json" aria-label="Import file" onChange={e => { if (e.target.files?.[0]) void handleImport(e.target.files[0]); }}/>
    {dragOver && <div className="drop-overlay"><Upload size={38}/><h2>Drop it like it’s a character.</h2><p>FBX, GLB, or a Still project</p></div>}
    {(!hydrated || busy) && <div className="busy-overlay" role="status"><LoaderCircle size={24} className="spin"/><strong>{busy || 'Setting the stage…'}</strong>{agentActivity?.status === 'running' && <>{progress !== null && <progress className="engine-progress" aria-label="Agent command progress" max="1" value={progress}/>}<button className="button secondary" onClick={() => agentController.current?.abort()}>Stop agent command</button></>}{progress !== null && !exportRunning && agentActivity?.status !== 'running' && <><progress className="engine-progress" aria-label="Motion generation progress" max="1" value={progress}/><button className="button secondary" onClick={() => engineOperation.current?.abort()}>Cancel generation</button></>}</div>}
    {notice && <div className="toast" role="status"><Check size={17}/><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14}/></button></div>}
    {error && <div className="error-toast" role="alert"><CircleHelp size={19}/><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={16}/></button></div>}
    {sparks.map(s => <span className="click-spark" key={s.id} style={{ left: s.x, top: s.y }}>✳</span>)}

    <dialog ref={dialogRef} className={`modal ${dialog === 'help' ? 'help-modal' : ''} ${dialog === 'rig' && rigDraft ? 'hand-rig-modal' : ''} ${dialog === 'physics' ? 'physics-report-modal' : ''} ${dialog === 'library' ? 'scene-library-modal' : ''}`} onCancel={e => { if (busy || exportRunning || updateState?.status === 'installing' || !hasActiveScene) { e.preventDefault(); if (!busy && !hasActiveScene) setDialog('library'); } else setDialog(null); }} onClick={e => { if (e.target === e.currentTarget && !busy && !exportRunning && updateState?.status !== 'installing' && hasActiveScene) setDialog(null); }}><div className="modal-inner"><button className="icon-button modal-close" aria-label="Close dialog" disabled={!!busy || exportRunning || updateState?.status === 'installing' || !hasActiveScene && dialog === 'library'} onClick={() => setDialog(hasActiveScene ? null : 'library')}><X size={19}/></button>
      {dialog === 'viewport' && <><span className="modal-icon"><Settings2 size={25}/></span><h2>Viewport settings.</h2><div className="viewport-zoom-setting"><div><strong>Zoom to mouse position</strong><p>Keep the point under your pointer in place when you zoom. Turn off to zoom toward the center of the view.</p></div><Switch label="Zoom to mouse position" checked={zoomToCursor} onChange={() => setZoomToCursor(value => !value)}/></div><p className="micro-copy">Saved on this device for every scene.</p></>}
      {dialog === 'shortcuts' && <><span className="modal-icon"><Keyboard size={25}/></span><div className="eyebrow">KEEP YOUR HANDS ON THE KEYS</div><h2>Keyboard shortcuts.</h2><p>Press S to switch between selecting keyframes and regular editing. Esc brings you back to regular mode.</p><dl className="keyboard-shortcuts">{SHORTCUTS.map(([keys, action]) => <div key={keys}><dt>{action}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl><p className="micro-copy">Shortcuts pause while you type in a field or use a dialog. On Mac, use Command instead of Ctrl.</p></>}
      {dialog === 'library' && <SceneLibrary characters={characters} scenes={scenes} archives={archives} activeId={hasActiveScene ? sceneId : ''} initialCharacterId={libraryCharacterId} recovering={!storageReady} onOpen={id => void openSavedScene(id)} onNew={id => void createCharacterScene(id)} onAddCharacter={() => setDialog('new')} onRenameCharacter={changeCharacterName} onRename={(id, name) => changeSavedScene(id, 'rename', name)} onDuplicate={id => void changeSavedScene(id, 'duplicate')} onExport={(id, format) => void exportSavedScene(id, format)} onDelete={id => changeSavedScene(id, 'delete')} onRecover={id => void openArchive(id)}/>}
      {dialog === 'physics' && studio.generation?.kind === 'physics' && <PhysicsComparison generation={studio.generation} onCompare={comparePhysics} onKeep={() => setDialog(null)} onRestoreOriginal={restoreBeforePhysics} onSaveReport={() => { const { comparison: _comparison, ...report } = studio.generation!; downloadFile(JSON.stringify(report, null, 2), 'physics-comparison-report.json', 'application/json'); }}/>}
      {dialog === 'updates' && <UpdatesDialog state={updateState} canInstall={hydrated && storageReady && !busy && !engine?.busy && !agentController.current && !exportOperation.current && !keyDrag.current} onInstall={() => void installDownloadedUpdate()}/>}
      {dialog === 'agent' && <><span className="modal-icon"><Keyboard size={25}/></span><div className="eyebrow">YOUR AGENT. YOUR ANIMATION.</div><h2>Make moves<br/>with a little code.</h2><p>Give an AI agent control of this scene through local scripts or MCP. It can inspect joints, edit poses, run AI and physics, save projects, and export to Unreal.</p><div className="modal-tip"><span className="status-dot"/><span><strong>{agentConnection.connected ? 'Ready for scripts' : 'Waiting for the local service'}</strong><br/>{agentConnection.connected ? 'This tab can stay in the background while your agent works.' : agentConnection.error || 'Start Still with its launcher to connect.'}</span></div>{agentConnection.sessionId && <p className="agent-session">Session: {agentConnection.sessionId}</p>}<p>Start in the project folder:</p><pre className="agent-command">node scripts/still-agent.mjs sessions{`\n`}node scripts/still-agent.mjs schema</pre><p>Give your agent <strong>docs/agent-scripting.md</strong>. For MCP, launch <strong>node scripts/still-mcp.mjs</strong> from your agent’s MCP configuration.</p><div className="agent-actions"><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(`Use Still's local agent API to work on my animation. Read docs/agent-scripting.md in the Still project. Target session ${agentConnection.sessionId || '(list sessions first)'}. Inspect the scene and schema before changing it, use expectedRevision for edits, and save a .still backup before replacing my work.`).then(() => notify('Instructions copied for your agent.')).catch(() => notify('Select the session ID and use docs/agent-scripting.md.')); }}><Copy size={15}/>Copy agent instructions</button></div><div className="agent-last">{agentActivity ? <><strong>{agentActivity.status === 'done' ? 'Completed' : agentActivity.status === 'error' ? 'Needs attention' : agentActivity.status === 'cancelled' ? 'Stopped' : 'Working'} · {agentActivity.method}</strong>{agentActivity.message && <p>{agentActivity.message}</p>}</> : 'Pose edits use Undo. Replacing a scene keeps a Recent scenes backup. Access stays on this computer.'}</div></>}
      {dialog === 'animation' && <AnimationImport key={`${sceneId}:${asset.root.uuid}:${libraryImportFile?.name ?? ''}:${libraryImportClipIndex}`} target={asset} duration={studio.duration} fps={fps} initialMode={animationImportMode} initialFile={libraryImportFile} initialClipIndex={libraryImportClipIndex} initialFitError={libraryFitError} onMappingSaved={(source, mapping) => void saveMotionMapping(source, asset, mapping).catch(() => setError('The joint map could not be saved for later use.'))} onBusy={loading => { setBusy(current => loading ? 'Reading animation file…' : current === 'Reading animation file…' ? null : current); setPlaying(false); }} onApply={applyImportedAnimation}/>}
      {dialog === 'import' && <><span className="modal-icon"><Upload size={25}/></span><div className="eyebrow">BRING YOUR CHARACTER</div><h2>Import a character.</h2><p>Save a rigged FBX or GLB as a character with its first scene. Its skeleton and skin weights stay intact. Your current work saves before switching.</p><button className="modal-dropzone" onClick={() => importInput.current?.click()}><Upload size={27}/><strong>Choose a character or saved scene</strong><span>FBX · GLB · .still scene · character files up to 150 MB</span></button><div className="modal-tip"><ShieldCheck size={19}/><span>For a Mixamo character, download <strong>FBX Binary → With Skin</strong>. Then use <strong>Import animation</strong> to apply another motion to it.</span></div><button className="button secondary full-width" disabled={!asset.rigged || !!busy || !hydrated} onClick={() => openAnimationImport()}><Activity size={16}/>Import animation onto current character</button><p className="micro-copy">No skeleton? Fit a human, quadruped or creature rig after importing. Creature chains support heads, jaws and tentacles without legs.</p><AnimationSources/></>}
      {dialog === 'export' && <><span className="modal-icon"><ArrowUpRight size={25}/></span><div className="eyebrow">TAKE YOUR MOTION WITH YOU</div><h2>Made a move?<br/>Make it useful.</h2><p>Take your character and the motion you’re previewing into your next project.</p>
        <button className={`export-choice unreal-export ${unrealCapability?.available && asset.rigged ? 'recommended' : ''}`} disabled={!asset.rigged || !unrealCapability?.available || !!busy || !!exportBlocked} onClick={() => void exportUnreal()} aria-describedby="unreal-export-note"><Box size={24}/><span><strong>Unreal Engine · FBX</strong><small>{retarget === 'skeleton' ? 'Animation only + import guide' : 'Character + animation + textures + import guide'}</small><span className="export-recommendation">{!asset.rigged ? 'A rig is needed first' : unrealCapability?.available ? 'Recommended for Unreal' : unrealCapability === null ? 'Checking local exporter…' : 'Exporter unavailable'}</span></span>{unrealCapability === null ? <LoaderCircle size={19} className="spin"/> : <Download size={19}/>}</button>
        <div className="unreal-options">
          <div className="unreal-movement"><strong id="unreal-movement-label">Movement</strong><div className="unreal-segments" role="group" aria-labelledby="unreal-movement-label">{([['extract', 'Gameplay root motion (Extract)'], ['preserve', 'Original movement'], ['in-place', 'In place']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={rootMotion === value} className={rootMotion === value ? 'active' : ''} disabled={!!busy} onClick={() => { setRootMotion(value); rememberExportPreference('root-motion', value); }}>{label}</button>)}</div><small>Extract suits attacks and moves that travel.</small></div>
          <label>Unreal character<select value={retarget} disabled={!!busy} onChange={event => { setRetarget(event.target.value as typeof retarget); rememberExportPreference('retarget', event.target.value); setTargetMesh(''); setExportOptionError(null); }}><option value="none">My original skeleton</option><option value="skeleton">My existing Unreal character (animation only)</option><option value="manny">Manny / Quinn</option><option value="metahuman">MetaHuman body</option></select></label>
          {retarget === 'skeleton' ? <><label>Skeleton asset<input maxLength={512} value={targetSkeleton} disabled={!!busy} onChange={event => { setTargetSkeleton(event.target.value); rememberExportPreference('target-skeleton', event.target.value); }} placeholder="/Game/KarateBear/SKEL_KarateBear.SKEL_KarateBear"/></label><div className="unreal-reference"><strong>Character FBX</strong><div className="unreal-file-row"><span title={referenceFbxName}>{referenceLoading ? 'Reading FBX…' : referenceFbxName || 'No character FBX selected'}</span><button type="button" className="button secondary" disabled={!!busy || referenceLoading} onClick={() => referenceInput.current?.click()}>Choose FBX</button></div><input ref={referenceInput} type="file" accept=".fbx" aria-label="Character FBX" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseReferenceFbx(file); }}/><small>Writes animation only, on that skeleton's own bone names and rest pose. Pick the same FBX you imported into Unreal.</small></div></> : <label>{retarget === 'none' ? 'Existing Unreal skeleton (optional)' : `Target skeletal mesh${retarget === 'manny' ? ' (optional)' : ''}`}<input maxLength={512} value={targetMesh} disabled={!!busy} onChange={event => { setTargetMesh(event.target.value); if (retarget === 'none' && event.target.value.trim()) { setRootMotion('preserve'); rememberExportPreference('root-motion', 'preserve'); } }} placeholder={retarget === 'none' ? '/Game/Characters/Fluffy_Skeleton.Fluffy_Skeleton' : '/Game/Characters/MyBody.MyBody'}/><small>{retarget === 'none' ? 'Paste the Skeleton or SkeletalMesh asset path to import animation onto that character. Leave blank to create a new character. The rig must match. Original movement is selected when you enter a path. Extract or In place requires the same added RootMotion bone in Unreal.' : retarget === 'manny' ? 'The import helper can find Manny in your Unreal project.' : 'Choose the body mesh asset path from your Unreal project.'}</small></label>}
          <label className="unreal-save-option"><input type="checkbox" checked={saveIntoFolder} disabled={!!busy} onChange={event => { setSaveIntoFolder(event.target.checked); rememberExportPreference('save-into-folder', String(event.target.checked)); }}/>Save into a folder</label>
          {saveIntoFolder && <label>Folder path<div className="unreal-folder-row"><input maxLength={4096} value={exportFolder} disabled={!!busy} onChange={event => { setExportFolder(event.target.value); rememberExportPreference('folder', event.target.value); setExportOptionError(null); }} placeholder="Absolute folder path"/>{window.stillDesktop && <button type="button" className="button secondary" disabled={!!busy} onClick={() => void browseExportFolder()}>Browse</button>}</div><small>Choose an existing folder. Each export gets its own subfolder.</small></label>}
          {exportOptionError && <p className="unreal-option-error" role="alert">{exportOptionError}</p>}
        </div><p id="unreal-export-note" className="export-caption">{!asset.rigged ? 'Fit a rig before Unreal export. Close this dialog and choose Add a rig.' : !unrealCapability?.available ? unrealCapability?.reason || (unrealCapability === null ? 'Checking this computer’s export tools.' : 'Start Still with its launcher to enable Unreal export.') : exportBlocked || `${saveIntoFolder ? 'Folder export' : 'ZIP package'} · ${fps} fps · ${rootMotion === 'extract' ? 'Gameplay root motion' : rootMotion === 'in-place' ? 'In place' : 'Original movement'}`}</p>
        {exportSummary && <div className={`export-result ${exportSummary.error ? 'export-error' : ''}`} role={exportSummary.error || exportSummary.saveError ? 'alert' : 'status'}><strong>{exportSummary.error ? <CircleHelp size={15}/> : <Check size={15}/>}{exportSummary.error ? 'Export could not finish' : exportSummary.cancelled ? 'Export cancelled' : exportSummary.savedTo ? `Saved to ${exportSummary.savedTo}` : 'Unreal package downloaded'}</strong><p>{exportSummary.error || (exportSummary.cancelled ? 'Your character and animation are unchanged.' : exportSummary.savedTo ? 'Open the saved folder and run import_unreal.py in Unreal. Follow the included import guide.' : exportSummary.existingSkeleton ? 'Unzip the package and run import_unreal.py to import the animation onto your selected skeleton. For manual import, skip character.fbx and select that skeleton for animation.fbx.' : 'Unzip the package and follow its import guide. Import the character first, then its animation onto the same skeleton.')}</p>{exportSummary.saveError && <p>{exportSummary.saveError}</p>}{exportSummary.warnings.length > 0 && <details open><summary>Export notes</summary>{exportSummary.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}</div>}
        {needsReview && <div className="modal-tip"><CircleHelp size={18}/><span>This motion has review flags. Check the pass details and playback before using the exported animation.</span></div>}
        <button className="export-choice" onClick={() => void exportGLB()}><Box size={24}/><span><strong>Animated character</strong><small>GLB · mesh, skeleton, and baked animation</small></span><Download size={19}/></button><button className="export-choice" onClick={saveProject}><Save size={24}/><span><strong>Editable Still scene</strong><small>.still · character, poses, and settings</small></span><Download size={19}/></button><div className="modal-tip"><ShieldCheck size={19}/><span>Use your matching Unreal skeleton, create a new character, or retarget to Manny or a MetaHuman body. Mixamo bone names are made compatible with Unreal.</span></div></>}
      {dialog === 'new' && <><span className="modal-icon"><Bone size={25}/></span><div className="eyebrow">SAVE A CHARACTER ONCE</div><h2>Add a character.</h2><p>Import a model with its rig, or choose a practice character. Each character gets its own collection of scenes.</p><button className="export-choice compact" onClick={() => setDialog('import')}><Upload size={20}/><span><strong>Import your own character</strong><small>FBX or GLB · existing rigs preserved</small></span><ArrowRight size={17}/></button><div className="new-choices"><button onClick={() => createNew('humanoid')}><PoseSketch index={3}/><strong>Practice partner</strong><span>Human · rigged and ready</span></button><button onClick={() => createNew('quadruped')}><PoseSketch quadruped/><strong>Four-legged friend</strong><span>Quadruped · rigged and ready</span></button></div><button className="text-button" onClick={() => void openLibrary()}><ArrowLeft size={14}/>Back to characters</button></>}
      {dialog === 'rig' && error && <p className="rig-fit-error" role="alert">{error}</p>}
      {dialog === 'rig' && rigDraft && rigKind !== 'creature' && <HandRigSetup preview={rigDraft.preview} fit={rigDraft.fit} initial={rigDraft.initial} theme={theme} zoomToCursor={zoomToCursor} disabled={!!busy} onChange={fit => { setError(null); setRigDraft(current => current ? { ...current, fit } : null); }} onBind={() => void makeRig(rigDraft.fit)} onBack={() => setRigDraft(null)}/>}
      {dialog === 'rig' && rigDraft && rigKind === 'creature' && <CreatureRigSetup preview={rigDraft.preview} fit={rigDraft.fit} initial={rigDraft.initial} theme={theme} disabled={!!busy} onChange={fit => { setError(null); setRigDraft(current => current ? { ...current, fit } : null); }} onBind={() => void makeRig(rigDraft.fit)} onBack={() => setRigDraft(null)}/>}
      {dialog === 'rig' && !rigDraft && <><span className="modal-icon"><Bone size={25}/></span><div className="eyebrow">A SIMPLE STARTING SKELETON</div><h2>A little structure.<br/>A lot of freedom.</h2><p>Pick the shape that fits your character. We’ll fit joints to the shape of your mesh and blend the skin around its limbs.</p><div className="new-choices rig-choices">{(['humanoid', 'quadruped', 'creature'] as RigKind[]).map(kind => <button key={kind} className={rigKind === kind ? 'selected' : ''} onClick={() => setRigKind(kind)}>{kind === 'creature' ? <Bone size={64} className="creature-rig-icon"/> : <PoseSketch quadruped={kind === 'quadruped'}/>}<strong>{kind === 'creature' ? 'Creature' : kind === 'humanoid' ? 'Two legs' : 'Four legs'}</strong><span>{kind === 'creature' ? 'Heads, tentacles · no legs required' : kind === 'humanoid' ? 'Upright human · A or T pose' : 'Animal · head facing +Z'}</span></button>)}</div>{rigKind === 'creature' && <div className="hand-rig-toolbar"><label>Shape<select aria-label="Creature shape" value={creatureRig.shape} onChange={e => setCreatureRig({ ...creatureRig, shape: e.target.value as CreatureRigOptions['shape'] })}><option value="hydra">Multiple heads / hydra</option><option value="serpent">Serpent / single neck</option><option value="tentacles">Tentacles</option></select></label><label>Chains<select aria-label="Creature chains" disabled={creatureRig.shape === 'serpent'} value={creatureRig.shape === 'serpent' ? 1 : creatureRig.chains} onChange={e => setCreatureRig({ ...creatureRig, chains: Number(e.target.value) })}>{[1,2,3,4,5,6,7,8].map(n => <option key={n}>{n}</option>)}</select></label><label>Joints per chain<select aria-label="Creature segments" value={creatureRig.segments} onChange={e => setCreatureRig({ ...creatureRig, segments: Number(e.target.value) })}>{[2,3,4,5,6,7,8,9,10].map(n => <option key={n}>{n}</option>)}</select></label></div>}<label className="rig-finger-option"><input type="checkbox" checked={rigFingers} disabled={rigKind !== 'humanoid' || !!busy} onChange={event => setRigFingers(event.target.checked)}/>Include hands &amp; five fingers per hand</label><div className="modal-tip"><CircleHelp size={19}/><span>Use an upright, neutral pose. Geometry fitting checks the skin binding; inspect a small bend before making larger poses.</span></div><button className="button primary full-width" onClick={() => void prepareRig()} disabled={asset.rigged || !!busy || !hydrated}>{rigKind === 'creature' ? 'Place creature joints' : rigKind === 'humanoid' && rigFingers ? 'Detect body & finger joints' : 'Fit my rig'} <ArrowRight size={16}/></button></>}
      {dialog === 'help' && <><span className="modal-icon"><Hand size={25}/></span><div className="eyebrow">YOU ALREADY KNOW ENOUGH</div><h2>Three steps.<br/>Your first animation.</h2><div className="tour-step"><span>01</span><div><strong>Bring a character.</strong><p>Use the practice partner or import a rigged FBX or GLB from a character library. Existing rigs are preserved.</p></div></div><div className="tour-step"><span>02</span><div><strong>Make a few moments.</strong><p>Move the playhead. Drag a joint into place. Your pose is saved automatically. Use Select to drag across several keyframes, then Delete selected. One Undo restores the group. Drag a diamond to change its timing. Turn on Ripple or hold Shift while dragging to move it and every later pose together, shortening or extending the clip.</p></div></div><div className="tour-step"><span>03</span><div><strong>Let them flow.</strong><p>{!learnedProvider ? 'Use imported clips or curve interpolation between your poses. Preview with Space, then export an animated GLB.' : 'Choose Generate motion to fill the gaps with AI. Preview with Space, correct with physics, then export an animated GLB.'}</p></div></div><div className="shortcut-grid"><span><kbd>Space</kbd>Play / pause</span><span><kbd>K</kbd>Save a pose</span><span><kbd>Ctrl D</kbd>Duplicate moment</span><span><kbd>Ctrl C / V</kbd>Copy / paste keyframes</span><span><kbd>Shift drag</kbd>Ripple timing</span><span><kbd>Alt Shift ← →</kbd>Ripple one frame</span><span><kbd>W / E</kbd>Move / rotate</span><span><kbd>← →</kbd>One frame</span><span><kbd>Ctrl Z</kbd>Undo</span><span><kbd>Ctrl S</kbd>Save to library</span></div><p className="help-honesty">AI in-betweening runs trained human or animal motion models on this computer. The owned models have limited training coverage; inspect difficult contacts and acrobatics. Physics offers articulated-body correction with MuJoCo. Curve interpolation and the quick ground pass are lightweight procedural tools. Generated motion stays separate from your editable key poses.</p><button className="button primary full-width" onClick={() => setDialog(null)}>Let’s make something move <ArrowRight size={16}/></button></>}
      {busy && <div className="modal-busy" role="status"><LoaderCircle size={25} className="spin"/><strong>{busy}</strong>{exportRunning && <><progress className="engine-progress" aria-label="Unreal export progress" max="1" value={progress ?? 0}/><button className="button secondary" disabled={exportCancelling} onClick={cancelUnrealExport}>{exportCancelling ? 'Cancelling…' : 'Cancel export'}</button><p className="micro-copy">Preparing the package locally. Your animation stays unchanged.</p></>}</div>}
    </div></dialog>
  </div>;
}
