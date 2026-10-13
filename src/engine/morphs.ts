import * as THREE from 'three';
import type { CharacterAsset, InterpolationMode, MorphValues, PoseKey } from '../types';

export function morphMeshes(asset: CharacterAsset): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  asset.root.traverse(object => {
    if (object instanceof THREE.Mesh && object.morphTargetDictionary && object.morphTargetInfluences?.length) meshes.push(object);
  });
  return meshes;
}

// A named shape can span several primitives (face, eyes, lashes). Drive them together.
export function captureMorphs(asset: CharacterAsset): MorphValues {
  return Object.fromEntries(morphMeshes(asset).flatMap(mesh => Object.entries(mesh.morphTargetDictionary!).map(([name, index]) => [name, mesh.morphTargetInfluences![index]])));
}

export function saveMorphNames(asset: CharacterAsset): void {
  // Object3D.toJSON omits the dictionary and BufferAttribute names. Keep the
  // name-to-slot mapping in userData so ObjectLoader can restore FBX shapes too.
  for (const mesh of morphMeshes(asset)) mesh.userData.stillMorphTargets = { ...mesh.morphTargetDictionary };
}

export function restoreMorphNames(root: THREE.Object3D): void {
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !object.morphTargetInfluences?.length) return;
    const targetNames = object.userData.targetNames;
    const saved = object.userData.stillMorphTargets ?? (Array.isArray(targetNames) ? Object.fromEntries(targetNames.map((name, index) => [name, index])) : undefined);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      const entries = Object.entries(saved);
      if (entries.length === object.morphTargetInfluences.length && entries.every(([name, index]) => name && Number.isInteger(index) && Number(index) >= 0 && Number(index) < entries.length) && new Set(entries.map(([, index]) => index)).size === entries.length) {
        object.morphTargetDictionary = { ...saved };
      }
    }
  });
}

export function applyMorphs(asset: CharacterAsset, values: MorphValues): void {
  for (const mesh of morphMeshes(asset)) {
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary!)) {
      mesh.morphTargetInfluences![index] = values[name] ?? asset.restMorphs?.[name] ?? 0;
    }
  }
}

/** Use the same shape-preserving cubic as pose position/scale channels. */
export function createMorphSampler(keys: PoseKey[], mode: InterpolationMode, defaults: MorphValues = {}): (time: number) => MorphValues {
  const sorted = keys.slice().sort((a, b) => a.time - b.time);
  const names = [...new Set([...Object.keys(defaults), ...sorted.flatMap(key => Object.keys(key.morphs ?? {}))])];
  const value = (key: PoseKey, name: string) => key.morphs?.[name] ?? defaults[name] ?? 0;
  const tangent = (a: number, b: number, c: number, dt0: number, dt1: number) => {
    if (dt0 <= 0 || dt1 <= 0) return 0;
    const before = (b - a) / dt0, after = (c - b) / dt1;
    if (before * after <= 0) return 0;
    const w0 = 2 * dt1 + dt0, w1 = dt1 + 2 * dt0;
    return (w0 + w1) / (w0 / before + w1 / after);
  };
  return time => {
    if (!sorted.length) return { ...defaults };
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sorted[mid].time <= time) lo = mid; else hi = mid - 1;
    }
    const a = sorted[lo], b = sorted[lo + 1];
    if (time <= a.time || !b || mode === 'stepped') return Object.fromEntries(names.map(name => [name, value(a, name)]));
    const dt = b.time - a.time, u = Math.min(1, (time - a.time) / dt), u2 = u * u, u3 = u2 * u;
    const previous = sorted[lo - 1] ?? a, next = sorted[lo + 2] ?? b;
    return Object.fromEntries(names.map(name => {
      const start = value(a, name), end = value(b, name);
      if (mode !== 'smooth') return [name, THREE.MathUtils.lerp(start, end, u)];
      const m0 = tangent(value(previous, name), start, end, a.time - previous.time, dt);
      const m1 = tangent(start, end, value(next, name), dt, next.time - b.time);
      return [name, (2 * u3 - 3 * u2 + 1) * start + (u3 - 2 * u2 + u) * dt * m0 + (-2 * u3 + 3 * u2) * end + (u3 - u2) * dt * m1];
    }));
  };
}

export function morphKeyData(keys: PoseKey[], time: number, mode: InterpolationMode, defaults?: MorphValues): Pick<PoseKey, 'morphs'> {
  return createMorphKeySampler(keys, mode, defaults)(time);
}

export function createMorphKeySampler(keys: PoseKey[], mode: InterpolationMode, defaults?: MorphValues): (time: number) => Pick<PoseKey, 'morphs'> {
  if (!keys.some(key => key.morphs && Object.keys(key.morphs).length)) return () => ({});
  const sample = createMorphSampler(keys, mode, defaults);
  return time => ({ morphs: sample(time) });
}

export function isMorphTrack(asset: CharacterAsset, track: THREE.KeyframeTrack): boolean {
  const parsed = THREE.PropertyBinding.parseTrackName(track.name);
  if (parsed.objectName || parsed.propertyName !== 'morphTargetInfluences') return false;
  const mesh = THREE.PropertyBinding.findNode(asset.root, parsed.nodeName);
  if (!(mesh instanceof THREE.Mesh) || !mesh.morphTargetInfluences?.length) return false;
  if (parsed.propertyIndex === undefined) return track.getValueSize() === mesh.morphTargetInfluences.length;
  const index = mesh.morphTargetDictionary?.[parsed.propertyIndex] ?? Number(parsed.propertyIndex);
  return Number.isInteger(index) && index >= 0 && index < mesh.morphTargetInfluences.length && track.getValueSize() === 1;
}

export function morphAnimationTracks(asset: CharacterAsset, keys: PoseKey[], times: number[], mode: InterpolationMode): THREE.KeyframeTrack[] {
  const keyed = new Set(keys.flatMap(key => Object.keys(key.morphs ?? {})));
  if (!keyed.size) return [];
  const sample = createMorphSampler(keys, mode, asset.restMorphs);
  const frames = times.map(sample);
  return morphMeshes(asset).filter(mesh => Object.keys(mesh.morphTargetDictionary!).some(name => keyed.has(name))).map(mesh => {
    const names = Object.entries(mesh.morphTargetDictionary!);
    const values = frames.flatMap(frame => mesh.morphTargetInfluences!.map((_, index) => {
      const name = names.find(([, slot]) => slot === index)?.[0];
      return name === undefined ? 0 : frame[name] ?? 0;
    }));
    return new THREE.NumberKeyframeTrack(`${mesh.uuid}.morphTargetInfluences`, times, values, mode === 'stepped' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear);
  });
}
