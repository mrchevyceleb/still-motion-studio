import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { samplePose } from './motion';
import { createMorphKeySampler } from './morphs';
import type { CharacterAsset, InterpolationMode, MotionSettings, Pose, PoseKey } from '../types';

export interface EngineProvider {
  id: 'inbetween' | 'physics' | 'owned_humanoid' | 'quadruped';
  kind: 'inbetween' | 'physics';
  name: string;
  learned: boolean;
  description: string;
  limits?: { maxDuration?: number; humanoidOnly?: boolean; quadrupedOnly?: boolean; earthGravityOnly?: boolean; requiresFloorContact?: boolean };
}
export interface EngineStatus { application: string; providers: EngineProvider[]; busy: boolean }
export interface MotionFrame { time: number; pose: Pose }
export interface EngineResult { frames: MotionFrame[]; metrics?: Record<string, unknown>; warnings?: string[]; provider?: { id: string; name: string; learned: boolean } }
export interface MotionRequest {
  version: 1;
  kind: 'inbetween' | 'physics';
  provider: EngineProvider['id'];
  rig: { kind: CharacterAsset['kind']; names: string[]; parents: number[]; restPose: Pose };
  frames: MotionFrame[];
  anchors: MotionFrame[];
  fps: number;
  duration: number;
  settings: MotionSettings;
  seed: number;
}

function hierarchy(asset: CharacterAsset): number[] {
  const indices = new Map(asset.bones.map((bone, i) => [bone as THREE.Object3D, i]));
  return asset.bones.map(bone => {
    let parent = bone.parent;
    while (parent && !indices.has(parent)) parent = parent.parent;
    return parent ? indices.get(parent)! : -1;
  });
}

/** World transforms bridge source centimeters, bind hierarchies, and model meters. */
function normalizedPose(asset: CharacterAsset, parents: number[]): Pose {
  asset.root.updateMatrixWorld(true);
  const positions = asset.bones.map(bone => bone.getWorldPosition(new THREE.Vector3()));
  const rotations = asset.bones.map(bone => bone.getWorldQuaternion(new THREE.Quaternion()).normalize());
  return asset.bones.map((_, i) => {
    const parent = parents[i];
    const position = positions[i].clone();
    const rotation = rotations[i].clone();
    if (parent >= 0) {
      const inverse = rotations[parent].clone().invert();
      position.sub(positions[parent]).applyQuaternion(inverse);
      rotation.premultiply(inverse).normalize();
    }
    return { position: position.toArray(), quaternion: rotation.toArray(), scale: [1, 1, 1] };
  });
}

export function makeMotionRequest(asset: CharacterAsset, source: PoseKey[], anchors: PoseKey[], duration: number, settings: MotionSettings, provider: EngineProvider['id'], seed: number): MotionRequest {
  if (asset.kind === 'creature') throw new Error('Creature anatomy is not supported by the installed human / quadruped engines. Use imported motion or pose interpolation.');
  const saved = capturePose(asset);
  const parents = hierarchy(asset);
  const fps = 30;
  const kind = provider === 'physics' ? 'physics' : 'inbetween';
  const times = new Map<number, number>();
  for (let frame = 0; frame < Math.ceil(duration * fps); frame++) times.set(Math.fround(frame / fps), frame / fps);
  for (const key of anchors) times.set(Math.fround(key.time), key.time);
  times.set(0, 0); times.set(Math.fround(duration), duration);
  try {
    applyPose(asset, asset.restPose);
    const restPose = normalizedPose(asset, parents);
    const normalize = (pose: Pose) => { applyPose(asset, pose); return normalizedPose(asset, parents); };
    return {
      version: 1, kind, provider,
      rig: { kind: asset.kind, names: asset.bones.map(bone => bone.name), parents, restPose },
      frames: [...times.values()].sort((a, b) => a - b).map(time => ({ time, pose: normalize(samplePose(source, time, settings.interpolation)) })),
      anchors: anchors.map(key => ({ time: key.time, pose: normalize(key.pose) })),
      fps, duration, settings: { ...settings }, seed,
    };
  } finally { applyPose(asset, saved); }
}

/** Reapply only motion to the existing skeleton; meshes and skin bindings never change. */
export function restoreEngineFrames(asset: CharacterAsset, source: PoseKey[], anchors: PoseKey[], result: EngineResult, mode: InterpolationMode, duration: number, keepAnchors: boolean): PoseKey[] {
  if (!Array.isArray(result.frames) || result.frames.length < 2 || result.frames.length > 7201) throw new Error('The motion engine returned an incomplete animation.');
  const parents = hierarchy(asset), saved = capturePose(asset), keys: PoseKey[] = [];
  const shapes = createMorphKeySampler(source, mode, asset.restMorphs);
  let last = -1;
  try {
    for (const frame of result.frames) {
      if (!Number.isFinite(frame.time) || frame.time < 0 || frame.time > duration + 1e-4 || frame.time <= last || frame.pose.length !== asset.bones.length) throw new Error('The motion engine returned an invalid timeline. Your poses were kept.');
      last = frame.time;
      const positions: THREE.Vector3[] = [], rotations: THREE.Quaternion[] = [];
      for (let i = 0; i < frame.pose.length; i++) {
        const pose = frame.pose[i];
        if (!pose || pose.position?.length !== 3 || pose.quaternion?.length !== 4 || ![...pose.position, ...pose.quaternion].every(Number.isFinite)) throw new Error('The motion engine returned an invalid pose. Your poses were kept.');
        const position = new THREE.Vector3().fromArray(pose.position);
        const rotation = new THREE.Quaternion().fromArray(pose.quaternion).normalize();
        const parent = parents[i];
        if (parent >= 0) { position.applyQuaternion(rotations[parent]).add(positions[parent]); rotation.premultiply(rotations[parent]).normalize(); }
        positions.push(position); rotations.push(rotation);
      }
      // Source positions/scales carry animated root details and untouched fingers.
      applyPose(asset, samplePose(source, frame.time, mode));
      for (let i = 0; i < asset.bones.length; i++) {
        const bone = asset.bones[i];
        if (parents[i] < 0) bone.position.copy(bone.parent ? bone.parent.worldToLocal(positions[i].clone()) : positions[i]);
        const parentRotation = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
        bone.quaternion.copy(parentRotation.invert().multiply(rotations[i])).normalize();
        bone.updateWorldMatrix(false, true);
      }
      const authored = anchors.find(key => Math.abs(key.time - frame.time) < 1e-5);
      keys.push({ id: authored?.id || crypto.randomUUID(), time: authored?.time ?? Math.min(frame.time, duration), pose: keepAnchors && authored ? structuredClone(authored.pose) : capturePose(asset), label: authored?.label, ...shapes(frame.time) });
    }
    if (keys[0].time > 1e-4 || Math.abs(keys[keys.length - 1].time - duration) > 1e-4) throw new Error('The generated motion did not cover the complete animation. Your poses were kept.');
    if (keepAnchors) {
      for (const anchor of anchors) {
        if (!keys.some(key => Math.abs(key.time - anchor.time) < 1e-5)) keys.push(structuredClone(anchor));
      }
    }
    return keys.sort((a, b) => a.time - b.time);
  } finally { applyPose(asset, saved); }
}

async function jsonResponse(response: Response) {
  let data;
  try { data = await response.json(); } catch { throw new Error('The local motion engine is unavailable. Start Still with its launcher, then try again.'); }
  if (!response.ok) throw new Error(data.error || 'The local motion engine could not complete that request.');
  return data;
}

export async function getEngineStatus(): Promise<EngineStatus | null> {
  try {
    const data = await jsonResponse(await fetch('/api/engine', { signal: AbortSignal.timeout(8000) }));
    return data.application === 'still-engine' && Array.isArray(data.providers) ? data : null;
  } catch { return null; }
}


export async function generateMotion(request: MotionRequest, onProgress: (message: string, progress: number) => void, signal: AbortSignal): Promise<EngineResult> {
  let jobId: string | null = null;
  const cancel = () => { if (jobId) void fetch(`/api/engine/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    // Receive the job ID even if Cancel is clicked during submission, so it can be stopped.
    const job = await jsonResponse(await fetch('/api/engine/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) }));
    jobId = job.id;
    if (signal.aborted) { cancel(); throw new DOMException('Cancelled', 'AbortError'); }
    while (!signal.aborted) {
      const status = await jsonResponse(await fetch(`/api/engine/jobs/${jobId}`, { signal }));
      onProgress(status.message || 'Generating motion…', Number(status.progress) || 0);
      if (status.status === 'done') return status.result;
      if (status.status === 'error') throw new Error(status.error || 'The motion engine stopped before finishing.');
      if (status.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 500);
        signal.addEventListener('abort', aborted, { once: true });
      });
    }
    throw new DOMException('Cancelled', 'AbortError');
  } catch (error) { cancel(); throw error; }
  finally { signal.removeEventListener('abort', cancel); }
}
