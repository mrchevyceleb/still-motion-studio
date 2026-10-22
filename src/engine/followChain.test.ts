import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDemoCharacter, capturePose, applyPose } from './character';
import { solveFollow } from './followChain';
import { solveIK } from './motion';

const v3 = (bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3());

// Roll of each joint around its own bone axis, measured against the rest pose:
// how much the drag wrung the model, in degrees. The probe lives in the bone's
// local frame and both world directions are projected across the bone axis,
// so plain bending is never misread as roll.
function worstRoll(asset: ReturnType<typeof createDemoCharacter>, rest: ReturnType<typeof createDemoCharacter>): number {
  let worst = 0;
  asset.bones.forEach((bone, index) => {
    const restBone = rest.bones[index];
    const children = bone.children.filter((child): child is THREE.Bone => child instanceof THREE.Bone);
    const restChildren = restBone.children.filter((child): child is THREE.Bone => child instanceof THREE.Bone);
    if (children.length !== 1 || restChildren.length !== 1) return;
    const axis = v3(children[0]).sub(v3(bone)).normalize();
    const localAxis = restChildren[0].position.clone().normalize();
    let probe = new THREE.Vector3(0, 0, 1);
    if (Math.abs(probe.dot(localAxis)) > .9) probe.set(1, 0, 0);
    probe.addScaledVector(localAxis, -probe.dot(localAxis)).normalize();
    const restRaw = probe.clone().applyQuaternion(restBone.getWorldQuaternion(new THREE.Quaternion()));
    const restWorld = restRaw.clone().addScaledVector(axis, -restRaw.dot(axis)).normalize();
    const solvedRaw = probe.clone().applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
    const solvedWorld = solvedRaw.clone().addScaledVector(axis, -solvedRaw.dot(axis)).normalize();
    const roll = Math.atan2(restWorld.clone().cross(solvedWorld).dot(axis), restWorld.dot(solvedWorld));
    worst = Math.max(worst, Math.abs(roll) * 180 / Math.PI);
  });
  return worst;
}

describe('dragging a chain', () => {
  it('bends the neck after the head without wringing the model', () => {
    const asset = createDemoCharacter('humanoid');
    const rest = createDemoCharacter('humanoid');
    const headIndex = asset.bones.findIndex(bone => bone.name === 'Head');
    const head = asset.bones[headIndex];
    const target = v3(head).add(new THREE.Vector3(.55, .35, .45));
    expect(solveFollow(asset, headIndex, target, .2)).toBe(true);
    // Hard pull: the shoulders stay anchored, so assert a real bend, not arrival.
    const moved = v3(head).distanceTo(v3(rest.bones[headIndex]));
    expect(moved).toBeGreaterThan(.1);
    expect(worstRoll(asset, rest)).toBeLessThan(35);
  });

  it('keeps a pulled-up hand near its target with barely any roll', () => {
    const asset = createDemoCharacter('humanoid');
    const rest = createDemoCharacter('humanoid');
    const handIndex = asset.bones.findIndex(bone => bone.name === 'RightHand');
    const hand = asset.bones[handIndex], before = capturePose(asset);
    const target = v3(hand).add(new THREE.Vector3(-.25, .45, .35));
    solveIK(asset, handIndex, target);
    expect(v3(hand).distanceTo(target)).toBeLessThan(.05);
    expect(worstRoll(asset, rest)).toBeLessThan(35);
    expect(capturePose(asset).map(p => p.position)).toEqual(before.map(p => p.position));
    applyPose(asset, before);
  });
});
