import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, capturePose, createDemoCharacter } from './character';
import { applyPhysics, buildAnimationClip, createDemoKeys, sampleClip, samplePose, simplifyKeys, solveIK } from './motion';
import { DEFAULT_SETTINGS, type Pose, type PoseKey } from '../types';
import { assertMatchingRig, composeMotion, editMotion } from './clipEditing';

const poseAt = (x: number, angle = 0): Pose => [{ position: [x, 0, 0], quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle).toArray(), scale: [1, 1, 1] }];
const key = (time: number, pose: Pose): PoseKey => ({ id: String(time), time, pose });

describe('whole-clip tools', () => {
  const fixture = () => {
    const asset = createDemoCharacter('humanoid');
    const poses = [0, 1, 2].map((time) => {
      const pose = structuredClone(asset.restPose);
      pose[0].position[0] += time;
      pose[0].position[1] += time === 1 ? .3 : 0;
      pose[asset.bones.findIndex(b => b.name === 'RightArm')].quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), time * .2).toArray();
      return key(time, pose);
    });
    return { asset, sequence: { keys: poses, duration: 2, interpolation: 'smooth' as const } };
  };

  it('preserves trim boundaries, speed timing and reversed holds without changing the source', () => {
    const { asset, sequence } = fixture(), original = structuredClone(sequence);
    const trimmed = editMotion(asset, sequence, { kind: 'trim', start: .3, end: 1.6 }, 30);
    expect(trimmed.duration).toBeCloseTo(1.3);
    expect(trimmed.keys[0].pose).toEqual(samplePose(sequence.keys, .3, 'smooth'));
    expect(trimmed.keys.at(-1)!.pose).toEqual(samplePose(sequence.keys, 1.6, 'smooth'));
    const fast = editMotion(asset, sequence, { kind: 'speed', factor: 2 }, 30);
    expect(samplePose(fast.keys, .4, fast.interpolation)).toEqual(samplePose(sequence.keys, .8, 'smooth'));
    const reverse = editMotion(asset, { ...sequence, interpolation: 'stepped' }, { kind: 'reverse' }, 30);
    expect(reverse.interpolation).toBe('stepped');
    expect(samplePose(reverse.keys, .5, reverse.interpolation)).toEqual(sequence.keys[1].pose);
    expect(samplePose(reverse.keys, .001, reverse.interpolation)).toEqual(sequence.keys[1].pose);
    expect(samplePose(reverse.keys, 1.001, reverse.interpolation)).toEqual(sequence.keys[0].pose);
    expect(reverse.keys.at(-1)!.pose).toEqual(sequence.keys[0].pose);
    expect(editMotion(asset, { ...sequence, interpolation: 'stepped' }, { kind: 'trim', start: .3, end: 1.6 }, 30).interpolation).toBe('stepped');
    expect(sequence).toEqual(original);
    expect(() => editMotion(asset, sequence, { kind: 'trim', start: 1, end: 0 }, 30)).toThrow();
    expect(() => editMotion(asset, sequence, { kind: 'speed', factor: NaN }, 30)).toThrow();
  });

  it('locks planar hips travel beneath a stationary root and a scaled, rotated import parent', () => {
    const { asset, sequence } = fixture();
    const carrier = new THREE.Bone(); carrier.name = 'Root';
    asset.root.add(carrier); carrier.add(asset.bones[0]);
    asset.bones.unshift(carrier); asset.restPose.unshift({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
    sequence.keys.forEach(k => k.pose.unshift(structuredClone(asset.restPose[0])));
    asset.root.scale.setScalar(.01); asset.root.rotation.y = .6; asset.root.position.set(3, 0, -2);
    const result = editMotion(asset, sequence, { kind: 'in-place' }, 30);
    const positions = result.keys.map(k => { applyPose(asset, k.pose); return asset.bones[1].getWorldPosition(new THREE.Vector3()); });
    expect(positions.every(p => Math.abs(p.x - positions[0].x) < 1e-7 && Math.abs(p.z - positions[0].z) < 1e-7)).toBe(true);
    expect(positions[30].y - positions[0].y).toBeCloseTo(.003);
    // Hip sway must not rotate an otherwise stationary motion root.
    sequence.keys.at(-1)!.pose[1].quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .6).toArray();
    const appended = composeMotion(asset, sequence, sequence, 0, 30);
    expect(new THREE.Quaternion().fromArray(appended.keys.at(-1)!.pose[0].quaternion).angleTo(new THREE.Quaternion())).toBeCloseTo(0);
  });

  it('closes limb seams and repeats root travel with unique times and identities', () => {
    const { asset, sequence } = fixture();
    const result = editMotion(asset, sequence, { kind: 'repeat', count: 3, blend: .2 }, 30);
    expect(result.duration).toBe(6);
    expect(result.keys.at(-1)!.pose[0].position[0]).toBeCloseTo(6);
    expect(result.keys.at(-1)!.pose.slice(1)).toEqual(sequence.keys[0].pose.slice(1));
    expect(new Set(result.keys.map(k => k.id)).size).toBe(result.keys.length);
    expect(new Set(result.keys.map(k => Math.fround(k.time))).size).toBe(result.keys.length);
    expect(() => editMotion(asset, sequence, { kind: 'repeat', count: 400, blend: .2 }, 30)).toThrow();
  });

  it('appends at the previous trajectory and blends both endpoints exactly', () => {
    const { asset, sequence } = fixture();
    const combined = composeMotion(asset, sequence, sequence, .2, 30);
    expect(combined.duration).toBeCloseTo(3.8);
    expect(samplePose(combined.keys, 1.8, 'linear')).toEqual(samplePose(sequence.keys, 1.8, 'smooth'));
    const endPosition = samplePose(sequence.keys, 1.8, 'smooth')[0].position[0] + 2;
    expect(combined.keys.at(-1)!.pose[0].position[0]).toBeCloseTo(endPosition);
    const exported = buildAnimationClip(asset, combined.keys, combined.duration, { ...DEFAULT_SETTINGS, interpolation: 'linear' });
    expect(sampleClip(asset, exported).at(-1)!.pose[0].position[0]).toBeCloseTo(endPosition, 5);
    const held = { ...sequence, interpolation: 'stepped' as const };
    const heldComposite = composeMotion(asset, held, held, .2, 30);
    expect(samplePose(heldComposite.keys, .999, 'linear')).toEqual(sequence.keys[0].pose);
    const incompatible = createDemoCharacter('quadruped');
    expect(() => assertMatchingRig(asset, incompatible)).toThrow(/different rig/);
    const same = createDemoCharacter('humanoid');
    expect(() => assertMatchingRig(asset, same)).not.toThrow();
    same.restPose[2].position[1] += .1;
    expect(() => assertMatchingRig(asset, same)).toThrow(/rig differs/);
  });
});

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

  it('preserves Mixamo bone motion with a fixed Armature track but rejects parent motion', () => {
    const asset = createDemoCharacter('humanoid'), hips = asset.bones[0];
    const armature = new THREE.Group();
    armature.name = 'Armature';
    armature.quaternion.set(-3.7749e-8, 0, 0, 1).normalize();
    armature.position.set(100.123456789, 0, 0);
    asset.root.add(armature); armature.add(hips);
    const rest = armature.quaternion.clone(), start = hips.position.toArray();
    const bone = new THREE.VectorKeyframeTrack(`${hips.uuid}.position`, [0, 1], [...start, start[0] + .5, start[1], start[2]]);
    const fixed = new THREE.QuaternionKeyframeTrack('Armature.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, -1]);
    const position = new THREE.VectorKeyframeTrack('Armature.position', [0], armature.position.toArray());
    const clip = new THREE.AnimationClip('Mixamo', 1, [fixed, bone, position]);
    const keys = sampleClip(asset, clip);
    expect(keys.at(-1)!.pose[0].position[0]).toBeCloseTo(start[0] + .5);
    expect(capturePose(asset)).toEqual(asset.restPose);
    expect(armature.quaternion.toArray()).toEqual(rest.toArray());
    expect(sampleClip(asset, buildAnimationClip(asset, keys, 1, { ...DEFAULT_SETTINGS, interpolation: 'linear' })).at(-1)!.pose[0].position[0]).toBeCloseTo(start[0] + .5);
    const rotated = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .5).toArray();
    clip.tracks[0] = new THREE.QuaternionKeyframeTrack('Armature.quaternion', [0, 1], [0, 0, 0, 1, ...rotated]);
    expect(() => sampleClip(asset, clip)).toThrow(/Armature.quaternion/);
    clip.tracks[0] = new THREE.QuaternionKeyframeTrack('Armature.quaternion', [0], rotated);
    expect(() => sampleClip(asset, clip)).toThrow(/Armature.quaternion/);
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
