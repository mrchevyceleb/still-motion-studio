import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, capturePose, createDemoCharacter } from './character';
import { findHumanoidBones, retargetMocap, type MocapFrame, type MocapTake } from './mocap';
import type { Vec3 } from '../types';

/** A person facing the camera in MediaPipe world space (x image-right, y down, z away from camera). */
function person(overrides: Record<number, Vec3>): MocapFrame {
  const world: Vec3[] = Array.from({ length: 33 }, () => [0, 0, 0] as Vec3);
  const set = (index: number, value: Vec3) => { world[index] = value; };
  set(0, [0, -0.68, -0.1]); set(7, [0.08, -0.64, 0]); set(8, [-0.08, -0.64, 0]);
  set(11, [0.19, -0.5, 0]); set(12, [-0.19, -0.5, 0]);
  set(13, [0.24, -0.25, 0]); set(14, [-0.24, -0.25, 0]);
  set(15, [0.26, 0, 0]); set(16, [-0.26, 0, 0]);
  set(23, [0.09, 0, 0]); set(24, [-0.09, 0, 0]);
  set(25, [0.1, 0.45, 0]); set(26, [-0.1, 0.45, 0]);
  set(27, [0.11, 0.88, 0]); set(28, [-0.11, 0.88, 0]);
  set(29, [0.11, 0.92, 0.03]); set(30, [-0.11, 0.92, 0.03]);
  set(31, [0.11, 0.92, -0.12]); set(32, [-0.11, 0.92, -0.12]);
  for (const [index, value] of Object.entries(overrides)) set(Number(index), value);
  return {
    time: 0,
    world,
    image: world.map(([x, y]) => ({ x: 0.5 + x * 0.25, y: 0.55 + y * 0.45 })),
    visibility: world.map(() => 1),
  };
}

function takeWith(frames: MocapFrame[]): MocapTake {
  frames.forEach((frame, index) => { frame.time = index * 0.5; });
  return { name: 'Synthetic', duration: (frames.length - 1) * 0.5, frames, width: 1280, height: 720, detected: frames.length };
}

const worldY = (asset: ReturnType<typeof createDemoCharacter>, name: string) =>
  asset.bones.find(bone => bone.name === name)!.getWorldPosition(new THREE.Vector3()).y;

describe('motion capture', () => {
  it('finds every joint on the practice human and rejects the quadruped', () => {
    const human = findHumanoidBones(createDemoCharacter('humanoid'));
    expect(human.bones).not.toBeNull();
    expect(human.missing).toEqual([]);
    const quad = findHumanoidBones(createDemoCharacter('quadruped'));
    expect(quad.bones).toBeNull();
    expect(quad.missing.length).toBeGreaterThan(0);
  });

  it('raises the anatomical left arm and the marching left foot', () => {
    const asset = createDemoCharacter('humanoid');
    const before = capturePose(asset);
    const raised = person({ 13: [0.3, -0.72, 0], 15: [0.32, -0.95, 0], 25: [0.12, 0.35, -0.25], 27: [0.12, 0.55, -0.05] });
    const result = retargetMocap(asset, takeWith([person({}), raised, person({})]), { mirror: false, travel: false, smoothing: 0 });
    expect(result.keys).toHaveLength(3);
    expect(capturePose(asset)).toEqual(before);
    applyPose(asset, result.keys[1].pose);
    expect(worldY(asset, 'LeftHand')).toBeGreaterThan(worldY(asset, 'Head'));
    expect(worldY(asset, 'LeftHand')).toBeGreaterThan(worldY(asset, 'RightHand') + 0.5);
    expect(worldY(asset, 'LeftFoot')).toBeGreaterThan(worldY(asset, 'RightFoot') + 0.1);
    applyPose(asset, result.keys[0].pose);
    expect(worldY(asset, 'LeftHand')).toBeLessThan(worldY(asset, 'Head'));
  });

  it('keeps a straight-leg jump airborne and a crouch-only take low', () => {
    const asset = createDemoCharacter('humanoid');
    const standing = person({});
    const jumped = person({});
    jumped.image = jumped.image!.map(point => ({ x: point.x, y: point.y - 0.08 }));
    const jump = retargetMocap(asset, takeWith([standing, jumped, person({})]), { mirror: false, travel: false, smoothing: 0 });
    applyPose(asset, jump.keys[0].pose);
    const groundedHip = worldY(asset, 'Hips');
    applyPose(asset, jump.keys[1].pose);
    expect(worldY(asset, 'Hips')).toBeGreaterThan(groundedHip + 0.1);

    const crouch = () => person({
      25: [0.12, 0.22, -0.38], 26: [-0.12, 0.22, -0.38],
      27: [0.12, 0.45, 0], 28: [-0.12, 0.45, 0],
      29: [0.12, 0.48, 0.03], 30: [-0.12, 0.48, 0.03],
      31: [0.12, 0.48, -0.12], 32: [-0.12, 0.48, -0.12],
    });
    const crouched = retargetMocap(asset, takeWith([crouch(), crouch(), crouch()]), { mirror: false, travel: false, smoothing: 0 });
    applyPose(asset, crouched.keys[1].pose);
    expect(worldY(asset, 'Hips')).toBeLessThan(groundedHip - 0.25);
  });

  it('does not double-count straightening out of a crouch as a jump', () => {
    const asset = createDemoCharacter('humanoid');
    const deep = () => person({
      25: [0.12, 0.22, -0.38], 26: [-0.12, 0.22, -0.38],
      27: [0.12, 0.45, 0], 28: [-0.12, 0.45, 0],
      29: [0.12, 0.48, 0.03], 30: [-0.12, 0.48, 0.03],
      31: [0.12, 0.48, -0.12], 32: [-0.12, 0.48, -0.12],
    });
    const partial = person({
      25: [0.12, 0.325, -0.297], 26: [-0.12, 0.325, -0.297],
      27: [0.12, 0.65, 0], 28: [-0.12, 0.65, 0],
      29: [0.12, 0.68, 0.03], 30: [-0.12, 0.68, 0.03],
      31: [0.12, 0.68, -0.12], 32: [-0.12, 0.68, -0.12],
    });
    // Straightening raises the hips in the camera image too; that is the same
    // grounded rise the leg extension already accounts for, not a jump.
    partial.image = partial.image!.map(point => ({ x: point.x, y: point.y - 0.087 }));
    const pulse = retargetMocap(asset, takeWith([deep(), partial, deep()]), { mirror: false, travel: false, smoothing: 0 });
    applyPose(asset, pulse.keys[0].pose);
    const deepHip = worldY(asset, 'Hips');
    applyPose(asset, pulse.keys[1].pose);
    const rise = worldY(asset, 'Hips') - deepHip;
    expect(rise).toBeGreaterThan(0.12);
    expect(rise).toBeLessThan(0.45);
  });

  it('mirror swaps the raised arm to the other side', () => {
    const asset = createDemoCharacter('humanoid');
    const raised = person({ 13: [0.3, -0.72, 0], 15: [0.32, -0.95, 0] });
    const result = retargetMocap(asset, takeWith([person({}), raised, person({})]), { mirror: true, travel: false, smoothing: 0 });
    applyPose(asset, result.keys[1].pose);
    expect(worldY(asset, 'RightHand')).toBeGreaterThan(worldY(asset, 'LeftHand') + 0.5);
  });
});
