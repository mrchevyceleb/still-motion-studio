import { Box3, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import type { AnimationClip, Bone } from 'three';
import { applyPose, capturePose } from './character';
import { sampleClip } from './motion';
import type { CharacterAsset, PoseKey } from '../types';

export class RetargetError extends Error {
  constructor(message: string, readonly reason: 'scale' | 'joint-translation') { super(message); }
}

export const isHelperBone = (name: string) => /twist|helper|corrective/i.test(name) || /(?:^|[_.:\s-])(roll|ik|pole|target)(?:\d+)?(?:left|right|[lr])?(?:[_.:\s-]|$)/i.test(name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z])([A-Z])/g, '$1_$2'));

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
    if (Math.min(scale.x, scale.y, scale.z) <= 0 || Math.max(scale.x, scale.y, scale.z) - Math.min(scale.x, scale.y, scale.z) > Math.max(scale.x, scale.y, scale.z) * 1e-4) throw new RetargetError(`The rig for ${asset.name} needs positive, uniform scale before this move can be fitted.`, 'scale');
  }
  return { positions, rotations, size: new Box3().setFromPoints(positions).getSize(new Vector3()).length() };
}

/** Rotation transfer retaining target lengths. Optional alignment corrects facing and rest directions. */
export function retargetAnimation(target: CharacterAsset, source: CharacterAsset, clip: AnimationClip, mapping: number[], rootMotion = true, alignment?: { source: number[]; target: number[]; limbs: number[]; next: [number, number][]; ends: number[]; handSides: [number, number, number][] }): PoseKey[] {
  if (!target.rigged || !source.rigged || target === source) throw new Error('Load a rigged character and a separate skeletal animation.');
  if (mapping.length !== source.bones.length || mapping.some(i => !Number.isInteger(i) || i < -1 || i >= target.bones.length)) throw new Error('The joint mapping is invalid.');
  const mapped = mapping.filter(i => i >= 0);
  if (!mapped.length) throw new Error('Map at least one source joint to your character.');
  if (new Set(mapped).size !== mapped.length) throw new Error('Each character joint can receive only one source joint.');
  const savedTarget = capturePose(target), savedSource = capturePose(source);
  try {
    const from = restWorld(source), to = restWorld(target);
    const basis = (positions: Vector3[], indices: number[]) => {
      const [left, right] = indices.map(i => positions[i]);
      const x = left.clone().sub(right); x.y = 0; x.normalize();
      const y = new Vector3(0, 1, 0);
      if (x.lengthSq() < .5) throw new Error('This character cannot be aligned with the motion automatically.');
      const z = x.clone().cross(y).normalize();
      return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
    };
    const align = alignment ? basis(to.positions, alignment.target).multiply(basis(from.positions, alignment.source).invert()) : new Quaternion();
    const restCorrections = new Map<number, Quaternion>();
    const order: number[] = [];
    target.root.traverse(node => { const i = target.bones.indexOf(node as Bone); if (i >= 0) order.push(i); });
    if (alignment) {
      const nearestMappedParent = (index: number, asset: CharacterAsset, mapped: Set<number>): number => {
        let parent = boneParent(asset.bones[index], asset);
        while (parent) {
          const i = asset.bones.indexOf(parent);
          if (mapped.has(i)) return i;
          parent = boneParent(parent, asset);
        }
        return -1;
      };
      const sourceMapped = new Set(mapping.flatMap((value, index) => value < 0 ? [] : [index]));
      const targetMapped = new Set(mapping.filter(value => value >= 0));
      const limbBones = new Set<number>();
      for (const index of order) {
        const parent = boneParent(target.bones[index], target);
        if (alignment.limbs.includes(index) || parent && limbBones.has(target.bones.indexOf(parent))) limbBones.add(index);
      }
      const nextByTarget = new Map(alignment.next);
      const descendsFrom = (child: number, parent: number, asset: CharacterAsset) => {
        let bone = boneParent(asset.bones[child], asset);
        while (bone) { if (bone === asset.bones[parent]) return true; bone = boneParent(bone, asset); }
        return false;
      };
      for (const targetIndex of order) {
        const sourceIndex = mapping.indexOf(targetIndex);
        if (sourceIndex < 0 || !limbBones.has(targetIndex)) continue;
        const parent = nearestMappedParent(targetIndex, target, targetMapped);
        const correction = restCorrections.get(parent)?.clone() ?? new Quaternion();
        const expectedChild = nextByTarget.get(targetIndex);
        const preferred = expectedChild === undefined ? -1 : mapping.indexOf(expectedChild);
        const helper = isHelperBone(target.bones[targetIndex].name);
        const preferredValid = preferred >= 0 && descendsFrom(preferred, sourceIndex, source) && descendsFrom(mapping[preferred], targetIndex, target);
        const children = !preferredValid && !alignment.ends.includes(targetIndex) && !helper ? mapping.flatMap((mapped, i) => mapped >= 0 && !isHelperBone(target.bones[mapped].name) && nearestMappedParent(i, source, sourceMapped) === sourceIndex && nearestMappedParent(mapped, target, targetMapped) === targetIndex ? [i] : []) : [];
        const child = preferredValid ? preferred : children.length === 1 ? children[0] : -1;
        if (child < 0) { restCorrections.set(targetIndex, correction); continue; }
        const sourceDirection = from.positions[child].clone().sub(from.positions[sourceIndex]).applyQuaternion(align);
        const targetDirection = to.positions[mapping[child]].clone().sub(to.positions[targetIndex]).applyQuaternion(correction);
        const handSide = alignment.handSides.find(([hand]) => hand === targetIndex);
        if (handSide) {
          const sourceSideA = mapping.indexOf(handSide[1]), sourceSideB = mapping.indexOf(handSide[2]);
          const depth = (boneIndex: number) => {
            let bone = source.bones[boneIndex]?.parent, count = 1;
            while (bone && bone !== source.bones[sourceIndex]) { bone = bone.parent; count++; }
            return bone ? count : -1;
          };
          if (sourceSideA >= 0 && sourceSideB >= 0 && /middle/i.test(source.bones[child].name) && /index/i.test(source.bones[sourceSideA].name) && /pinky|little/i.test(source.bones[sourceSideB].name) && depth(sourceSideA) === depth(sourceSideB) && depth(sourceSideA) === depth(child) && depth(sourceSideA) > 0 && sourceDirection.lengthSq() > 1e-10 && targetDirection.lengthSq() > 1e-10 && sourceDirection.clone().normalize().dot(targetDirection.clone().normalize()) >= -0.866) {
            const frame = (forward: Vector3, side: Vector3) => {
              const x = forward.clone().normalize();
              const y = side.clone().addScaledVector(x, -side.dot(x));
              if (x.lengthSq() < .5 || side.lengthSq() < 1e-10 || y.lengthSq() < side.lengthSq() * .09) return null;
              y.normalize();
              return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, x.clone().cross(y).normalize()));
            };
            const sourceSide = from.positions[sourceSideA].clone().sub(from.positions[sourceSideB]).applyQuaternion(align);
            const targetSide = to.positions[handSide[1]].clone().sub(to.positions[handSide[2]]);
            const sourceFrame = frame(sourceDirection, sourceSide);
            const targetFrame = frame(to.positions[mapping[child]].clone().sub(to.positions[targetIndex]), targetSide);
            if (sourceFrame && targetFrame) {
              const swing = correction.clone().premultiply(new Quaternion().setFromUnitVectors(targetDirection.clone().normalize(), sourceDirection.clone().normalize()));
              const full = sourceFrame.multiply(targetFrame.invert());
              // A reversed palm landmark order is not a trustworthy hand frame.
              if (swing.angleTo(full) <= 2 * Math.PI / 3) { restCorrections.set(targetIndex, full); continue; }
            }
          }
        }
        if (sourceDirection.lengthSq() > 1e-10 && targetDirection.lengthSq() > 1e-10) {
          sourceDirection.normalize(); targetDirection.normalize();
          const dot = targetDirection.dot(sourceDirection);
          if (dot >= -0.866 && dot < 0.99985) correction.premultiply(new Quaternion().setFromUnitVectors(targetDirection, sourceDirection));
        }
        restCorrections.set(targetIndex, correction);
      }
    }
    const ratio = from.size > 1e-8 ? to.size / from.size : 1;
    const inverseMap = new Map(mapping.flatMap((targetIndex, sourceIndex) => targetIndex < 0 ? [] : [[targetIndex, sourceIndex] as const]));
    // Object traversal is parent-first, including unmapped intermediate joints.
    const sourceRoots = new Set(source.bones.flatMap((b, i) => !boneParent(b, source) || /^(hips|pelvis)$/i.test(canonical(b.name)) ? [i] : []));
    const keys = sampleClip(source, clip);
    for (const key of keys) for (let i = 0; i < mapping.length; i++) {
      if (mapping[i] < 0) continue;
      const p = key.pose[i], rest = source.restPose[i];
      if (p.scale.some((v, a) => Math.abs(v - rest.scale[a]) > 1e-4) || !sourceRoots.has(i) && p.position.some((v, a) => Math.abs(v - rest.position[a]) > 1e-4 * Math.max(1, Math.abs(rest.position[a])))) throw new RetargetError(`This move changes ${source.bones[i].name} in a way that can't be fitted automatically. Leave that joint unmatched in the fit settings.`, 'joint-translation');
    }
    return keys.map(key => {
      applyPose(source, key.pose); applyPose(target, target.restPose);
      const rotations = source.bones.map(b => b.getWorldQuaternion(new Quaternion()));
      for (const targetIndex of order) {
        const sourceIndex = inverseMap.get(targetIndex);
        if (sourceIndex === undefined) continue;
        const bone = target.bones[targetIndex];
        const desired = align.clone().multiply(rotations[sourceIndex]).multiply(from.rotations[sourceIndex].clone().invert()).multiply(align.clone().invert()).multiply(restCorrections.get(targetIndex) ?? new Quaternion()).multiply(to.rotations[targetIndex]);
        const parentRotation = bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
        bone.quaternion.copy(parentRotation.invert().multiply(desired)).normalize();
        if (rootMotion && sourceRoots.has(sourceIndex)) {
          // Transfer only this joint's local displacement. World position deltas
          // would count root movement twice when both root and hips are mapped.
          const sourceBone = source.bones[sourceIndex];
          const delta = sourceBone.position.clone().sub(new Vector3().fromArray(source.restPose[sourceIndex].position));
          if (sourceBone.parent) delta.applyMatrix3(new Matrix3().setFromMatrix4(sourceBone.parent.matrixWorld));
          delta.applyQuaternion(align);
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
