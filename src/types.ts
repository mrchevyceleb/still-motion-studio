import type * as THREE from 'three';

export type RigKind = 'humanoid' | 'quadruped';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface BonePose { position: Vec3; quaternion: Quat; scale: Vec3 }
export type Pose = BonePose[];
export interface PoseKey { id: string; time: number; pose: Pose; label?: string }
export interface MotionGeneration { name: string; kind: 'inbetween' | 'physics'; metrics: Record<string, unknown>; warnings: string[]; comparison?: { before: PoseKey[]; interpolation: InterpolationMode } }
export type InterpolationMode = 'smooth' | 'linear' | 'stepped';
export interface MotionSettings { interpolation: InterpolationMode; floorContact: boolean; gravity: number; strength: number }
export interface CharacterAsset {
  root: THREE.Group;
  bones: THREE.Bone[];
  restPose: Pose;
  clips: THREE.AnimationClip[];
  kind: RigKind;
  name: string;
  source: 'demo' | 'import';
  rigged: boolean;
  height: number;
  warnings: string[];
}
export interface ProjectDocument {
  version: 1;
  name: string;
  duration: number;
  fps: number;
  keys: PoseKey[];
  generated?: PoseKey[];
  generation?: MotionGeneration;
  settings: MotionSettings;
  boneNames: string[];
  sourceClip?: number | null;
  character: { type: 'demo'; kind: RigKind } | { type: 'embedded'; object: unknown; kind: RigKind; name: string };
}
export const DEFAULT_SETTINGS: MotionSettings = { interpolation: 'smooth', floorContact: false, gravity: 9.81, strength: 0.7 };
