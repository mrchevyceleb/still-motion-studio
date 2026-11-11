import { describe, expect, it } from 'vitest';
import { createDemoCharacter } from './character';
import { buildAnimationClip, samplePose } from './motion';
import { validateProject } from './project';
import { combinedKeys, coveringTrackNames, createAnimationTrack, createLayerSampler, putLayerKey, recordTrackKey, trackEditDuration, type LayeredMotion } from './tracks';
import { DEFAULT_SETTINGS, type PoseKey, type ProjectDocument } from '../types';

function fixture() {
  const asset = createDemoCharacter('humanoid');
  const keys: PoseKey[] = [0, 2].map(time => {
    const pose = structuredClone(asset.restPose); pose[0].position[0] += time;
    return { id: `base-${time}`, time, pose, morphs: { blink: 0 } };
  });
  let state: LayeredMotion = { keys, duration: 2, settings: { ...DEFAULT_SETTINGS, interpolation: 'linear' } };
  const track = createAnimationTrack('Blinks', state, asset.restPose, { blink: 0 });
  state = { ...state, tracks: [track], activeTrackId: track.id };
  const put = (time: number, blink: number, rotate = false) => {
    const before = createLayerSampler(state, asset.restPose, { blink: 0 })(time);
    const after = structuredClone(before); after.morphs.blink = blink;
    if (rotate) after.pose[1].quaternion = [0, 0, Math.sin(.2), Math.cos(.2)];
    state = putLayerKey(state, { id: `blink-${time}`, time, ...after }, before, asset.restPose);
  };
  return { asset, put, get state() { return state; }, set state(next) { state = next; } };
}

describe('layered animation', () => {
  it('captures only edited eyelids and joint rotation while idle translation stays independent', () => {
    const f = fixture(), original = structuredClone(f.state.keys);
    f.put(.9, 0); f.put(1, 1, true); f.put(1.1, 0);
    expect(f.state.tracks![0].channels).toEqual([{ bone: 1, property: 'quaternion' }]);
    expect(f.state.tracks![0].morphs).toEqual(['blink']);
    expect(f.state.keys).toEqual(original);
    const sample = createLayerSampler(f.state, f.asset.restPose);
    for (const time of [.25, .97, 1, 1.25, 1.8]) expect(sample(time).pose[0]).toEqual(samplePose(original, time, 'linear')[0]);
    expect(sample(1).morphs.blink).toBe(1);
    expect(sample(1.1).morphs.blink).toBe(0);
  });

  it('respects ordering, mute, and the boundaries of a shifted layer', () => {
    const f = fixture(); f.put(1, 1);
    expect(trackEditDuration(f.state, 1.5)).toBe(2);
    expect(trackEditDuration({ ...f.state, activeTrackId: null }, 1.5)).toBe(2);
    expect(trackEditDuration({ ...f.state, tracks: [] }, 1.5)).toBe(1.5);
    const upper = createAnimationTrack('Upper', f.state, f.asset.restPose);
    f.state = { ...f.state, tracks: [...f.state.tracks!, upper], activeTrackId: upper.id };
    f.put(1, .3);
    expect(coveringTrackNames(f.state, 1)).toEqual([]);
    expect(coveringTrackNames({ ...f.state, activeTrackId: f.state.tracks![0].id }, 1)).toEqual(['Upper']);
    expect(createLayerSampler(f.state, f.asset.restPose)(1).morphs.blink).toBe(.3);
    f.state.tracks![1].muted = true;
    expect(coveringTrackNames({ ...f.state, activeTrackId: f.state.tracks![0].id }, 1)).toEqual([]);
    expect(createLayerSampler(f.state, f.asset.restPose)(1).morphs.blink).toBe(1);
    const shifted = { ...f.state.tracks![0], keys: f.state.tracks![0].keys.map(k => ({ ...k, time: k.time + .5 })) };
    const state = { ...f.state, duration: 2.5, tracks: [shifted] };
    expect(createLayerSampler(state, f.asset.restPose)(.25).morphs.blink).toBe(0);
    expect(createLayerSampler(state, f.asset.restPose)(1.5).morphs.blink).toBe(1);
  });

  it('editing the base never bakes a visible blink into it', () => {
    const f = fixture(); f.put(1, 1);
    f.state = { ...f.state, activeTrackId: null };
    const before = createLayerSampler(f.state, f.asset.restPose)(1), after = structuredClone(before);
    after.pose[0].position[2] += 2;
    f.state = putLayerKey(f.state, { id: 'edited-base', time: 1, ...after }, before, f.asset.restPose);
    expect(f.state.keys.find(k => k.id === 'edited-base')!.morphs!.blink).toBe(0);
    expect(createLayerSampler(f.state, f.asset.restPose)(1).morphs.blink).toBe(1);
  });

  it('bulk corrections compare stored keys so stale unowned values never capture new idle motion', () => {
    const f = fixture(); f.put(1, 1, true);
    // The base changes after this layer's snapshots were created.
    f.state.keys[0].pose[0].position[2] = 5;
    const track = f.state.tracks![0], original = track.keys[0], edited = structuredClone(original);
    edited.pose[1].quaternion = [0, 0, Math.sin(.3), Math.cos(.3)];
    const next = recordTrackKey(track, edited, { pose: original.pose, morphs: original.morphs ?? {} });
    expect(next.channels).toEqual([{ bone: 1, property: 'quaternion' }]);
    expect(createLayerSampler({ ...f.state, tracks: [next] }, f.asset.restPose)(0).pose[0].position[2]).toBe(5);
  });

  it('round-trips editable layers, rejects invalid masks, and bakes the combined export', () => {
    const f = fixture(); f.put(1, 1, true);
    const document: ProjectDocument = { ...f.state, version: 1, name: 'Hydra idle', fps: 30, settings: { ...DEFAULT_SETTINGS, interpolation: 'linear' }, boneNames: f.asset.bones.map(b => b.name), character: { type: 'demo', kind: 'humanoid' } };
    const restored = validateProject(JSON.parse(JSON.stringify(document)));
    expect(restored.tracks).toEqual(document.tracks);
    const keys = combinedKeys(restored, f.asset.restPose, { blink: 0 });
    const exported = buildAnimationClip(f.asset, keys, 2, { ...DEFAULT_SETTINGS, interpolation: 'linear' });
    expect(keys.find(k => k.time === 1)!.morphs!.blink).toBe(1);
    const rotation = exported.tracks.find(t => t.name === `${f.asset.bones[1].uuid}.quaternion`)!;
    const frame = Array.from(rotation.times).findIndex(t => Math.abs(t - 1) < 1e-8);
    expect(rotation.values[frame * 4 + 2]).toBeCloseTo(Math.sin(.2), 5);
    restored.tracks![0].channels[0].bone = 9999;
    expect(() => validateProject(restored)).toThrow('invalid animation track');
    const legacy = { ...document, tracks: undefined, activeTrackId: undefined };
    expect(validateProject(legacy).keys).toEqual(document.keys);
  });
});
