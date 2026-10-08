import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, capturePose, createDemoCharacter } from './character';
import { applyPhysics, buildAnimationClip, createDemoKeys, sampleClip, samplePose, simplifyKeys, solveIK } from './motion';
import { DEFAULT_SETTINGS, type Pose, type PoseKey } from '../types';

const poseAt = (x: number, angle = 0): Pose => [{ position: [x, 0, 0], quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle).toArray(), scale: [1, 1, 1] }];
const key = (time: number, pose: Pose): PoseKey => ({ id: String(time), time, pose });

describe('motion edits preserve authored skeleton data', () => {
  it('keeps exact poses, holds steps, and interpolates the shortest rotation without mutating keys', () => {
    const keys = [key(0, poseAt(0, Math.PI * .9)), key(1, poseAt(2, -Math.PI * .9)), key(2, poseAt(0))];
    const original = structuredClone(keys);
    expect(samplePose(keys, 1, 'smooth')).toEqual(keys[1].pose);
    expect(samplePose(keys, .5, 'stepped')).toEqual(keys[0].pose);
    const midpoint = samplePose(keys, .5, 'smooth')[0];
    expect(midpoint.position[0]).toBeCloseTo(1);
    expect(Math.abs(new THREE.Quaternion().fromArray(midpoint.quaternion).w)).toBeLessThan(.01);
    samplePose(keys, 0, 'linear')[0].position[0] = 100;
    expect(keys).toEqual(original);
    const reduced = simplifyKeys([key(0, poseAt(0)), key(.5, poseAt(0)), key(1, poseAt(8)), key(1.5, poseAt(0)), key(2, poseAt(0))], 3);
    expect(reduced.map(k => k.time)).toEqual([0, 1, 2]);
  });

  it('samples original animation through its exact endpoint and restores rest; rejects lossy channels', () => {
    const asset = createDemoCharacter('humanoid'), hips = asset.bones[0];
    const rest = structuredClone(asset.restPose), start = hips.position.clone(), end = start.clone().add(new THREE.Vector3(.5, .2, 0));
    const clip = new THREE.AnimationClip('source', .11, [new THREE.VectorKeyframeTrack(`${hips.uuid}.position`, [0, .11], [...start.toArray(), ...end.toArray()])]);
    const keys = sampleClip(asset, clip);
    expect(keys.at(-1)!.time).toBe(.11);
    expect(keys.at(-1)!.pose[0].position[0]).toBeCloseTo(end.x, 5);
    expect(capturePose(asset)).toEqual(rest);
    const exported = buildAnimationClip(asset, keys, .11, DEFAULT_SETTINGS);
    const roundtrip = sampleClip(asset, exported);
    expect(roundtrip.at(-1)!.pose[0].position[0]).toBeCloseTo(end.x, 5);
    const unsupported = new THREE.AnimationClip('lossy', 1, [new THREE.VectorKeyframeTrack(`${asset.root.uuid}.position`, [0, 1], [0, 0, 0, 1, 0, 0])]);
    expect(() => sampleClip(asset, unsupported)).toThrow(/non-bone/);
    expect(capturePose(asset)).toEqual(rest);
  });

  it('moves an end effector toward its target without changing bone lengths or the hips', () => {
    const asset = createDemoCharacter('humanoid'), handIndex = asset.bones.findIndex(b => b.name === 'RightHand');
    const before = capturePose(asset), hand = asset.bones[handIndex];
    const target = hand.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(-.12, .45, .22));
    const previousError = hand.getWorldPosition(new THREE.Vector3()).distanceTo(target);
    solveIK(asset, handIndex, target);
    expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(previousError * .2);
    expect(capturePose(asset).map(p => p.position)).toEqual(before.map(p => p.position));
    expect(capturePose(asset).map(p => p.scale)).toEqual(before.map(p => p.scale));
    expect(capturePose(asset)[0]).toEqual(before[0]);
  });

  it('lifts ground penetration while keeping input keys and the current viewport pose unchanged', () => {
    const asset = createDemoCharacter('humanoid'), pose = structuredClone(asset.restPose);
    pose[0].position[1] -= .35;
    const keys = [key(0, pose), key(1, structuredClone(pose))], saved = structuredClone(keys);
    const result = applyPhysics(asset, keys, { ...DEFAULT_SETTINGS, floorContact: true, strength: 1 });
    expect(result[0].pose[0].position[1]).toBeGreaterThan(pose[0].position[1] + .3);
    expect(capturePose(asset)).toEqual(asset.restPose);
    expect(keys).toEqual(saved);
    applyPose(asset, result[Math.floor(result.length / 2)].pose);
    for (const bone of asset.bones.filter(b => /Foot$/.test(b.name))) expect(bone.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThanOrEqual(.12999);
  });

  it('merges frame precision collisions so physics projects and exported timelines remain valid', () => {
    const asset = createDemoCharacter('humanoid'), authored = createDemoKeys(asset);
    // 3 * .8 and 72 / 30 differ in JS, but become the same Float32 instant.
    expect(authored[3].time).not.toBe(72 / 30);
    const assisted = applyPhysics(asset, authored, { ...DEFAULT_SETTINGS, floorContact: true });
    expect(assisted).toHaveLength(121);
    expect(new Set(assisted.map(key => key.id)).size).toBe(assisted.length);
    expect(assisted.find(key => key.id === authored[3].id)?.time).toBe(authored[3].time);
    for (const keys of [authored, assisted]) {
      const clip = buildAnimationClip(asset, keys, 4, DEFAULT_SETTINGS);
      for (const track of clip.tracks) {
        expect(track.times).toHaveLength(121);
        expect([...track.times].every((time, index) => index === 0 || time > track.times[index - 1])).toBe(true);
      }
    }
    const endpoint = 4 + 1e-9;
    const clip = new THREE.AnimationClip('near-frame endpoint', endpoint, [new THREE.VectorKeyframeTrack(`${asset.bones[0].uuid}.position`, [0, endpoint], [0, 1, 0, 0, 2, 0])]);
    const sampled = sampleClip(asset, clip);
    expect(sampled).toHaveLength(121);
    expect(sampled.at(-1)!.time).toBe(endpoint);
  });
});
