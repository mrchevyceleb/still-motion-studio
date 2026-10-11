import type { PoseKey } from '../types';

export const MAX_ANIMATION_DURATION = 600;

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
  const key: PoseKey = { id: crypto.randomUUID(), time, pose: structuredClone(source.pose), label: `${(source.label || 'Pose').slice(0, 100)} copy` };
  return { keys: [...keys, key].sort((a, b) => a.time - b.time), duration: nextDuration, key };
}
