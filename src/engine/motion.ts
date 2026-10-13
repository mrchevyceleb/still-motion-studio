import * as THREE from 'three';
import type { CharacterAsset, InterpolationMode, MorphValues, MotionSettings, Pose, PoseKey, Quat, Vec3 } from '../types';
import { applyPose, capturePose } from './character';
import { MAX_ANIMATION_DURATION } from './keyframeEditing';
import { isFingerBone } from './handRig';
import { applyMorphs, captureMorphs, createMorphKeySampler, createMorphSampler, isMorphTrack, morphAnimationTracks } from './morphs';

const copyPose = (pose: Pose): Pose => pose.map(b => ({ position: [...b.position], quaternion: [...b.quaternion], scale: [...b.scale] }));
const makeKey = (time: number, pose: Pose, label?: string): PoseKey => ({ id: crypto.randomUUID(), time, pose, label });
const ordered = (keys: PoseKey[]) => keys.filter(k => Number.isFinite(k.time)).slice().sort((a, b) => a.time - b.time);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const quaternion = (q: Quat) => new THREE.Quaternion().fromArray(q).normalize();

// Three.js/glTF store animation times as Float32. Keep only one sample per
// representable instant, favoring exact authored times and exact endpoints.
function bakeTimes(start: number, end: number, authored: number[] = []): number[] {
  const times = new Map<number, number>();
  const insert = (time: number) => times.set(Math.fround(time), time);
  for (let frame = 0; frame < Math.ceil((end - start) * 30); frame++) insert(start + frame / 30);
  for (const time of authored) if (time >= start && time <= end) insert(time);
  insert(start);
  insert(end);
  return [...times.values()].sort((a, b) => a - b);
}

function bracket(keys: PoseKey[], time: number): number {
  let lo = 0, hi = keys.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (keys[mid].time <= time) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Shape-preserving cubic tangents avoid position/scale overshoot around extrema.
function tangent(previous: number, current: number, next: number, dt0: number, dt1: number): number {
  if (dt0 <= 0 || dt1 <= 0) return 0;
  const a = (current - previous) / dt0, b = (next - current) / dt1;
  if (a * b <= 0) return 0;
  const w0 = 2 * dt1 + dt0, w1 = dt1 + 2 * dt0;
  return (w0 + w1) / (w0 / a + w1 / b);
}

function cubic(a: number, b: number, before: number, after: number, dt: number, dt0: number, dt1: number, u: number): number {
  const m0 = tangent(before, a, b, dt0, dt), m1 = tangent(a, b, after, dt, dt1);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * dt * m0 + (-2 * u3 + 3 * u2) * b + (u3 - u2) * dt * m1;
}

/** Samples copied local bone transforms; authored keys are returned exactly. */
export function samplePose(keys: PoseKey[], time: number, mode: InterpolationMode): Pose {
  return createPoseSampler(keys, mode)(time);
}

/** Sort once for baking a clip; every returned pose is still independent. */
export function createPoseSampler(keys: PoseKey[], mode: InterpolationMode): (time: number) => Pose {
  const sorted = ordered(keys);
  return (time: number): Pose => {
  if (!sorted.length) return [];
  if (time <= sorted[0].time) return copyPose(sorted[0].pose);
  const index = bracket(sorted, time), a = sorted[index], b = sorted[index + 1];
  if (!b || Math.abs(time - a.time) < 1e-9 || mode === 'stepped') return copyPose(a.pose);
  const duration = b.time - a.time;
  if (duration <= 0) return copyPose(b.pose);
  const u = clamp01((time - a.time) / duration), ease = mode === 'smooth' ? u * u * (3 - 2 * u) : u;
  const previous = sorted[index - 1] ?? a, next = sorted[index + 2] ?? b;
  return a.pose.map((bone, boneIndex) => {
    const end = b.pose[boneIndex] ?? bone, prev = previous.pose[boneIndex] ?? bone, after = next.pose[boneIndex] ?? end;
    const interpolate = (field: 'position' | 'scale'): Vec3 => bone[field].map((start, axis) => mode === 'smooth'
      ? cubic(start, end[field][axis], prev[field][axis], after[field][axis], duration, a.time - previous.time, next.time - b.time, u)
      : THREE.MathUtils.lerp(start, end[field][axis], u)) as Vec3;
    return { position: interpolate('position'), quaternion: quaternion(bone.quaternion).slerp(quaternion(end.quaternion), ease).toArray() as Quat, scale: interpolate('scale') };
  });
  };
}

export function createDemoKeys(asset: CharacterAsset): PoseKey[] {
  const names = asset.bones.map(b => b.name.replace(/^.*[:|]/, '').toLowerCase());
  const poses = asset.kind === 'quadruped'
    ? [
        { neck: -.10, head: .08, tail: -.18, front: .03 },
        { neck: -.23, head: -.10, tail: .28, front: -.32 },
        { neck: .12, head: .22, tail: -.30, front: -.06 },
        { neck: -.30, head: -.08, tail: .33, front: -.40 },
        { neck: -.08, head: .16, tail: -.22, front: -.10 },
        { neck: -.10, head: .08, tail: -.18, front: .03 },
      ]
    : [
        { spine: -.05, leftArm: -.12, rightArm: 1.28, rightFore: .64, rightHand: -.10, head: -.12 },
        { spine: .05, leftArm: -.16, rightArm: 1.70, rightFore: .95, rightHand: .30, head: .10 },
        { spine: -.07, leftArm: -.10, rightArm: 1.39, rightFore: .55, rightHand: -.30, head: -.12 },
        { spine: .07, leftArm: -.26, rightArm: 1.82, rightFore: .96, rightHand: .30, head: .12 },
        { spine: -.04, leftArm: -.16, rightArm: 1.47, rightFore: .60, rightHand: -.22, head: -.08 },
        { spine: -.05, leftArm: -.12, rightArm: 1.28, rightFore: .64, rightHand: -.10, head: -.12 },
      ];
  const labels = asset.kind === 'quadruped' ? ['Listen', 'Step', 'Look up', 'Reach', 'Settle', 'Listen'] : ['Hello', 'Wave out', 'Wave in', 'Reach high', 'Ease down', 'Hello'];
  return poses.map((angles, i) => {
    const pose = copyPose(asset.restPose);
    const rotate = (name: string, x = 0, y = 0, z = 0) => {
      const index = names.indexOf(name.toLowerCase());
      if (index < 0) return;
      pose[index].quaternion = quaternion(pose[index].quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z))).toArray() as Quat;
    };
    if ('rightArm' in angles) {
      rotate('Spine', 0, angles.spine, angles.spine / 2);
      rotate('LeftArm', 0, 0, angles.leftArm);
      rotate('LeftForeArm', -.16, 0, -.1);
      rotate('RightArm', -.10, -.15, -angles.rightArm);
      rotate('RightForeArm', 0, 0, -angles.rightFore);
      rotate('RightHand', 0, 0, angles.rightHand);
      rotate('Head', 0, angles.head, .03);
    } else {
      rotate('Neck', angles.neck, 0, 0);
      rotate('Head', angles.head, 0, 0);
      rotate('Tail', 0, angles.tail, 0);
      rotate('FrontRightUpperLeg', angles.front, 0, 0);
      rotate('FrontRightLowerLeg', Math.max(0, -angles.front) * .75, 0, 0);
    }
    return makeKey(i * .8, pose, labels[i]);
  });
}

function trackBone(asset: CharacterAsset, name: string): THREE.Bone | null {
  const parsed = THREE.PropertyBinding.parseTrackName(name);
  if (!['position', 'quaternion', 'scale'].includes(parsed.propertyName) || parsed.propertyIndex !== undefined) return null;
  let node = THREE.PropertyBinding.findNode(asset.root, parsed.nodeName);
  if (parsed.objectName === 'bones') {
    const skeleton = (node as THREE.SkinnedMesh | undefined)?.skeleton;
    node = skeleton?.bones.find(b => b.name === String(parsed.objectIndex)) ?? skeleton?.bones[Number(parsed.objectIndex)] ?? null;
  } else if (parsed.objectName) return null;
  return node instanceof THREE.Bone && asset.bones.includes(node) ? node : null;
}

// Mixamo FBX clips include a fixed Armature rotation alongside the bone tracks.
// Only omit transform channels that already match the scene at every key;
// animated parents and other channels still need explicit support to avoid loss.
function isRestTransform(asset: CharacterAsset, track: THREE.KeyframeTrack): boolean {
  const parsed = THREE.PropertyBinding.parseTrackName(track.name);
  if (parsed.objectName || parsed.propertyIndex !== undefined || !['position', 'quaternion', 'scale'].includes(parsed.propertyName)) return false;
  const node = THREE.PropertyBinding.findNode(asset.root, parsed.nodeName);
  if (!(node instanceof THREE.Object3D)) return false;
  const rest = node[parsed.propertyName as 'position' | 'quaternion' | 'scale'].toArray();
  const size = rest.length;
  if (!track.times.length || track.getValueSize() !== size) return false;
  for (let offset = 0; offset < track.values.length; offset += size) {
    // q and -q describe the same rotation.
    const sign = size === 4 && rest.reduce((dot, value, axis) => dot + value * track.values[offset + axis], 0) < 0 ? -1 : 1;
    if (rest.some((value, axis) => !Number.isFinite(track.values[offset + axis]) || Math.abs(track.values[offset + axis] - Math.fround(sign * value)) > 1e-6)) return false;
  }
  return true;
}

/** Imported animation is sampled, never retargeted or put through IK. */
export function sampleClip(asset: CharacterAsset, clip: THREE.AnimationClip): PoseKey[] {
  if (!Number.isFinite(clip.duration) || clip.duration < 0) throw new Error('This animation has an invalid duration.');
  if (clip.duration > MAX_ANIMATION_DURATION) throw new Error('This animation exceeds the 10-minute limit. Trim the source clip before importing.');
  const boneTracks: THREE.KeyframeTrack[] = [], unsupported: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    try {
      if (trackBone(asset, track.name) || isMorphTrack(asset, track)) boneTracks.push(track);
      else if (!isRestTransform(asset, track)) unsupported.push(track);
    } catch { unsupported.push(track); }
  }
  if (unsupported.length) throw new Error(`This clip animates non-bone or unsupported channels (${unsupported.slice(0, 3).map(t => t.name).join(', ')}). Only bone transforms and morph weights can be preserved in this pose editor.`);
  const mixer = new THREE.AnimationMixer(asset.root);
  const savedMorphs = captureMorphs(asset);
  applyPose(asset, asset.restPose);
  applyMorphs(asset, asset.restMorphs ?? {});
  const action = mixer.clipAction(new THREE.AnimationClip(clip.name, clip.duration, boneTracks, clip.blendMode));
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  try {
    const samples: PoseKey[] = [];
    for (const time of bakeTimes(0, clip.duration)) {
      // Reset the action because evaluating the exact endpoint pauses LoopOnce.
      action.paused = false;
      mixer.setTime(time);
      asset.root.updateMatrixWorld(true);
      const morphs = captureMorphs(asset);
      samples.push({ ...makeKey(time, capturePose(asset)), ...(Object.keys(morphs).length ? { morphs } : {}) });
    }
    return samples;
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(asset.root);
    applyPose(asset, asset.restPose);
    applyMorphs(asset, savedMorphs);
  }
}

export function buildAnimationClip(asset: CharacterAsset, keys: PoseKey[], duration: number, settings: MotionSettings): THREE.AnimationClip {
  if (!keys.length || !asset.bones.length) throw new Error('Add a character and at least one pose before exporting.');
  const end = Math.max(0, duration);
  // Retain exact authored instants even if they fall between export frames.
  const sortedTimes = bakeTimes(0, end, keys.map(key => key.time));
  const poses = sortedTimes.map(time => samplePose(keys, time, settings.interpolation));
  const tracks: THREE.KeyframeTrack[] = [];
  const interpolation = settings.interpolation === 'stepped' ? THREE.InterpolateDiscrete : THREE.InterpolateLinear;
  asset.bones.forEach((bone, index) => {
    const fallback = asset.restPose[index];
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, sortedTimes, poses.flatMap(p => (p[index] ?? fallback).position), interpolation));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, sortedTimes, poses.flatMap(p => (p[index] ?? fallback).quaternion), interpolation));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.uuid}.scale`, sortedTimes, poses.flatMap(p => (p[index] ?? fallback).scale), interpolation));
  });
  tracks.push(...morphAnimationTracks(asset, keys, sortedTimes, settings.interpolation));
  return new THREE.AnimationClip('Still Motion', end, tracks);
}

function poseError(actual: Pose, predicted: Pose): number {
  let error = 0;
  for (let i = 0; i < actual.length; i++) {
    if (!predicted[i]) return Infinity;
    const a = actual[i], b = predicted[i];
    const position = new THREE.Vector3().fromArray(a.position).distanceTo(new THREE.Vector3().fromArray(b.position));
    const angle = quaternion(a.quaternion).angleTo(quaternion(b.quaternion));
    const scale = new THREE.Vector3().fromArray(a.scale).distanceTo(new THREE.Vector3().fromArray(b.scale));
    error = Math.max(error, position + angle * .3 + scale * .1);
  }
  return error;
}

/** Greedy maximum-error key reduction keeps endpoints and important pose changes. */
export function simplifyKeys(keys: PoseKey[], count: number, restMorphs: MorphValues = {}): PoseKey[] {
  const sorted = ordered(keys);
  if (sorted.length <= Math.max(2, count)) return sorted.map(k => ({ ...k, pose: copyPose(k.pose) }));
  const target = Math.max(2, Math.floor(count)), kept = new Set<number>([0, sorted.length - 1]);
  while (kept.size < target) {
    const indices = [...kept].sort((a, b) => a - b);
    let best = -1, maxError = -1;
    for (let segment = 0; segment < indices.length - 1; segment++) {
      const start = indices[segment], end = indices[segment + 1];
      const pair = [sorted[start], sorted[end]];
      for (let i = start + 1; i < end; i++) {
        const predicted = createMorphSampler(pair, 'smooth', restMorphs)(sorted[i].time);
        // A shape missing from a key plays at rest, so a key returning a shape to rest still counts.
        const names = new Set([sorted[i], ...pair].flatMap(key => Object.keys(key.morphs ?? {})));
        const morphError = Math.max(0, ...[...names].map(name => Math.abs((sorted[i].morphs?.[name] ?? restMorphs[name] ?? 0) - (predicted[name] ?? restMorphs[name] ?? 0))));
        const error = Math.max(morphError, poseError(sorted[i].pose, samplePose(pair, sorted[i].time, 'smooth')));
        if (error > maxError) { maxError = error; best = i; }
      }
    }
    if (best < 0) break;
    // If all poses match, retain evenly spaced moments rather than crowd one edge.
    if (maxError < 1e-9) {
      let widest = -1;
      for (let i = 0; i < indices.length - 1; i++) {
        const width = indices[i + 1] - indices[i];
        if (width > widest && width > 1) { widest = width; best = Math.floor((indices[i] + indices[i + 1]) / 2); }
      }
    }
    kept.add(best);
  }
  return [...kept].sort((a, b) => a - b).map(index => ({ ...sorted[index], pose: copyPose(sorted[index].pose) }));
}

/** CCD rotations preserve every bone's local translation and scale. Root drags translate. */
export function solveIK(asset: CharacterAsset, boneIndex: number, target: THREE.Vector3): void {
  const effector = asset.bones[boneIndex];
  if (!effector || !target.toArray().every(Number.isFinite)) return;
  asset.root.updateMatrixWorld(true);
  if (!(effector.parent instanceof THREE.Bone) || /(?:hips|pelvis|root)$/i.test(effector.name)) {
    effector.position.copy(effector.parent ? effector.parent.worldToLocal(target.clone()) : target);
    asset.root.updateMatrixWorld(true);
    return;
  }
  const limb = /hand|arm|leg|foot|toe|hoof|paw|wrist|ankle|knee|elbow/i.test(effector.name);
  const finger = isFingerBone(effector.name);
  const chain: THREE.Bone[] = [];
  let parent = effector.parent;
  while (parent instanceof THREE.Bone && chain.length < 4) {
    if (finger && !isFingerBone(parent.name)) break;
    if (limb && /hip|pelvis|spine|chest|torso|root/i.test(parent.name)) break;
    chain.push(parent);
    if (!(parent.parent instanceof THREE.Bone)) break;
    parent = parent.parent;
  }
  const jointPosition = new THREE.Vector3(), endPosition = new THREE.Vector3();
  for (let iteration = 0; iteration < 14; iteration++) {
    if (effector.getWorldPosition(endPosition).distanceToSquared(target) < 1e-6) break;
    for (const joint of chain) {
      joint.getWorldPosition(jointPosition);
      const from = effector.getWorldPosition(endPosition).sub(jointPosition), to = target.clone().sub(jointPosition);
      if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
      const rotation = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
      const angle = 2 * Math.acos(Math.min(1, Math.abs(rotation.w)));
      if (angle > .45) rotation.slerp(new THREE.Quaternion(), 1 - .45 / angle);
      const parentRotation = joint.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
      const localRotation = parentRotation.clone().invert().multiply(rotation).multiply(parentRotation);
      joint.quaternion.premultiply(localRotation).normalize();
      asset.root.updateMatrixWorld(true);
    }
  }
}

function feet(asset: CharacterAsset): number[] {
  const indices = asset.bones.map((b, i) => /foot|ankle|hoof|paw/i.test(b.name) && !/end|tip/i.test(b.name) ? i : -1).filter(i => i >= 0);
  return indices.length ? indices : asset.bones.map((b, i) => /toe/i.test(b.name) && !/end|tip/i.test(b.name) ? i : -1).filter(i => i >= 0);
}

/** Procedural assistance, not a trained AI model or a rigid-body simulation. */
export function applyPhysics(asset: CharacterAsset, keys: PoseKey[], settings: MotionSettings): PoseKey[] {
  const sorted = ordered(keys);
  if (!sorted.length || !asset.bones.length) return sorted.map(k => ({ ...k, pose: copyPose(k.pose) }));
  const footIndices = feet(asset);
  if (!footIndices.length) throw new Error('Ground assistance needs recognizable foot, ankle, hoof, paw, or toe bones. Rename or map the feet before using it.');
  const saved = capturePose(asset), strength = clamp01(settings.strength), height = Math.max(.1, asset.height);
  const rootIndex = asset.bones.findIndex(b => /(?:hips|pelvis)$/i.test(b.name));
  const root = asset.bones[rootIndex >= 0 ? rootIndex : asset.bones.findIndex(b => !(b.parent instanceof THREE.Bone))] ?? asset.bones[0];
  const point = (index: number) => asset.bones[index].getWorldPosition(new THREE.Vector3());
  const lift = (amount: number) => {
    const world = root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, amount, 0));
    root.position.copy(root.parent ? root.parent.worldToLocal(world) : world);
    asset.root.updateMatrixWorld(true);
  };
  try {
    applyPose(asset, asset.restPose);
    asset.root.updateMatrixWorld(true);
    const clearance = new Map(footIndices.map(index => [index, Math.max(0, Math.min(height * .12, point(index).y))]));
    const authoredClearances = sorted.map(key => {
      applyPose(asset, key.pose); asset.root.updateMatrixWorld(true);
      return Math.min(...footIndices.map(index => point(index).y - clearance.get(index)!));
    });
    const start = sorted[0].time, end = sorted[sorted.length - 1].time;
    const times = bakeTimes(start, end, sorted.map(key => key.time));
    const authoredByTime = new Map(sorted.map(key => [Math.fround(key.time), key]));
    const shapes = createMorphKeySampler(sorted, settings.interpolation, asset.restMorphs);
    const contacts = new Map<number, THREE.Vector3>(), result: PoseKey[] = [];
    for (const time of times) {
      applyPose(asset, samplePose(sorted, time, settings.interpolation));
      asset.root.updateMatrixWorld(true);
      const index = bracket(sorted, time), next = sorted[index + 1];
      if (next && Math.max(authoredClearances[index], authoredClearances[index + 1]) > height * .06) {
        const dt = next.time - sorted[index].time, u = dt > 0 ? (time - sorted[index].time) / dt : 0;
        const arc = Math.min(height * .6, Math.max(0, settings.gravity) * dt * dt / 8) * 4 * u * (1 - u) * strength;
        lift(arc);
      }
      if (settings.floorContact) {
        const penetration = Math.min(...footIndices.map(i => point(i).y - clearance.get(i)!));
        if (penetration < 0) lift(-penetration);
        for (const index of footIndices) {
          const current = point(index), floor = clearance.get(index)!;
          const existing = contacts.get(index);
          if (current.y - floor > height * .045 || (existing && existing.distanceTo(current) > height * .25)) {
            contacts.delete(index); continue;
          }
          if (!existing) contacts.set(index, new THREE.Vector3(current.x, floor, current.z));
          const target = current.clone().lerp(contacts.get(index)!, strength);
          solveIK(asset, index, target);
        }
        // IK can bring the other support foot down; preserve the floor constraint.
        const penetrationAfterIK = Math.min(...footIndices.map(i => point(i).y - clearance.get(i)!));
        if (penetrationAfterIK < 0) lift(-penetrationAfterIK);
      }
      const authored = authoredByTime.get(Math.fround(time));
      result.push({ ...makeKey(time, capturePose(asset), authored?.label), ...shapes(time), ...(authored ? { id: authored.id } : {}) });
    }
    return result;
  } finally { applyPose(asset, saved); }
}
