import { Matrix4, PropertyBinding, Quaternion } from 'three';
import type { AnimationClip, Bone, SkinnedMesh } from 'three';
import type { CharacterAsset, PoseKey } from '../types';
import { jointName } from './character';
import { sampleClip } from './motion';

const incompatible = (name: string) => new Error(`The animation's skeleton does not match ${name}. Use an animation exported for this rig, or choose Retarget with joint mapping.`);

function parentBone(bone: Bone, asset: CharacterAsset): Bone | null {
  let parent = bone.parent;
  while (parent && !asset.bones.includes(parent as Bone)) parent = parent.parent;
  return parent as Bone | null;
}

function jointPath(bone: Bone, asset: CharacterAsset): string {
  const names = [jointName(bone.name)];
  let parent = parentBone(bone, asset);
  while (parent) { names.unshift(jointName(parent.name)); parent = parentBone(parent, asset); }
  return names.join('/');
}

function fixedParentFrame(bone: Bone, asset: CharacterAsset): Matrix4 {
  const matrix = new Matrix4();
  let parent = bone.parent;
  while (parent && parent !== asset.root && !asset.bones.includes(parent as Bone)) {
    // The importer adds this wrapper only for presentation. A skeleton-only
    // file has different bounds, so its display normalization may differ.
    if (!(parent.name === 'Still_display_scale' && parent.parent === asset.root)) {
      parent.updateMatrix(); matrix.premultiply(parent.matrix);
    }
    parent = parent.parent;
  }
  return matrix;
}

/** Transfer compatible bone channels without replacing the target mesh or bind rig. */
export function importAnimationOnRig(target: CharacterAsset, source: CharacterAsset, clip: AnimationClip): PoseKey[] {
  if (!target.rigged || !source.rigged) throw incompatible(target.name);
  const targets = new Map<string, number[]>();
  target.bones.forEach((bone, index) => {
    const name = jointName(bone.name);
    targets.set(name, [...(targets.get(name) ?? []), index]);
  });
  const mapping = source.bones.map(bone => {
    const exact = target.bones.flatMap((item, index) => item.name === bone.name ? [index] : []);
    let matches = exact.length ? exact : targets.get(jointName(bone.name)) ?? [];
    if (matches.length > 1) matches = matches.filter(index => jointPath(target.bones[index], target) === jointPath(bone, source));
    return matches.length === 1 ? matches[0] : -1;
  });
  const animated = new Set<number>();
  for (const track of clip.tracks) {
    const parsed = PropertyBinding.parseTrackName(track.name);
    if (!['position', 'quaternion', 'scale'].includes(parsed.propertyName)) continue;
    let node = PropertyBinding.findNode(source.root, parsed.nodeName);
    if (parsed.objectName === 'bones') {
      const bones = (node as SkinnedMesh | null)?.skeleton?.bones;
      node = bones?.find(bone => bone.name === String(parsed.objectIndex)) ?? bones?.[Number(parsed.objectIndex)] ?? null;
    }
    const index = source.bones.indexOf(node as Bone);
    if (index >= 0) animated.add(index);
  }
  if (!animated.size) throw new Error('This file has no skeletal animation. Choose an animated FBX, GLB, or BVH.');
  const required = new Set(animated);
  for (const index of animated) {
    let parent = parentBone(source.bones[index], source);
    while (parent) { required.add(source.bones.indexOf(parent)); parent = parentBone(parent, source); }
  }
  const used = new Set<number>();
  for (const index of required) {
    const targetIndex = mapping[index];
    if (targetIndex < 0 || used.has(targetIndex)) throw incompatible(source.bones[index].name);
    used.add(targetIndex);
    const bone = source.bones[index], other = target.bones[targetIndex];
    const parent = parentBone(bone, source), otherParent = parentBone(other, target);
    if (parent ? mapping[source.bones.indexOf(parent)] < 0 || target.bones[mapping[source.bones.indexOf(parent)]] !== otherParent : otherParent !== null) throw incompatible(bone.name);
    const a = target.restPose[targetIndex], b = source.restPose[index];
    if (a.position.some((v, axis) => Math.abs(v - b.position[axis]) > 1e-4 * Math.max(1, Math.abs(v), Math.abs(b.position[axis]))) ||
        a.scale.some((v, axis) => Math.abs(v - b.scale[axis]) > 1e-4) ||
        new Quaternion().fromArray(a.quaternion).normalize().angleTo(new Quaternion().fromArray(b.quaternion).normalize()) > 1e-4) throw incompatible(bone.name);
    const from = fixedParentFrame(bone, source), to = fixedParentFrame(other, target);
    if (from.elements.some((value, axis) => Math.abs(value - to.elements[axis]) > 1e-4 * Math.max(1, Math.abs(value), Math.abs(to.elements[axis])))) throw incompatible(bone.name);
  }
  const keys = sampleClip(source, clip);
  return keys.map(key => {
    const pose = structuredClone(target.restPose);
    for (const index of animated) pose[mapping[index]] = structuredClone(key.pose[index]);
    const morphs = { ...target.restMorphs };
    for (const [name, value] of Object.entries(key.morphs ?? {})) {
      if (!(name in morphs)) throw new Error(`The animation uses a face shape this character does not have (${name}). Use an animation exported for this character.`);
      morphs[name] = value;
    }
    return { ...key, pose, ...(Object.keys(morphs).length ? { morphs } : {}) };
  });
}
