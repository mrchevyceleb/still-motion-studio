import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { createDemoCharacter, capturePose } from './character';
import { createDemoKeys, samplePose } from './motion';
import { makeMotionRequest, restoreEngineFrames } from './assistance';
import { DEFAULT_SETTINGS } from '../types';

describe('source skeleton motion bridge', () => {
  it('round trips a scaled, rotated source hierarchy without changing its skin or bind transforms', () => {
    const asset = createDemoCharacter('humanoid');
    asset.root.scale.setScalar(.01);
    asset.root.rotation.set(.1, .4, -.2);
    asset.root.position.set(1, 0, -2);
    const original = capturePose(asset), root = asset.root, bones = [...asset.bones];
    const keys = createDemoKeys(asset);
    const request = makeMotionRequest(asset, keys, keys, 4, DEFAULT_SETTINGS, 'inbetween', 42);
    const restored = restoreEngineFrames(asset, keys, keys, { frames: request.frames }, 'smooth', 4, false);
    for (const frame of restored) {
      const expected = samplePose(keys, frame.time, 'smooth');
      for (let i = 0; i < frame.pose.length; i++) {
        expect(new Vector3().fromArray(frame.pose[i].position).distanceTo(new Vector3().fromArray(expected[i].position))).toBeLessThan(1e-10);
        expect(new Quaternion().fromArray(frame.pose[i].quaternion).angleTo(new Quaternion().fromArray(expected[i].quaternion))).toBeLessThan(1e-6);
        expect(frame.pose[i].scale).toEqual(expected[i].scale);
      }
    }
    expect(asset.root).toBe(root); expect(asset.bones).toEqual(bones);
    expect(capturePose(asset)).toEqual(original);
  });

  it('retains exact off-grid authored poses and rejects incomplete generated clips', () => {
    const asset = createDemoCharacter('humanoid');
    const keys = createDemoKeys(asset); keys[1].time = .817;
    const request = makeMotionRequest(asset, keys, keys, 4, DEFAULT_SETTINGS, 'inbetween', 42);
    const frames = request.frames.filter(frame => frame.time !== .817);
    const result = restoreEngineFrames(asset, keys, keys, { frames }, 'smooth', 4, true);
    expect(result.find(frame => frame.time === .817)).toEqual(keys[1]);
    expect(new Set(result.map(frame => frame.time)).size).toBe(result.length);
    expect(() => restoreEngineFrames(asset, keys, keys, { frames: frames.slice(1) }, 'smooth', 4, true)).toThrow(/complete animation/);
  });
});
