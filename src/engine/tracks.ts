import { createPoseSampler } from './motion';
import { createMorphSampler } from './morphs';
import { editMotion, rangeSpeedTime, type ClipEdit } from './clipEditing';
import type { AnimationTrack, BonePose, CharacterAsset, InterpolationMode, MorphValues, Pose, PoseKey, TrackState } from '../types';

export interface LayeredMotion extends TrackState {
  keys: PoseKey[]; generated?: PoseKey[]; duration: number;
  settings: { interpolation: InterpolationMode };
}
const copy = <T,>(value: T): T => structuredClone(value);
export const trackFields = (state: TrackState): TrackState => ({ tracks: state.tracks, activeTrackId: state.activeTrackId, baseTrackName: state.baseTrackName, baseTrackMuted: state.baseTrackMuted, baseMotionName: state.baseMotionName });
export const activeTrack = (state: TrackState) => state.tracks?.find(track => track.id === state.activeTrackId);
export const editableKeys = (state: LayeredMotion) => activeTrack(state)?.keys ?? state.keys;

/** Retiming one row cannot cut off the untouched rows. */
export function trackEditDuration(state: LayeredMotion, requested: number): number {
  const track = activeTrack(state);
  const untouched = [...(track ? [state.generated ?? state.keys] : []), ...(state.tracks ?? []).filter(t => t.id !== track?.id && (t.channels.length || t.morphs.length)).map(t => t.keys)];
  return untouched.reduce((end, keys) => keys.reduce((latest, key) => Math.max(latest, key.time), end), requested);
}

/** Empty placeholders can follow a shorter scene; authored muted motion must survive unmute. */
export function fitEmptyTracks<T extends LayeredMotion>(state: T): T {
  if (!state.tracks?.some(t => !t.channels.length && !t.morphs.length && t.keys.some(k => k.time > state.duration))) return state;
  return { ...state, tracks: state.tracks.map(t => {
    const end = Math.max(...t.keys.map(k => k.time));
    return !t.channels.length && !t.morphs.length && end > state.duration
      ? { ...t, keys: t.keys.map(k => ({ ...k, time: k.time * state.duration / end })) } : t;
  }) };
}

/** Keep a layer's active interval when whole-scene tools bake their output. */
export function editAnimationTrack(asset: CharacterAsset, track: AnimationTrack, duration: number, edit: ClipEdit, fps: number): AnimationTrack | undefined {
  const start = Math.min(...track.keys.map(k => k.time)), end = Math.max(...track.keys.map(k => k.time));
  if (edit.kind === 'repeat' && (start > 0 || end < duration) && (track.channels.length || track.morphs.length)) {
    throw new Error('To repeat this scene, each animated track must span the full timeline. Extend the shorter tracks first.');
  }
  const result = editMotion(asset, { keys: track.keys, duration, interpolation: track.interpolation }, edit, fps);
  const from = edit.kind === 'trim' ? Math.max(0, start - edit.start) : edit.kind === 'reverse' ? duration - end : edit.kind === 'speed' ? start / edit.factor : edit.kind === 'speed-range' ? rangeSpeedTime(edit, start) : start;
  const to = edit.kind === 'trim' ? Math.min(result.duration, end - edit.start) : edit.kind === 'reverse' ? duration - start : edit.kind === 'speed' ? end / edit.factor : edit.kind === 'speed-range' ? rangeSpeedTime(edit, end) : edit.kind === 'repeat' ? result.duration : end;
  if (to <= from) return undefined;
  return { ...track, keys: result.keys.filter(k => k.time >= from && k.time <= to), interpolation: result.interpolation };
}

export function coveringTrackNames(state: LayeredMotion, time: number): string[] {
  const selected = activeTrack(state), tracks = state.tracks ?? [];
  const channels = new Set(selected?.channels.map(c => `${c.bone}:${c.property}`));
  return tracks.slice(selected ? tracks.indexOf(selected) + 1 : 0).filter(track => !track.muted && track.keys.length &&
    time >= track.keys[0].time && time <= track.keys[track.keys.length - 1].time &&
    (track.channels.some(c => !selected || channels.has(`${c.bone}:${c.property}`)) || track.morphs.some(name => !selected || selected.morphs.includes(name)))
  ).map(track => track.name);
}

/** Local transforms keep eyelids attached to animated heads. Only edited properties override. */
export function createLayerSampler(state: LayeredMotion, rest: Pose, defaults: MorphValues = {}) {
  const mode = state.generated ? 'linear' : state.settings.interpolation;
  const basePose = createPoseSampler(state.generated ?? state.keys, mode);
  const baseMorphs = createMorphSampler(state.generated ?? state.keys, mode, defaults);
  const layers = (state.tracks ?? []).filter(t => !t.muted && t.keys.length && (t.channels.length || t.morphs.length)).map(track => ({
    track, pose: createPoseSampler(track.keys, track.interpolation), morphs: createMorphSampler(track.keys, track.interpolation, defaults),
    start: Math.min(...track.keys.map(k => k.time)), end: Math.max(...track.keys.map(k => k.time)),
  }));
  return (time: number): { pose: Pose; morphs: MorphValues } => {
    const pose = state.baseTrackMuted ? copy(rest) : basePose(time);
    const morphs = state.baseTrackMuted ? { ...defaults } : baseMorphs(time);
    for (const { track, pose: samplePose, morphs: sampleMorphs, start, end } of layers) {
      if (time < start || time > end) continue;
      const overlay = samplePose(time);
      for (const { bone, property } of track.channels) {
        // Properties are copied individually so rotating a joint never captures its translation.
        Object.assign(pose[bone], { [property]: [...overlay[bone][property]] });
      }
      const shapes = sampleMorphs(time);
      for (const name of track.morphs) morphs[name] = shapes[name] ?? defaults[name] ?? 0;
    }
    return { pose, morphs };
  };
}

export function createAnimationTrack(name: string, state: LayeredMotion, rest: Pose, defaults: MorphValues = {}): AnimationTrack {
  const sample = createLayerSampler(state, rest, defaults);
  return { id: crypto.randomUUID(), name, muted: false, interpolation: 'smooth', channels: [], morphs: [],
    keys: [0, state.duration].map(time => ({ id: crypto.randomUUID(), time, ...sample(time), label: 'Starting pose' })) };
}

export function underlyingTrackSampler(state: LayeredMotion, id: string, rest: Pose, defaults: MorphValues = {}) {
  return createLayerSampler({ ...state, tracks: state.tracks?.slice(0, state.tracks.findIndex(t => t.id === id)) }, rest, defaults);
}

function different(a: number[], b: number[], property: keyof BonePose) {
  // q and -q describe the same rotation.
  const sign = property === 'quaternion' && a.reduce((sum, v, i) => sum + v * b[i], 0) < 0 ? -1 : 1;
  return a.some((v, i) => Math.abs(v - b[i] * sign) > 1e-6);
}

/** Compare with the visible pose, never with rest: idle motion is not an edit. */
export function recordTrackKey(track: AnimationTrack, key: PoseKey, before: { pose: Pose; morphs: MorphValues }, underlying?: ReturnType<typeof createLayerSampler>): AnimationTrack {
  const channels = [...track.channels];
  const storedPose = track.keys.length ? createPoseSampler(track.keys, track.interpolation)(key.time) : copy(key.pose);
  const storedMorphs = createMorphSampler(track.keys, track.interpolation)(key.time);
  key.pose.forEach((bone, index) => {
    for (const property of ['position', 'quaternion', 'scale'] as const) {
      if (different(bone[property], before.pose[index][property], property)) {
        Object.assign(storedPose[index], { [property]: [...bone[property]] });
        if (!channels.some(c => c.bone === index && c.property === property)) channels.push({ bone: index, property });
      }
    }
  });
  const changedMorphs = Object.keys(key.morphs ?? {}).filter(name => Math.abs((key.morphs![name] ?? 0) - (before.morphs[name] ?? 0)) > 1e-6);
  for (const name of changedMorphs) storedMorphs[name] = key.morphs![name];
  const morphs = [...new Set([...track.morphs, ...changedMorphs])];
  const newChannels = channels.filter(c => !track.channels.some(old => old.bone === c.bone && old.property === c.property));
  const newMorphs = morphs.filter(name => !track.morphs.includes(name));
  const keys = underlying && (newChannels.length || newMorphs.length) ? track.keys.map(k => {
    const baseline = underlying(k.time), next = copy(k);
    for (const { bone, property } of newChannels) Object.assign(next.pose[bone], { [property]: [...baseline.pose[bone][property]] });
    for (const name of newMorphs) (next.morphs ??= {})[name] = baseline.morphs[name] ?? 0;
    return next;
  }) : track.keys;
  const stored = { ...copy(key), pose: storedPose, morphs: storedMorphs };
  return { ...track, channels, morphs, keys: [...keys.filter(k => k.id !== key.id && Math.abs(k.time - key.time) > 1e-7), stored].sort((a, b) => a.time - b.time) };
}

export function putLayerKey<T extends LayeredMotion>(state: T, key: PoseKey, before: { pose: Pose; morphs: MorphValues }, rest: Pose, defaults: MorphValues = {}): T {
  const track = activeTrack(state);
  if (track) {
    if (track.muted) throw new Error('Unmute this track to animate on it.');
    const underlying = underlyingTrackSampler(state, track.id, rest, defaults);
    return { ...state, tracks: state.tracks!.map(t => t.id === track.id ? recordTrackKey(t, key, before, underlying) : t) };
  }
  if (state.baseTrackMuted) throw new Error('Unmute this track to animate on it.');
  // Treat the base as a fully owned track so untouched properties retain base motion.
  const base = recordTrackKey({ id: 'base', name: '', keys: state.generated ?? state.keys, muted: false, interpolation: state.generated ? 'linear' : state.settings.interpolation, channels: [], morphs: [] }, key, before);
  const stored = base.keys.find(k => k.id === key.id)!;
  return { ...state, keys: [...state.keys.filter(k => k.id !== key.id && Math.abs(k.time - key.time) > 1e-7), stored].sort((a, b) => a.time - b.time) };
}

/** Bake once for consumers/exporters that accept a single animation; editable tracks stay intact. */
export function combinedKeys(state: LayeredMotion, rest: Pose, defaults: MorphValues = {}, fps = 30): PoseKey[] {
  if (!state.baseTrackMuted && !state.tracks?.some(t => !t.muted && t.keys.length && (t.channels.length || t.morphs.length))) return state.generated ?? state.keys;
  const sample = createLayerSampler(state, rest, defaults);
  const times = new Map<number, number>();
  const put = (t: number) => { if (t >= 0 && t <= state.duration) times.set(Math.fround(t), t); };
  for (let frame = 0; frame < Math.ceil(state.duration * fps); frame++) put(frame / fps);
  put(0); put(state.duration);
  const sequences = [{ keys: state.generated ?? state.keys, interpolation: state.generated ? 'linear' : state.settings.interpolation }, ...(state.tracks ?? []).filter(t => !t.muted)];
  for (const sequence of sequences) for (const key of sequence.keys) {
    put(key.time);
    // Preserve held keys and layer entrances/exits when baked as linear motion.
    if (sequence.interpolation === 'stepped' || 'channels' in sequence) {
      put(adjacentTime(key.time, -1));
      if ('channels' in sequence) put(adjacentTime(key.time, 1));
    }
  }
  return [...times.values()].sort((a, b) => a - b).map((time, i) => ({ id: `combined-${i}`, time, ...sample(time) }));
}

function adjacentTime(time: number, direction: -1 | 1) {
  const view = new DataView(new ArrayBuffer(4));
  const margin = time + direction * 1e-7;
  view.setFloat32(0, margin);
  if (direction < 0 && view.getFloat32(0) < margin || direction > 0 && view.getFloat32(0) > margin) return view.getFloat32(0);
  view.setUint32(0, view.getUint32(0) + direction);
  return view.getFloat32(0);
}

export function combinedInterpolation(state: LayeredMotion): InterpolationMode {
  return state.generated || state.baseTrackMuted || state.tracks?.some(t => !t.muted && (t.channels.length || t.morphs.length) && t.keys.length) ? 'linear' : state.settings.interpolation;
}
