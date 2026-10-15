import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { CharacterAsset, Pose, PoseKey, Vec3 } from '../types';

export type PoseProperty = 'position' | 'rotation';
export type PropertyAxes = [boolean, boolean, boolean];
export interface PoseReference { keyId: string | null; time: number; before: Pose; after: Pose; bone: number | null }

/** Move every independent skeleton root in world space, including normalized imports. */
function modelRoots(asset: CharacterAsset) {
  const bones = new Set(asset.bones);
  const roots = asset.bones.flatMap((bone, index) => {
    let ancestor = bone.parent;
    while (ancestor && !bones.has(ancestor as typeof bone)) ancestor = ancestor.parent;
    if (ancestor) return [];
    bone.parent?.updateWorldMatrix(true, false);
    const world = bone.parent?.matrixWorld.clone() ?? new Matrix4();
    const determinant = world.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('The model has a zero parent scale or invalid parent transform. Reimport it with a valid scale.');
    return [{ index, world, inverse: world.clone().invert() }];
  });
  if (!roots.length) throw new Error('Add a rig before editing model position.');
  return roots;
}

export function propertyValues(asset: CharacterAsset, pose: Pose, property: PoseProperty, bone: number | null): Vec3 {
  if (property === 'rotation') {
    if (bone === null || !pose[bone]) throw new Error('Select a joint to copy its rotation.');
    const angles = new Euler().setFromQuaternion(new Quaternion().fromArray(pose[bone].quaternion), 'XYZ');
    return [angles.x, angles.y, angles.z].map(MathUtils.radToDeg) as Vec3;
  }
  const root = modelRoots(asset)[0];
  return new Vector3().fromArray(pose[root.index].position).applyMatrix4(root.world).toArray();
}

export function offsetPose(asset: CharacterAsset, pose: Pose, delta: Vec3): Pose {
  if (!delta.every(Number.isFinite)) throw new Error('Position must contain finite numbers.');
  if (delta.every(value => Math.abs(value) < 1e-10)) return pose;
  const next = pose.slice();
  for (const root of modelRoots(asset)) {
    // Subtract transformed origins so translation and normalization scale are handled correctly.
    const localDelta = new Vector3().fromArray(delta).applyMatrix4(root.inverse).sub(new Vector3().applyMatrix4(root.inverse));
    next[root.index] = { ...pose[root.index], position: new Vector3().fromArray(pose[root.index].position).add(localDelta).toArray() };
  }
  return next;
}

export function setModelPosition(asset: CharacterAsset, pose: Pose, position: Vec3): Pose {
  const previous = propertyValues(asset, pose, 'position', null);
  return offsetPose(asset, pose, position.map((value, axis) => value - previous[axis]) as Vec3);
}

export function offsetKeyframes(asset: CharacterAsset, keys: PoseKey[], delta: Vec3): PoseKey[] {
  const next = keys.map(key => {
    const pose = offsetPose(asset, key.pose, delta);
    return pose === key.pose ? key : { ...key, pose };
  });
  return next.every((key, index) => key === keys[index]) ? keys : next;
}

/** Paste one channel or apply a captured correction, without shifting the source twice. */
export function applyKeyframeProperty(asset: CharacterAsset, keys: PoseKey[], selected: ReadonlySet<string>, reference: PoseReference, property: PoseProperty, axes: PropertyAxes, mode: 'offset' | 'match'): PoseKey[] {
  if (!axes.some(Boolean)) throw new Error('Choose at least one axis.');
  const source = propertyValues(asset, reference.after, property, reference.bone);
  const before = propertyValues(asset, reference.before, property, reference.bone);
  const correction = source.map((value, axis) => property === 'rotation'
    ? MathUtils.euclideanModulo(value - before[axis] + 180, 360) - 180
    : value - before[axis]) as Vec3;
  const next = keys.map(key => {
    if (!selected.has(key.id) || key.id === reference.keyId) return key;
    const values = propertyValues(asset, key.pose, property, reference.bone);
    if (property === 'position') {
      const delta = values.map((value, axis) => axes[axis] ? mode === 'offset' ? correction[axis] : source[axis] - value : 0) as Vec3;
      const pose = offsetPose(asset, key.pose, delta);
      return pose === key.pose ? key : { ...key, pose };
    }
    const bone = reference.bone!;
    const rotation = new Quaternion().fromArray(key.pose[bone].quaternion);
    if (mode === 'match' && axes.every(Boolean)) {
      rotation.fromArray(reference.after[bone].quaternion);
    } else {
      const angles = values.map((value, axis) => MathUtils.degToRad(axes[axis] ? mode === 'offset' ? value + correction[axis] : source[axis] : value)) as Vec3;
      rotation.setFromEuler(new Euler(...angles, 'XYZ'));
    }
    if (1 - Math.abs(rotation.dot(new Quaternion().fromArray(key.pose[bone].quaternion))) < 1e-12) return key;
    const pose = key.pose.slice();
    pose[bone] = { ...pose[bone], quaternion: rotation.normalize().toArray() };
    return { ...key, pose };
  });
  return next.every((key, index) => key === keys[index]) ? keys : next;
}
