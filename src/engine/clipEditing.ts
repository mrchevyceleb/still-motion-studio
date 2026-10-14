import { Matrix4, Quaternion, Vector3 } from 'three';
import { createPoseSampler } from './motion';
import { offsetPose } from './poseProperties';
import { MAX_ANIMATION_DURATION } from './keyframeEditing';
import { createMorphKeySampler } from './morphs';
import type { CharacterAsset, InterpolationMode, Pose, PoseKey } from '../types';

export interface MotionSequence { keys: PoseKey[]; duration: number; interpolation: InterpolationMode }
export type ClipEdit = { kind: 'trim'; start: number; end: number } | { kind: 'speed'; factor: number }
  | { kind: 'speed-range'; start: number; end: number; factor: number }
  | { kind: 'reverse' } | { kind: 'in-place' } | { kind: 'loop'; blend: number } | { kind: 'repeat'; count: number; blend: number };
const key = (time: number, pose: Pose, shapes: Pick<PoseKey, 'morphs'> = {}): PoseKey => ({ id: crypto.randomUUID(), time, pose, ...shapes });

function blendShapes(a: Pick<PoseKey, 'morphs'>, b: Pick<PoseKey, 'morphs'>, weight: number): Pick<PoseKey, 'morphs'> {
  if (!a.morphs && !b.morphs) return {};
  const names = new Set([...Object.keys(a.morphs ?? {}), ...Object.keys(b.morphs ?? {})]);
  return { morphs: Object.fromEntries([...names].map(name => [name, (a.morphs?.[name] ?? 0) * (1 - weight) + (b.morphs?.[name] ?? 0) * weight])) };
}

function validDuration(duration: number, fps: number) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('Use a frame rate between 1 and 120.');
  if (!Number.isFinite(duration) || duration < 1 / fps - 1e-9 || duration > MAX_ANIMATION_DURATION) throw new Error('Keep the animation between one frame and 10 minutes.');
}

function times(duration: number, fps: number, extra: number[] = []) {
  const result = new Map<number, number>();
  const put = (t: number) => { if (t >= 0 && t <= duration) result.set(Math.fround(t), t); };
  for (let frame = 0; frame < Math.ceil(duration * fps); frame++) put(frame / fps);
  extra.forEach(put); put(0); put(duration);
  if (result.size > 72001) throw new Error('This edit would create too many frames. Use a lower frame rate or shorter clip.');
  return [...result.values()].sort((a, b) => a - b);
}

// Keep hold boundaries discontinuous when baking into linear export frames.
// Adjacent Float32 instants survive glTF timing; the small margin also avoids
// the pose sampler's exact-key tolerance during reverse evaluation.
function adjacentTime(time: number, direction: -1 | 1) {
  const margin = time + direction * 1e-8;
  const buffer = new ArrayBuffer(4), view = new DataView(buffer);
  view.setFloat32(0, margin);
  const rounded = view.getFloat32(0);
  if (direction < 0 && rounded < margin || direction > 0 && rounded > margin) return rounded;
  view.setUint32(0, view.getUint32(0) + direction);
  return view.getFloat32(0);
}
function boundaryTimes(sequence: MotionSequence, offset = 0, reverse = false) {
  return sequence.keys.flatMap(k => {
    const time = offset + (reverse ? sequence.duration - k.time : k.time);
    return sequence.interpolation === 'stepped' ? [time, adjacentTime(time, reverse ? 1 : -1)] : [time];
  });
}

function blendPose(a: Pose, b: Pose, weight: number): Pose {
  return a.map((bone, i) => ({
    position: new Vector3().fromArray(bone.position).lerp(new Vector3().fromArray(b[i].position), weight).toArray(),
    quaternion: new Quaternion().fromArray(bone.quaternion).normalize().slerp(new Quaternion().fromArray(b[i].quaternion).normalize(), weight).toArray(),
    scale: new Vector3().fromArray(bone.scale).lerp(new Vector3().fromArray(b[i].scale), weight).toArray(),
  }));
}

function roots(asset: CharacterAsset) {
  const indices = asset.bones.flatMap((bone, index) => {
    let parent = bone.parent;
    while (parent && !asset.bones.includes(parent as typeof bone)) parent = parent.parent;
    if (parent) return [];
    bone.parent?.updateWorldMatrix(true, false);
    const world = bone.parent?.matrixWorld.clone() ?? new Matrix4();
    if (Math.abs(world.determinant()) < 1e-12) throw new Error('This rig has a zero parent scale. Reimport it with valid transforms.');
    return [{ index, world, inverse: world.clone().invert() }];
  });
  if (!indices.length) throw new Error('Add a rig before editing motion.');
  return indices;
}
const localMatrix = (pose: Pose, index: number) => new Matrix4().compose(new Vector3().fromArray(pose[index].position), new Quaternion().fromArray(pose[index].quaternion).normalize(), new Vector3().fromArray(pose[index].scale));

function boneWorld(asset: CharacterAsset, pose: Pose, index: number): Matrix4 {
  const matrix = localMatrix(pose, index);
  let parent = asset.bones[index].parent;
  while (parent) {
    const boneIndex = asset.bones.indexOf(parent as typeof asset.bones[number]);
    if (boneIndex >= 0) matrix.premultiply(localMatrix(pose, boneIndex));
    else { parent.updateMatrix(); matrix.premultiply(parent.matrix); }
    parent = parent.parent;
  }
  return matrix;
}
function referenceWorld(asset: CharacterAsset, pose: Pose) {
  const pelvis = asset.bones.findIndex(bone => /(?:hips|pelvis)$/i.test(bone.name));
  return boneWorld(asset, pose, pelvis >= 0 ? pelvis : roots(asset)[0].index);
}
const positionOf = (asset: CharacterAsset, pose: Pose) => new Vector3().setFromMatrixPosition(referenceWorld(asset, pose));

/** Align planar travel and heading; retain jumps, height changes, and every limb. */
function alignment(asset: CharacterAsset, from: Pose, to: Pose) {
  const fromWorld = referenceWorld(asset, from), toWorld = referenceWorld(asset, to);
  const rootIndex = roots(asset)[0].index;
  const restRotation = new Quaternion();
  boneWorld(asset, asset.restPose, rootIndex).decompose(new Vector3(), restRotation, new Vector3());
  const forward = (pose: Pose) => {
    const matrix = boneWorld(asset, pose, rootIndex);
    const q = new Quaternion(); matrix.decompose(new Vector3(), q, new Vector3());
    const direction = new Vector3(0, 0, 1).applyQuaternion(q.multiply(restRotation.clone().invert()));
    return Math.hypot(direction.x, direction.z) > 1e-6 ? Math.atan2(direction.x, direction.z) : 0;
  };
  const a = new Vector3().setFromMatrixPosition(fromWorld), b = new Vector3().setFromMatrixPosition(toWorld);
  return new Matrix4().makeTranslation(b.x, 0, b.z)
    .multiply(new Matrix4().makeRotationY(forward(to) - forward(from)))
    .multiply(new Matrix4().makeTranslation(-a.x, 0, -a.z));
}

function transform(asset: CharacterAsset, pose: Pose, matrix: Matrix4): Pose {
  const next = pose.slice();
  for (const root of roots(asset)) {
    const local = root.inverse.clone().multiply(matrix).multiply(root.world).multiply(localMatrix(pose, root.index));
    const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
    local.decompose(position, quaternion, scale);
    const rebuilt = new Matrix4().compose(position, quaternion, scale);
    if (local.elements.some((value, i) => !Number.isFinite(value) || Math.abs(value - rebuilt.elements[i]) > 1e-5 * Math.max(1, Math.abs(value)))) {
      throw new Error('This rig’s parent scale cannot preserve a turn. Apply its transforms before composing or repeating motion.');
    }
    next[root.index] = { position: position.toArray(), quaternion: quaternion.normalize().toArray(), scale: scale.toArray() };
  }
  return next;
}

function loopSequence(asset: CharacterAsset, sequence: MotionSequence, blend: number, fps: number): MotionSequence {
  if (!Number.isFinite(blend) || blend < 1 / fps || blend > sequence.duration / 2) throw new Error('Loop blend must be at least one frame and no more than half the clip.');
  const sample = createPoseSampler(sequence.keys, sequence.interpolation);
  const shapes = createMorphKeySampler(sequence.keys, sequence.interpolation, asset.restMorphs);
  const start = sample(0), end = sample(sequence.duration);
  const destination = transform(asset, start, alignment(asset, start, end));
  // Match height as well, while preserving total planar travel and heading.
  const seam = offsetPose(asset, destination, [0, positionOf(asset, end).y - positionOf(asset, destination).y, 0]);
  const keys = times(sequence.duration, fps, [...boundaryTimes(sequence), sequence.duration - blend]).map(time => {
    const pose = sample(time);
    const u = Math.max(0, (time - (sequence.duration - blend)) / blend);
    const weight = u * u * (3 - 2 * u);
    return key(time, u > 0 ? blendPose(pose, seam, weight) : pose, u > 0 ? blendShapes(shapes(time), shapes(0), weight) : shapes(time));
  });
  return { keys, duration: sequence.duration, interpolation: 'linear' };
}

/** Where a moment lands after a range speed edit. The speed eases in and out over the range's edges
 *  (a quarter of the range, at most 0.12 s), so motion entering and leaving it keeps its own pace. */
export function rangeSpeedTime(edit: { start: number; end: number; factor: number }, time: number): number {
  const { start: a, end: b, factor } = edit;
  const ramp = Math.min(.12, (b - a) / 4), k = 1 / factor - 1;
  const area = (x: number) => x * x * x - x * x * x * x / 2;   // integral of smoothstep from 0 to x
  const rampIn = a + ramp + k * ramp / 2, middle = rampIn + (b - a - 2 * ramp) / factor, out = middle + ramp * (1 + k / 2);
  if (time <= a) return time;
  if (time <= a + ramp) { const x = (time - a) / ramp; return a + ramp * (x + k * area(x)); }
  if (time <= b - ramp) return rampIn + (time - a - ramp) / factor;
  if (time <= b) { const z = (time - b + ramp) / ramp; return middle + ramp * (z + k * (z - area(z))); }
  return out + time - b;
}

/** Whole-clip edits return new data; callers retain a single Undo snapshot. */
export function editMotion(asset: CharacterAsset, sequence: MotionSequence, edit: ClipEdit, fps: number): MotionSequence {
  validDuration(sequence.duration, fps);
  if (!sequence.keys.length) throw new Error('Add a pose before editing motion.');
  const sample = createPoseSampler(sequence.keys, sequence.interpolation);
  const shapes = createMorphKeySampler(sequence.keys, sequence.interpolation, asset.restMorphs);
  if (edit.kind === 'trim') {
    if (!Number.isFinite(edit.start) || !Number.isFinite(edit.end) || edit.start < 0 || edit.end > sequence.duration || edit.end <= edit.start) throw new Error('Choose a trim range inside the clip.');
    const duration = edit.end - edit.start; validDuration(duration, fps);
    // Bake to preserve the original smooth tangents at both new boundaries.
    return { duration, interpolation: sequence.interpolation === 'stepped' ? 'stepped' : 'linear', keys: times(duration, fps, sequence.keys.map(k => k.time - edit.start)).map(time => key(time, sample(time + edit.start), shapes(time + edit.start))) };
  }
  if (edit.kind === 'speed') {
    if (!Number.isFinite(edit.factor) || edit.factor < .1 || edit.factor > 10) throw new Error('Choose a speed from 0.1× to 10×.');
    const duration = sequence.duration / edit.factor; validDuration(duration, fps);
    return { ...sequence, duration, keys: sequence.keys.map(k => ({ ...k, time: k.time / edit.factor })) };
  }
  if (edit.kind === 'speed-range') {
    if (!Number.isFinite(edit.start) || !Number.isFinite(edit.end) || edit.start < 0 || edit.end > sequence.duration || edit.end - edit.start < 2 / fps) throw new Error('Choose a range of at least two frames inside the clip.');
    if (!Number.isFinite(edit.factor) || edit.factor < .1 || edit.factor > 10) throw new Error('Choose a speed from 0.1× to 10×.');
    if (edit.factor === 1) return sequence;
    const duration = rangeSpeedTime(edit, sequence.duration); validDuration(duration, fps);
    if (sequence.interpolation === 'stepped') return { ...sequence, duration, keys: sequence.keys.map(k => ({ ...k, time: rangeSpeedTime(edit, k.time) })) };
    // Sample the original curve, including the range boundaries: retiming only sparse
    // keys would change the whole segment even where it lies outside the chosen range.
    const ramp = Math.min(.12, (edit.end - edit.start) / 4);
    const sourceTimes = times(sequence.duration, fps, [...sequence.keys.map(k => k.time), edit.start, edit.start + ramp, edit.end - ramp, edit.end]);
    const originalKeys = new Map(sequence.keys.map(k => [Math.fround(k.time), k]));
    return { duration, interpolation: 'linear', keys: sourceTimes.map(time => {
      const original = originalKeys.get(Math.fround(time));
      const movedTime = rangeSpeedTime(edit, time);
      return original ? { ...original, time: movedTime } : key(movedTime, sample(time), shapes(time));
    }) };
  }
  if (edit.kind === 'reverse') {
    // Bake holds as well: reversing only key times would reverse the wrong held pose.
    return { ...sequence, interpolation: sequence.interpolation === 'stepped' ? 'stepped' : 'linear', keys: times(sequence.duration, fps, boundaryTimes(sequence, 0, true)).map(time => key(time, sample(sequence.duration - time), shapes(sequence.duration - time))) };
  }
  if (edit.kind === 'in-place') {
    const origin = positionOf(asset, sample(0));
    return { ...sequence, interpolation: sequence.interpolation === 'stepped' ? 'stepped' : 'linear', keys: times(sequence.duration, fps, sequence.keys.map(k => k.time)).map(time => {
      const pose = sample(time), position = positionOf(asset, pose);
      return key(time, offsetPose(asset, pose, [origin.x - position.x, 0, origin.z - position.z]), shapes(time));
    }) };
  }
  const loop = loopSequence(asset, sequence, edit.blend, fps);
  if (edit.kind === 'loop') return loop;
  if (!Number.isInteger(edit.count) || edit.count < 2 || edit.count > 20) throw new Error('Choose between 2 and 20 repeats.');
  const duration = sequence.duration * edit.count; validDuration(duration, fps);
  const matrices = [new Matrix4()], sampleLoop = createPoseSampler(loop.keys, 'linear');
  const loopShapes = createMorphKeySampler(loop.keys, 'linear', asset.restMorphs);
  for (let cycle = 1; cycle < edit.count; cycle++) {
    const previous = transform(asset, loop.keys.at(-1)!.pose, matrices[cycle - 1]), source = loop.keys[0].pose;
    const matrix = alignment(asset, source, previous);
    const height = positionOf(asset, previous).y - positionOf(asset, source).y;
    matrices.push(new Matrix4().makeTranslation(0, height, 0).multiply(matrix));
  }
  const extra = matrices.flatMap((_, cycle) => [cycle * sequence.duration, cycle * sequence.duration + sequence.duration - edit.blend, ...boundaryTimes(sequence, cycle * sequence.duration)]);
  const keys = times(duration, fps, extra).map(time => {
    const cycle = Math.min(edit.count - 1, Math.floor(time / sequence.duration));
    const localTime = time - cycle * sequence.duration;
    return key(time, transform(asset, sampleLoop(localTime), matrices[cycle]), loopShapes(localTime));
  });
  return { keys, duration, interpolation: 'linear' };
}

export function composeMotion(asset: CharacterAsset, base: MotionSequence, next: MotionSequence, blend: number, fps: number): MotionSequence {
  validDuration(base.duration, fps); validDuration(next.duration, fps);
  if (!base.keys.length || !next.keys.length) throw new Error('Both clips need at least one pose.');
  if (!Number.isFinite(blend) || blend < 0 || blend > Math.min(base.duration, next.duration) / 2) throw new Error('Clip blend must be between zero and half the shorter clip.');
  const start = base.duration - blend, duration = start + next.duration; validDuration(duration, fps);
  const sampleBase = createPoseSampler(base.keys, base.interpolation), sampleNext = createPoseSampler(next.keys, next.interpolation);
  const baseShapes = createMorphKeySampler(base.keys, base.interpolation, asset.restMorphs);
  const nextShapes = createMorphKeySampler(next.keys, next.interpolation, asset.restMorphs);
  const matrix = alignment(asset, sampleNext(0), sampleBase(start));
  const keys = times(duration, fps, [start, base.duration, ...boundaryTimes(base), ...boundaryTimes(next, start)]).map(time => {
    if (time < start) return key(time, sampleBase(time), baseShapes(time));
    const incoming = transform(asset, sampleNext(time - start), matrix);
    if (blend === 0 || time >= base.duration) return key(time, incoming, nextShapes(time - start));
    const u = (time - start) / blend;
    if (u === 0) return key(time, sampleBase(time), baseShapes(time));
    const weight = u * u * (3 - 2 * u);
    return key(time, blendPose(sampleBase(time), incoming, weight), blendShapes(baseShapes(time), nextShapes(time - start), weight));
  });
  return { keys, duration, interpolation: 'linear' };
}

/** A saved take can compose directly only when its bind rig really matches. */
export function assertMatchingRig(target: CharacterAsset, source: CharacterAsset) {
  if (target.kind !== source.kind || target.bones.length !== source.bones.length || !target.bones.length) throw new Error('This project uses a different rig. Open it as its own scene instead.');
  target.bones.forEach((bone, i) => {
    const other = source.bones[i], a = target.restPose[i], b = source.restPose[i];
    const parentName = (index: number, asset: CharacterAsset) => {
      let parent = asset.bones[index].parent;
      while (parent && !asset.bones.includes(parent as typeof bone)) parent = parent.parent;
      return parent?.name ?? '';
    };
    if (bone.name !== other.name || parentName(i, target) !== parentName(i, source) ||
        a.position.some((v, axis) => Math.abs(v - b.position[axis]) > 1e-4) || a.scale.some((v, axis) => Math.abs(v - b.scale[axis]) > 1e-4) ||
        new Quaternion().fromArray(a.quaternion).normalize().angleTo(new Quaternion().fromArray(b.quaternion).normalize()) > 1e-4) {
      throw new Error(`The saved take’s rig differs at ${bone.name}. Use motion saved from this character; other rigs need retargeting first.`);
    }
    const world = boneWorld(target, target.restPose, i), otherWorld = boneWorld(source, source.restPose, i);
    if (world.elements.some((v, axis) => Math.abs(v - otherWorld.elements[axis]) > 1e-4)) throw new Error(`The saved take uses different transforms at ${bone.name}. Use a take saved from this character.`);
  });
}
