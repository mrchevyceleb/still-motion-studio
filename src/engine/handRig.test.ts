import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyPose, autoRigCharacter, capturePose, disposeCharacter, estimateAutoRig } from './character';
import { solveIK } from './motion';
import { validateRigFit } from './handRig';
import type { CharacterAsset } from '../types';

function fixture(): CharacterAsset {
  const root = new THREE.Group(), material = new THREE.MeshStandardMaterial();
  const box = (name: string, size: number[], at: number[]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size as [number, number, number], 3, 3, 3), material);
    mesh.name = name; mesh.position.fromArray(at); root.add(mesh);
  };
  const limb = (name: string, a: number[], b: number[], radius: number) => {
    const start = new THREE.Vector3().fromArray(a), end = new THREE.Vector3().fromArray(b), direction = end.clone().sub(start);
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, direction.length(), 6, 12, 6), material);
    mesh.name = name; mesh.position.copy(start.clone().add(end).multiplyScalar(.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); root.add(mesh);
  };
  box('body', [.44, .78, .28], [0, 1.36, 0]); box('hips', [.43, .20, .27], [0, .97, 0]);
  limb('neck', [0, 1.73, 0], [0, 1.92, 0], .07);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.18, 20, 16), material); head.position.set(0, 2.12, 0); root.add(head);
  for (const sign of [-1, 1]) {
    limb('leg', [sign * .14, .10, 0], [sign * .14, .93, 0], .075);
    box('foot', [.15, .09, .30], [sign * .14, .045, .065]);
    limb('arm', [sign * .21, 1.65, 0], [sign * .80, 1.65, 0], .05);
    box('palm', [.15, .16, .055], [sign * .875, 1.65, 0]);
    for (const [i, length] of [.12, .15, .135, .10].entries()) limb(`digit-${sign}-${i}`, [sign * .94, 1.715 - i * .045, 0], [sign * (.94 + length), 1.715 - i * .045, 0], .012);
    limb(`thumb-${sign}`, [sign * .86, 1.71, 0], [sign * 1.005, 1.81, 0], .014);
  }
  root.updateMatrixWorld(true);
  return { root, bones: [], restPose: [], clips: [], kind: 'humanoid', name: 'Open-hand fixture', source: 'import', rigged: false, height: 2.3, warnings: [] };
}

describe('hand auto-rigging', () => {
  it('detects five separated fingers per hand and builds complete editable chains', () => {
    const source = fixture(), fit = estimateAutoRig(source, 'humanoid');
    expect(fit.joints.length).toBe(61);
    expect(fit.diagnostics.hands?.map(h => h.detectedTips)).toEqual([5, 5]);
    expect(fit.diagnostics.hands?.[0].digits?.find(d => d.finger === 'Index')?.landmarks).toEqual({ '1': 'estimated', '2': 'estimated', '3': 'estimated', End: 'detected' });
    for (const side of ['Left', 'Right']) for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      const chain = fit.joints.filter(j => j.name.startsWith(`${side}Hand${finger}`));
      expect(chain.length).toBe(4); expect(chain[0].parent).toBe(`${side}Hand`);
    }
    const fitted = autoRigCharacter(source, 'humanoid', { fit });
    expect(fitted.bones.length).toBe(61); expect(source.bones).toHaveLength(0);
    expect(capturePose(fitted)).toEqual(fitted.restPose);
    disposeCharacter(fitted); disposeCharacter(source);
  });

  it('weights neighboring digits separately and isolates fingertip IK from the hand and arm', () => {
    const source = fixture(), fitted = autoRigCharacter(source, 'humanoid');
    const index = fitted.bones.findIndex(b => b.name === 'LeftHandIndex1');
    const pose = structuredClone(fitted.restPose);
    pose[index].quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -.5).toArray();
    const displacement = (name: string) => {
      const mesh = fitted.root.getObjectByName(name) as THREE.SkinnedMesh;
      const positions = mesh.geometry.getAttribute('position'), original = new THREE.Vector3(), after = new THREE.Vector3();
      let maximum = 0;
      for (let vertex = 0; vertex < positions.count; vertex++) {
        original.fromBufferAttribute(positions, vertex); mesh.applyBoneTransform(vertex, after.copy(original)); maximum = Math.max(maximum, after.distanceTo(original));
      }
      return maximum;
    };
    applyPose(fitted, pose);
    expect(displacement('digit-1-0')).toBeGreaterThan(.025);
    expect(displacement('digit-1-1')).toBeLessThan(.01);
    applyPose(fitted, fitted.restPose);
    const tip = fitted.bones.findIndex(b => b.name === 'LeftHandIndexEnd');
    solveIK(fitted, tip, fitted.bones[tip].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, -.04, 0)));
    const after = capturePose(fitted), hand = fitted.bones.findIndex(b => b.name === 'LeftHand');
    expect(after[hand]).toEqual(fitted.restPose[hand]);
    expect(after[fitted.bones.findIndex(b => b.name === 'LeftForeArm')]).toEqual(fitted.restPose[fitted.bones.findIndex(b => b.name === 'LeftForeArm')]);
    disposeCharacter(fitted); disposeCharacter(source);
  });

  it('rejects invalid placement without damaging the source, and permits body-only rigging', () => {
    const source = fixture(), fit = estimateAutoRig(source, 'humanoid');
    const original = source.root.toJSON();
    fit.joints.find(j => j.name === 'LeftHandIndex1')!.position[0] = 100;
    expect(() => validateRigFit(fit, new THREE.Box3().setFromObject(source.root), 'humanoid')).toThrow(/outside/);
    expect(() => autoRigCharacter(source, 'humanoid', { fit })).toThrow(/outside/);
    const reversed = estimateAutoRig(source, 'humanoid');
    const middle = reversed.joints.find(j => j.name === 'LeftHandIndex2')!, last = reversed.joints.find(j => j.name === 'LeftHandIndex3')!;
    [middle.position, last.position] = [last.position, middle.position];
    expect(() => autoRigCharacter(source, 'humanoid', { fit: reversed })).toThrow(/knuckle through/);
    const opposite = estimateAutoRig(source, 'humanoid');
    opposite.joints.find(j => j.name === 'LeftHandIndexEnd')!.position = [...opposite.joints.find(j => j.name === 'RightHandIndexEnd')!.position];
    expect(() => autoRigCharacter(source, 'humanoid', { fit: opposite })).toThrow(/hand area/);
    const overlap = estimateAutoRig(source, 'humanoid');
    for (const segment of ['1', '2', '3', 'End']) overlap.joints.find(j => j.name === `LeftHandMiddle${segment}`)!.position = [...overlap.joints.find(j => j.name === `LeftHandIndex${segment}`)!.position];
    expect(() => autoRigCharacter(source, 'humanoid', { fit: overlap })).toThrow(/overlap/);
    const swapped = estimateAutoRig(source, 'humanoid');
    for (const segment of ['1', '2', '3', 'End']) {
      const index = swapped.joints.find(j => j.name === `LeftHandIndex${segment}`)!, middle = swapped.joints.find(j => j.name === `LeftHandMiddle${segment}`)!;
      [index.position, middle.position] = [middle.position, index.position];
    }
    expect(() => autoRigCharacter(source, 'humanoid', { fit: swapped })).toThrow(/out of order/);
    expect(source.root.toJSON()).toEqual(original);
    const body = autoRigCharacter(source, 'humanoid', { fingers: false });
    expect(body.bones).toHaveLength(21);
    const pose = capturePose(body); expect(autoRigCharacter(body, 'humanoid')).toBe(body); expect(capturePose(body)).toEqual(pose);
    const mitten = fixture();
    for (const child of [...mitten.root.children]) if (/^digit|^thumb/.test(child.name)) { mitten.root.remove(child); (child as THREE.Mesh).geometry.dispose(); }
    expect(estimateAutoRig(mitten, 'humanoid').diagnostics.hands?.every(h => h.status === 'estimated')).toBe(true);
    disposeCharacter(mitten);
    disposeCharacter(body); disposeCharacter(source);
  });
});
