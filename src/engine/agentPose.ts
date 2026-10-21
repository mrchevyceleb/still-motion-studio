import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { solveIK } from './motion';
import { solveFollow } from './followChain';
import type { BonePose, CharacterAsset, Pose, Quat, Vec3 } from '../types';

export type BoneReference = number | string | { index?: number; name?: string };
export interface LocalPoseEdit {
  bone: BoneReference;
  position?: Vec3;
  quaternion?: Quat;
  scale?: Vec3;
  /** Absolute local Euler rotation, in degrees, with XYZ order. */
  rotationDegrees?: Vec3;
}
export interface SkeletonInspection {
  kind: CharacterAsset['kind'];
  bones: { index: number; name: string; parent: number; parentObject: string | null; local: BonePose; world: BonePose }[];
}

function vector(value: unknown, size: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== size || !value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e8)) {
    throw new Error(`${label} must contain ${size} finite numbers between -100000000 and 100000000.`);
  }
  return [...value];
}

function rotation(value: unknown, label: string): Quat {
  const values = vector(value, 4, label);
  const q = new THREE.Quaternion().fromArray(values);
  if (q.lengthSq() < 1e-16) throw new Error(`${label} cannot be a zero quaternion.`);
  return q.normalize().toArray() as Quat;
}

function scale(value: unknown, label: string): Vec3 {
  const values = vector(value, 3, label);
  if (values.some(n => Math.abs(n) < 1e-8)) throw new Error(`${label} cannot contain a zero or near-zero scale.`);
  return values as Vec3;
}

export function validateAgentPose(asset: CharacterAsset, input: unknown): Pose {
  if (!Array.isArray(input) || input.length !== asset.bones.length) throw new Error('The pose must contain one transform for every skeleton joint.');
  return input.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Joint ${index} requires a local transform.`);
    return { position: vector(item.position, 3, `Joint ${index} position`) as Vec3, quaternion: rotation(item.quaternion, `Joint ${index} quaternion`), scale: scale(item.scale, `Joint ${index} scale`) };
  });
}

/** Names are exact; duplicate imported names require a numeric joint index. */
export function resolveBone(asset: CharacterAsset, reference: BoneReference): number {
  if (reference && typeof reference === 'object' && reference.index !== undefined) {
    const index = resolveBone(asset, reference.index);
    if (reference.name !== undefined && reference.name !== asset.bones[index].name) throw new Error('The joint name does not match its index.');
    return index;
  }
  const value = reference && typeof reference === 'object' ? reference.name : reference;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value >= asset.bones.length) throw new Error(`Joint index must be between 0 and ${asset.bones.length - 1}.`);
    return value;
  }
  if (typeof value !== 'string' || !value) throw new Error('Identify a joint by its index or exact name.');
  const matches = asset.bones.flatMap((bone, index) => bone.name === value ? [index] : []);
  if (!matches.length) throw new Error(`No joint is named "${value}".`);
  if (matches.length > 1) throw new Error(`The name "${value}" matches multiple joints (${matches.join(', ')}). Use an index.`);
  return matches[0];
}

/** Temporary evaluation always restores the viewport's current pose. */
export function inspectSkeleton(asset: CharacterAsset, pose?: Pose): SkeletonInspection {
  const original = capturePose(asset);
  try {
    if (pose) applyPose(asset, validateAgentPose(asset, pose));
    asset.root.updateMatrixWorld(true);
    const indices = new Map<THREE.Object3D, number>(asset.bones.map((bone, index) => [bone, index]));
    return { kind: asset.kind, bones: asset.bones.map((bone, index) => {
      let parent = bone.parent;
      while (parent && !indices.has(parent)) parent = parent.parent;
      return {
        index, name: bone.name, parent: parent ? indices.get(parent)! : -1,
        parentObject: bone.parent?.name || null,
        local: { position: bone.position.toArray() as Vec3, quaternion: bone.quaternion.toArray() as Quat, scale: bone.scale.toArray() as Vec3 },
        world: { position: bone.getWorldPosition(new THREE.Vector3()).toArray() as Vec3, quaternion: bone.getWorldQuaternion(new THREE.Quaternion()).toArray() as Quat, scale: bone.getWorldScale(new THREE.Vector3()).toArray() as Vec3 },
      };
    }) };
  } finally { if (pose) applyPose(asset, original); }
}

/** Return an edited copy; position/scale edits deliberately change local joint geometry. */
export function editLocalPose(asset: CharacterAsset, pose: Pose, edits: LocalPoseEdit[]): Pose {
  if (!Array.isArray(edits) || !edits.length || edits.length > asset.bones.length * 4) throw new Error('Provide a nonempty, bounded list of joint edits.');
  const output = validateAgentPose(asset, pose);
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') throw new Error('Each joint edit must be an object.');
    const index = resolveBone(asset, edit.bone);
    if (edit.quaternion !== undefined && edit.rotationDegrees !== undefined) throw new Error('Use either quaternion or rotationDegrees for a joint edit.');
    if ([edit.position, edit.quaternion, edit.rotationDegrees, edit.scale].every(value => value === undefined)) throw new Error('Each joint edit needs a position, rotation, or scale.');
    if (edit.position !== undefined) output[index].position = vector(edit.position, 3, 'Position') as Vec3;
    if (edit.scale !== undefined) output[index].scale = scale(edit.scale, 'Scale');
    if (edit.quaternion !== undefined) output[index].quaternion = rotation(edit.quaternion, 'Quaternion');
    if (edit.rotationDegrees !== undefined) {
      const [x, y, z] = vector(edit.rotationDegrees, 3, 'Rotation degrees').map(THREE.MathUtils.degToRad);
      output[index].quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray() as Quat;
    }
  }
  return output;
}

/** Use the editor's CCD solver (or the follow-chain solver at a feel, 0 snaky to 1 robotic) in viewport world units, then restore the asset. */
export function moveJoint(asset: CharacterAsset, pose: Pose, bone: BoneReference, targetWorld: Vec3, follow?: number) {
  const index = resolveBone(asset, bone);
  const target = vector(targetWorld, 3, 'World target') as Vec3;
  const source = validateAgentPose(asset, pose);
  const original = capturePose(asset);
  try {
    applyPose(asset, source);
    const goal = new THREE.Vector3().fromArray(target);
    if (follow === undefined || !solveFollow(asset, index, goal, follow)) solveIK(asset, index, goal);
    const output = capturePose(asset);
    const achieved = asset.bones[index].getWorldPosition(new THREE.Vector3()).toArray() as Vec3;
    return { pose: output, boneIndex: index, target, achieved, error: new THREE.Vector3().fromArray(achieved).distanceTo(new THREE.Vector3().fromArray(target)) };
  } finally { applyPose(asset, original); }
}
