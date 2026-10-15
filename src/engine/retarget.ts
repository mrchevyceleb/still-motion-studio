import { Box3, Matrix3, Quaternion, Vector3 } from 'three';
import type { AnimationClip, Bone } from 'three';
import { applyPose, capturePose } from './character';
import { sampleClip } from './motion';
import type { CharacterAsset, PoseKey } from '../types';

const canonical = (name: string) => name.replace(/^.*[|:]/, '').replace(/^(mixamorig\d*|cc_base|bip\d*|def)[_ -]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Suggestions only: ambiguous names are left for the user to map explicitly. */
export function suggestBoneMapping(target: CharacterAsset, source: CharacterAsset): number[] {
  const used = new Set<number>();
  return source.bones.map(bone => {
    let matches = target.bones.flatMap((other, i) => other.name === bone.name ? [i] : []);
    if (!matches.length) matches = target.bones.flatMap((other, i) => canonical(other.name) === canonical(bone.name) ? [i] : []);
    if (matches.length !== 1 || used.has(matches[0])) return -1;
    used.add(matches[0]); return matches[0];
  });
}

function boneParent(bone: Bone, asset: CharacterAsset): Bone | null {
  let parent = bone.parent;
  while (parent && !asset.bones.includes(parent as Bone)) parent = parent.parent;
  return parent as Bone | null;
}

function restWorld(asset: CharacterAsset) {
  applyPose(asset, asset.restPose);
  const positions = asset.bones.map(b => b.getWorldPosition(new Vector3()));
  const rotations = asset.bones.map(b => b.getWorldQuaternion(new Quaternion()));
  for (const bone of asset.bones) {
    const scale = bone.getWorldScale(new Vector3());
    if (Math.min(scale.x, scale.y, scale.z) <= 0 || Math.max(scale.x, scale.y, scale.z) - Math.min(scale.x, scale.y, scale.z) > Math.max(scale.x, scale.y, scale.z) * 1e-4) throw new Error('Retargeting needs positive, uniform rig scale. Apply rig transforms in your 3D editor, or use matching-rig transfer.');
  }
  return { positions, rotations, size: new Box3().setFromPoints(positions).getSize(new Vector3()).length() };
}

/** Rotation transfer in shared world axes, retaining target lengths and bind frames.
 * Models must face the same way; this is not anatomical or contact-aware retargeting. */
export function retargetAnimation(target: CharacterAsset, source: CharacterAsset, clip: AnimationClip, mapping: number[], rootMotion = true): PoseKey[] {
  if (!target.rigged || !source.rigged || target === source) throw new Error('Load a rigged character and a separate skeletal animation.');
  if (mapping.length !== source.bones.length || mapping.some(i => !Number.isInteger(i) || i < -1 || i >= target.bones.length)) throw new Error('The joint mapping is invalid.');
  const mapped = mapping.filter(i => i >= 0);
  if (!mapped.length) throw new Error('Map at least one source joint to your character.');
  if (new Set(mapped).size !== mapped.length) throw new Error('Each character joint can receive only one source joint.');
  const savedTarget = capturePose(target), savedSource = capturePose(source);
  try {
    const from = restWorld(source), to = restWorld(target);
    const ratio = from.size > 1e-8 ? to.size / from.size : 1;
    const inverseMap = new Map(mapping.flatMap((targetIndex, sourceIndex) => targetIndex < 0 ? [] : [[targetIndex, sourceIndex] as const]));
    // Object traversal is parent-first, including unmapped intermediate joints.
    const order: number[] = [];
    target.root.traverse(node => { const i = target.bones.indexOf(node as Bone); if (i >= 0) order.push(i); });
    const sourceRoots = new Set(source.bones.flatMap((b, i) => !boneParent(b, source) || /^(hips|pelvis)$/i.test(canonical(b.name)) ? [i] : []));
    const keys = sampleClip(source, clip);
    for (const key of keys) for (let i = 0; i < mapping.length; i++) {
      if (mapping[i] < 0) continue;
      const p = key.pose[i], rest = source.restPose[i];
      if (p.scale.some((v, a) => Math.abs(v - rest.scale[a]) > 1e-4) || !sourceRoots.has(i) && p.position.some((v, a) => Math.abs(v - rest.position[a]) > 1e-4 * Math.max(1, Math.abs(rest.position[a])))) throw new Error(`Animated scale or joint translation on ${source.bones[i].name} needs matching-rig transfer. Retarget mode transfers rotations and root / hip travel.`);
    }
    return keys.map(key => {
      applyPose(source, key.pose); applyPose(target, target.restPose);
      const rotations = source.bones.map(b => b.getWorldQuaternion(new Quaternion()));
      for (const targetIndex of order) {
        const sourceIndex = inverseMap.get(targetIndex);
        if (sourceIndex === undefined) continue;
        const bone = target.bones[targetIndex];
        const desired = rotations[sourceIndex].clone().multiply(from.rotations[sourceIndex].clone().invert()).multiply(to.rotations[targetIndex]);
        const parentRotation = bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
        bone.quaternion.copy(parentRotation.invert().multiply(desired)).normalize();
        if (rootMotion && sourceRoots.has(sourceIndex)) {
          // Transfer only this joint's local displacement. World position deltas
          // would count root movement twice when both root and hips are mapped.
          const sourceBone = source.bones[sourceIndex];
          const delta = sourceBone.position.clone().sub(new Vector3().fromArray(source.restPose[sourceIndex].position));
          if (sourceBone.parent) delta.applyMatrix3(new Matrix3().setFromMatrix4(sourceBone.parent.matrixWorld));
          delta.multiplyScalar(ratio);
          if (bone.parent) delta.applyMatrix3(new Matrix3().setFromMatrix4(bone.parent.matrixWorld.clone().invert()));
          bone.position.add(delta);
        }
        bone.updateWorldMatrix(false, true);
      }
      const morphs = { ...target.restMorphs };
      for (const [name, value] of Object.entries(key.morphs ?? {})) {
        if (name in morphs) morphs[name] = value;
      }
      return { ...key, pose: capturePose(target), ...(Object.keys(morphs).length ? { morphs } : {}) };
    });
  } finally { applyPose(target, savedTarget); applyPose(source, savedSource); }
}
