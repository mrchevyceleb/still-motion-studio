import type { PoseKey } from '../types';

export const MAX_ANIMATION_DURATION = 600;

/** Place a pose on the requested frame, replacing a pose already on that frame. */
export function moveMoment(keys: PoseKey[], id: string, wanted: number, duration: number, fps: number): { keys: PoseKey[]; duration: number; time: number; replaced: number } | null {
  const source = keys.find(key => key.id === id);
  if (!source || !Number.isFinite(wanted)) return null;
  const time = Math.max(0, Math.min(duration, Math.round(wanted * fps) / fps));
  const remaining = keys.filter(key => key.id === id || Math.abs(key.time - time) >= .5 / fps);
  if (remaining.length < 2) return null;
  return { keys: remaining.map(key => key.id === id ? { ...key, time } : key).sort((a, b) => a.time - b.time), duration, time, replaced: keys.length - remaining.length };
}

export function pasteMoments(keys: PoseKey[], copied: PoseKey[], wanted: number, duration: number, fps: number): { keys: PoseKey[]; pasted: PoseKey[]; duration: number; replaced: number } {
  if (!copied.length || !Number.isFinite(wanted) || wanted < 0) throw new Error('Choose a time on the timeline to paste.');
  const start = Math.round(wanted * fps) / fps;
  const first = copied.reduce((time, key) => Math.min(time, key.time), Infinity);
  const byFrame = new Map<number, PoseKey>();
  // A slower destination frame rate can collapse adjacent source keys. Keep the later pose.
  for (const key of [...copied].sort((a, b) => a.time - b.time)) {
    const frame = Math.round((start + key.time - first) * fps);
    byFrame.set(frame, { ...structuredClone(key), id: crypto.randomUUID(), time: frame / fps });
  }
  const pasted = [...byFrame.values()];
  const end = pasted.at(-1)!.time;
  if (end > MAX_ANIMATION_DURATION) throw new Error('The pasted keyframes would exceed the 10-minute limit.');
  const frames = new Set(pasted.map(key => Math.round(key.time * fps)));
  const remaining = keys.filter(key => !frames.has(Math.round(key.time * fps)));
  const result = [...remaining, ...pasted].sort((a, b) => a.time - b.time);
  if (result.length < 2) throw new Error('Keep at least two poses. Paste at another time.');
  return { keys: result, pasted, duration: Math.max(duration, end), replaced: keys.length - remaining.length };
}

/** Move this moment and the entire tail by one shared, frame-snapped offset. */
export function rippleMoment(keys: PoseKey[], id: string, wanted: number, duration: number, fps: number): { keys: PoseKey[]; duration: number; time: number } | null {
  const index = keys.findIndex(key => key.id === id);
  if (index < 0 || !Number.isFinite(wanted)) return null;
  const source = keys[index];
  const previous = keys[index - 1];
  // Preserve sub-frame spacing in imported clips, and never cross the preceding pose.
  const earliest = previous ? previous.time + Math.min(1 / fps, source.time - previous.time) : 0;
  const lower = Math.ceil(Math.max(earliest - source.time, Math.min(.1, duration) - duration) * fps - 1e-7);
  const upper = Math.floor((MAX_ANIMATION_DURATION - duration) * fps + 1e-7);
  const delta = Math.max(lower, Math.min(upper, Math.round((wanted - source.time) * fps))) / fps;
  return {
    keys: keys.map((key, i) => i < index ? key : { ...key, time: key.time + delta }),
    duration: duration + delta,
    time: source.time + delta,
  };
}

/** Pick the nearest unoccupied frame, including a fractional end frame. */
export function nearestFreeKeyTime(keys: PoseKey[], ignoreId: string | null, wanted: number, duration: number, fps: number, direction = 0): number | null {
  const last = Math.ceil(duration * fps);
  const center = Math.max(0, Math.min(last, Math.round(wanted * fps)));
  const occupied = new Set<number>();
  for (const key of keys) {
    if (key.id === ignoreId) continue;
    occupied.add(Math.round(key.time * fps));
    if (Math.abs(key.time - duration) < .5 / fps) occupied.add(last);
  }
  for (let distance = 0; distance <= last; distance++) {
    const candidates = !distance ? [center] : direction > 0 ? [center + distance] : direction < 0 ? [center - distance] : [center + distance, center - distance];
    for (const frame of candidates) {
      if (frame >= 0 && frame <= last && !occupied.has(frame)) return Math.min(duration, frame / fps);
    }
  }
  return null;
}

export function duplicateMoment(keys: PoseKey[], source: PoseKey, duration: number, fps: number): { keys: PoseKey[]; duration: number; key: PoseKey } | null {
  const next = keys.find(key => key.time > source.time);
  const wanted = next ? (source.time + next.time) / 2 : source.time + .5;
  const nextDuration = Math.min(MAX_ANIMATION_DURATION, Math.max(duration, wanted));
  const time = nearestFreeKeyTime(keys, null, wanted, nextDuration, fps, next ? 0 : 1);
  if (time === null || (!next && time <= source.time)) return null;
  const key: PoseKey = { ...structuredClone(source), id: crypto.randomUUID(), time, label: `${(source.label || 'Pose').slice(0, 100)} copy` };
  return { keys: [...keys, key].sort((a, b) => a.time - b.time), duration: nextDuration, key };
}
