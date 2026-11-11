import * as THREE from 'three';
import type { CharacterAsset, PoseKey, Vec3 } from '../types';
import { applyPose, capturePose } from './character';
import { solveIK, swingLimbPole } from './motion';

/** BlazePose landmark indices (anatomical left / right). */
export const LM = {
  nose: 0, leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30, leftFootIndex: 31, rightFootIndex: 32,
} as const;

/** Bone pairs worth drawing on the video preview skeleton. */
export const SKELETON_LINES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [7, 8], [0, 7], [0, 8],
];

const MIRROR_SWAP = (() => {
  const table = Array.from({ length: 33 }, (_, i) => i);
  const pairs: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
  for (const [a, b] of pairs) { table[a] = b; table[b] = a; }
  return table;
})();

export interface MocapFrame {
  time: number;
  /** World landmarks in meters, origin at the performer's hips. Null when no person was found. */
  world: Vec3[] | null;
  /** Normalized image landmarks for the preview overlay and floor travel. */
  image: { x: number; y: number }[] | null;
  visibility: number[] | null;
}
export interface MocapTake {
  name: string;
  duration: number;
  frames: MocapFrame[];
  width: number;
  height: number;
  detected: number;
}
export interface MocapRetargetOptions { mirror: boolean; travel: boolean; smoothing: number }

const ASSET_BASE = '/mocap/';
const MAX_FRAMES = 3600;

interface LandmarkLike { x: number; y: number; z: number; visibility?: number }
interface PoseResultLike { landmarks?: { x: number; y: number }[][]; worldLandmarks?: LandmarkLike[][] }
interface LandmarkerLike { detectForVideo: (frame: HTMLVideoElement, timestamp: number) => PoseResultLike }
interface VisionModuleLike {
  FilesetResolver: { forVisionTasks: (path: string) => Promise<unknown> };
  PoseLandmarker: { createFromOptions: (fileset: unknown, options: unknown) => Promise<LandmarkerLike> };
}

let landmarkerPromise: Promise<LandmarkerLike> | null = null;
let lastTimestamp = 0;
let timestampBase = 0;

/** MediaPipe needs strictly increasing millisecond stamps across every use of one landmarker. */
function stamp(mediaSeconds: number): number {
  let ts = Math.round(timestampBase + mediaSeconds * 1000);
  if (ts <= lastTimestamp) { timestampBase += lastTimestamp - ts + 1; ts = lastTimestamp + 1; }
  lastTimestamp = ts;
  return ts;
}

async function createLandmarker(): Promise<LandmarkerLike> {
  const vision = await import('@mediapipe/tasks-vision') as unknown as VisionModuleLike;
  const fileset = await vision.FilesetResolver.forVisionTasks(`${ASSET_BASE}wasm`);
  const options = (delegate: string) => ({
    baseOptions: { modelAssetPath: `${ASSET_BASE}pose_landmarker_full.task`, delegate },
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { return await vision.PoseLandmarker.createFromOptions(fileset, options('GPU')); }
  catch { return await vision.PoseLandmarker.createFromOptions(fileset, options('CPU')); }
}

/** The pose tracker, loaded once on first use. Retries are allowed after a failure. */
export function loadPoseLandmarker(): Promise<LandmarkerLike> {
  landmarkerPromise ??= createLandmarker().catch((error: unknown) => {
    landmarkerPromise = null;
    console.error('Motion capture failed to load.', error);
    throw new Error('The motion-capture tracker could not load. In a source build, run npm run mocap:assets, then reopen Still.');
  });
  return landmarkerPromise;
}

function toFrame(time: number, result: PoseResultLike): MocapFrame {
  const world = result.worldLandmarks?.[0];
  const image = result.landmarks?.[0];
  if (!world || world.length < 33 || !image) return { time, world: null, image: null, visibility: null };
  return {
    time,
    world: world.map(point => [point.x, point.y, point.z] satisfies Vec3),
    image: image.map(point => ({ x: point.x, y: point.y })),
    visibility: world.map(point => point.visibility ?? 1),
  };
}

function detectAt(landmarker: LandmarkerLike, video: HTMLVideoElement, mediaSeconds: number, time: number): MocapFrame {
  return toFrame(time, landmarker.detectForVideo(video, stamp(mediaSeconds)));
}

/** One live camera frame for the framing overlay. */
export async function detectLiveFrame(video: HTMLVideoElement, elapsedSeconds: number): Promise<MocapFrame> {
  const landmarker = await loadPoseLandmarker();
  return detectAt(landmarker, video, elapsedSeconds, elapsedSeconds);
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', fail); clearTimeout(timer); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('This video could not be read. Try an MP4 (H.264) or WebM file.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Reading this video stalled. Try a shorter clip or an MP4 (H.264) file.')); }, 10_000);
    video.addEventListener('seeked', done);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

/** Reads a whole video (or trimmed range) into landmarks, a few frames at a time, on this device. */
export async function analyzeVideo(video: HTMLVideoElement, options: { fps: number; start: number; end: number; name: string }, onProgress: (fraction: number, frame: MocapFrame) => void, signal: AbortSignal): Promise<MocapTake> {
  // Fresh camera recordings can report an endless duration; the caller's trim end is the fallback length.
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : options.end;
  if (!(duration > 0)) throw new Error('This video has no readable length. Try an MP4 (H.264) or WebM file.');
  const start = Math.max(0, options.start), end = Math.min(duration, options.end);
  if (!(end > start)) throw new Error('Choose a start time before the end time.');
  const step = 1 / Math.max(1, options.fps);
  const count = Math.floor((end - start) / step) + 1;
  if (count > MAX_FRAMES) throw new Error('That selection is too long to analyze at once. Trim it to about two minutes, or lower the sample rate.');
  const landmarker = await loadPoseLandmarker();
  video.pause();
  const frames: MocapFrame[] = [];
  for (let index = 0; index < count; index++) {
    if (signal.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    const at = Math.min(end, start + index * step);
    await seekTo(video, at);
    if (signal.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
    const frame = detectAt(landmarker, video, at, at - start);
    frames.push(frame);
    onProgress((index + 1) / count, frame);
  }
  const detected = frames.filter(frame => frame.world).length;
  if (detected < Math.max(3, count * 0.2)) throw new Error('Still could not find a person in this video. Use a clip where one whole body is clearly visible, head to feet.');
  return { name: options.name, duration: end - start, frames, width: video.videoWidth, height: video.videoHeight, detected };
}

// ---------------------------------------------------------------------------
// Smoothing and gap filling
// ---------------------------------------------------------------------------

/** One Euro filter (Casiez et al.): steady when still, responsive when moving. */
class OneEuro {
  private previous: number | null = null;
  private previousDerivative = 0;
  constructor(private minCutoff: number, private beta: number) {}
  filter(value: number, frequency: number): number {
    if (this.previous === null) { this.previous = value; return value; }
    const derivative = (value - this.previous) * frequency;
    const derivativeAlpha = 1 / (1 + 1 / (2 * Math.PI * 1) * frequency);
    this.previousDerivative += derivativeAlpha * (derivative - this.previousDerivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.previousDerivative);
    const alpha = 1 / (1 + frequency / (2 * Math.PI * cutoff));
    this.previous += alpha * (value - this.previous);
    return this.previous;
  }
}

interface PreparedFrame { time: number; world: Vec3[]; image: { x: number; y: number }[]; imageHip: { x: number; y: number } }

/** Fills short detection gaps, trims empty head / tail, then smooths. Times restart at the first seen frame. */
function prepareFrames(take: MocapTake, smoothing: number): { frames: PreparedFrame[]; duration: number; filledSeconds: number } {
  const valid = take.frames.map((frame, index) => frame.world && frame.image ? index : -1).filter(index => index >= 0);
  if (!valid.length) throw new Error('Still could not find a person in this video. Use a clip where one whole body is clearly visible, head to feet.');
  const first = valid[0], last = valid[valid.length - 1];
  const frames: PreparedFrame[] = [];
  let filled = 0;
  let upcoming = 0;
  for (let index = first; index <= last; index++) {
    while (valid[upcoming] < index) upcoming++;
    const frame = take.frames[index];
    if (frame.world && frame.image) {
      frames.push({ time: frame.time - take.frames[first].time, world: frame.world.map(point => [...point] as Vec3), image: frame.image.map(p => ({ ...p })), imageHip: hipImageOf(frame.image) });
      continue;
    }
    const prev = take.frames[valid[upcoming - 1]], next = take.frames[valid[upcoming]];
    const span = next.time - prev.time, u = span > 0 ? (frame.time - prev.time) / span : 0;
    const prevHip = hipImageOf(prev.image!), nextHip = hipImageOf(next.image!);
    filled += 1;
    frames.push({
      time: frame.time - take.frames[first].time,
      world: prev.world!.map((point, i) => point.map((value, axis) => value + (next.world![i][axis] - value) * u) as Vec3),
      image: prev.image!.map((p, i) => ({ x: p.x + (next.image![i].x - p.x) * u, y: p.y + (next.image![i].y - p.y) * u })),
      imageHip: { x: prevHip.x + (nextHip.x - prevHip.x) * u, y: prevHip.y + (nextHip.y - prevHip.y) * u },
    });
  }
  const dt = frames.length > 1 ? (frames.at(-1)!.time - frames[0].time) / (frames.length - 1) : 1 / 15;
  const frequency = dt > 0 ? 1 / dt : 15;
  const minCutoff = 2.5 - 2.1 * Math.max(0, Math.min(1, smoothing));
  const beta = 0.4 - 0.32 * Math.max(0, Math.min(1, smoothing));
  const filters = Array.from({ length: 33 }, () => [new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)]);
  const imageFilters = Array.from({ length: 33 }, () => [new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)]);
  const hipFilters = [new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)];
  for (const frame of frames) {
    frame.world = frame.world.map((point, i) => point.map((value, axis) => filters[i][axis].filter(value, frequency)) as Vec3);
    frame.image = frame.image.map((p, i) => ({ x: imageFilters[i][0].filter(p.x, frequency), y: imageFilters[i][1].filter(p.y, frequency) }));
    frame.imageHip = { x: hipFilters[0].filter(frame.imageHip.x, frequency), y: hipFilters[1].filter(frame.imageHip.y, frequency) };
  }
  return { frames, duration: frames.at(-1)!.time, filledSeconds: filled * dt };
}

const hipImageOf = (image: { x: number; y: number }[]) => ({ x: (image[LM.leftHip].x + image[LM.rightHip].x) / 2, y: (image[LM.leftHip].y + image[LM.rightHip].y) / 2 });

// ---------------------------------------------------------------------------
// Humanoid joint roles
// ---------------------------------------------------------------------------

interface SideBones { shoulder: number | null; arm: number; foreArm: number; hand: number; upLeg: number; leg: number; foot: number; toe: number | null }
export interface HumanoidBones { hips: number; spine: number[]; neck: number | null; head: number; left: SideBones; right: SideBones }

const normalizeBone = (name: string) => name.replace(/^.*[|:]/, '').replace(/^(mixamorig\d*|cc_base|bip\d*|def)[_ -]?/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SIDE_PARTS: [keyof SideBones, RegExp][] = [
  ['foreArm', /^(forearm|forarm|lowerarm|lowarm|elbow|armfore)$/],
  ['shoulder', /^(shoulder|clavicle|collar|clav)$/],
  ['arm', /^(arm|upperarm|uparm|armup|humerus)$/],
  ['hand', /^(hand|wrist)$/],
  ['upLeg', /^(upleg|upperleg|thigh|legup|femur)$/],
  ['leg', /^(leg|calf|shin|lowerleg|leglower|knee)$/],
  ['foot', /^(foot|ankle)$/],
  ['toe', /^(toe|toebase|toeball|ball|toes|toe0|toe1)$/],
];

function sideOf(normalized: string): { side: 'left' | 'right'; rest: string } | null {
  if (normalized.startsWith('left')) return { side: 'left', rest: normalized.slice(4) };
  if (normalized.startsWith('right')) return { side: 'right', rest: normalized.slice(5) };
  if (normalized.endsWith('left')) return { side: 'left', rest: normalized.slice(0, -4) };
  if (normalized.endsWith('right')) return { side: 'right', rest: normalized.slice(0, -5) };
  // Unreal-style suffixes (thigh_l) and prefixes (l_thigh), only when the rest is a known part.
  const tail = normalized.at(-1), head = normalized.at(0);
  if ((tail === 'l' || tail === 'r') && SIDE_PARTS.some(([, pattern]) => pattern.test(normalized.slice(0, -1)))) return { side: tail === 'l' ? 'left' : 'right', rest: normalized.slice(0, -1) };
  if ((head === 'l' || head === 'r') && SIDE_PARTS.some(([, pattern]) => pattern.test(normalized.slice(1)))) return { side: head === 'l' ? 'left' : 'right', rest: normalized.slice(1) };
  return null;
}

/** Finds the joints motion capture drives. Exact role names only, so twist and helper joints are left alone. */
export function findHumanoidBones(asset: CharacterAsset): { bones: HumanoidBones | null; missing: string[] } {
  const found: Partial<Record<string, number>> = {};
  const spineChain: number[] = [];
  asset.bones.forEach((bone, index) => {
    const name = normalizeBone(bone.name);
    const sided = sideOf(name);
    if (sided) {
      const part = SIDE_PARTS.find(([, pattern]) => pattern.test(sided.rest))?.[0];
      if (part && found[`${sided.side}.${part}`] === undefined) found[`${sided.side}.${part}`] = index;
      return;
    }
    if (/^(hips|pelvis|hip)$/.test(name)) found.hips ??= index;
    else if (/^spine\d*$|^chest$|^upperchest$|^abdomen$/.test(name)) spineChain.push(index);
    else if (/^neck\d*$/.test(name)) found.neck ??= index;
    else if (name === 'head') found.head ??= index;
  });
  // Order the spine from the hips upward by hierarchy depth.
  const depth = (index: number) => { let level = 0, node: THREE.Object3D | null = asset.bones[index]; while (node?.parent) { level++; node = node.parent; } return level; };
  spineChain.sort((a, b) => depth(a) - depth(b));
  const side = (which: 'left' | 'right'): { bones: SideBones | null; missing: string[] } => {
    const need: [keyof SideBones, string][] = [['arm', 'upper arm'], ['foreArm', 'forearm'], ['hand', 'hand'], ['upLeg', 'thigh'], ['leg', 'shin'], ['foot', 'foot']];
    const missing = need.filter(([part]) => found[`${which}.${part}`] === undefined).map(([, label]) => `${which} ${label}`);
    if (missing.length) return { bones: null, missing };
    return {
      bones: {
        shoulder: found[`${which}.shoulder`] ?? null, arm: found[`${which}.arm`]!, foreArm: found[`${which}.foreArm`]!, hand: found[`${which}.hand`]!,
        upLeg: found[`${which}.upLeg`]!, leg: found[`${which}.leg`]!, foot: found[`${which}.foot`]!, toe: found[`${which}.toe`] ?? null,
      },
      missing: [],
    };
  };
  const left = side('left'), right = side('right');
  const missing = [...left.missing, ...right.missing];
  if (found.hips === undefined) missing.push('hips');
  if (found.head === undefined) missing.push('head');
  if (!spineChain.length) missing.push('spine');
  if (missing.length || !left.bones || !right.bones) return { bones: null, missing };
  return { bones: { hips: found.hips!, spine: spineChain, neck: found.neck ?? null, head: found.head!, left: left.bones, right: right.bones }, missing: [] };
}

// ---------------------------------------------------------------------------
// Retarget landmarks onto the character
// ---------------------------------------------------------------------------

const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0;

/** Orthonormal frame from a left-pointing axis and an up axis, as a quaternion. Null when parallel. */
function basisFromRightUp(right: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion | null {
  const x = right.clone();
  if (x.lengthSq() < 1e-12) return null;
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, up);
  if (z.lengthSq() < 1e-12) return null;
  z.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Orthonormal frame from a left-pointing axis and a forward axis (the head). */
function basisFromRightForward(right: THREE.Vector3, forward: THREE.Vector3): THREE.Quaternion | null {
  const x = right.clone();
  if (x.lengthSq() < 1e-12) return null;
  x.normalize();
  const z = forward.clone().addScaledVector(x, -forward.dot(x));
  if (z.lengthSq() < 1e-12) return null;
  z.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function setWorldRotation(asset: CharacterAsset, boneIndex: number, desiredWorld: THREE.Quaternion): void {
  const bone = asset.bones[boneIndex];
  const parentRotation = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  bone.quaternion.copy(parentRotation.invert().multiply(desiredWorld)).normalize();
  asset.root.updateMatrixWorld(true);
}

function setWorldPosition(asset: CharacterAsset, boneIndex: number, world: THREE.Vector3): void {
  const bone = asset.bones[boneIndex];
  bone.position.copy(bone.parent ? bone.parent.worldToLocal(world.clone()) : world);
  asset.root.updateMatrixWorld(true);
}

/** Swings a bone (never rolls it) so the direction toward its child matches a desired world direction. */
function aimBone(asset: CharacterAsset, boneIndex: number, childIndex: number, desiredDirection: THREE.Vector3): void {
  const bone = asset.bones[boneIndex];
  const origin = bone.getWorldPosition(new THREE.Vector3());
  const current = asset.bones[childIndex].getWorldPosition(new THREE.Vector3()).sub(origin);
  if (current.lengthSq() < 1e-12 || desiredDirection.lengthSq() < 1e-12) return;
  current.normalize();
  const wanted = desiredDirection.clone().normalize();
  const swing = current.dot(wanted) < -1 + 1e-9
    ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().crossVectors(current, Math.abs(current.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize(), Math.PI)
    : new THREE.Quaternion().setFromUnitVectors(current, wanted);
  const parentRotation = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  bone.quaternion.premultiply(parentRotation.clone().invert().multiply(swing).multiply(parentRotation)).normalize();
  asset.root.updateMatrixWorld(true);
}

export function retargetMocap(asset: CharacterAsset, take: MocapTake, options: MocapRetargetOptions): { keys: PoseKey[]; duration: number; warnings: string[] } {
  const { bones, missing } = findHumanoidBones(asset);
  if (!bones) throw new Error(`Motion capture copies a person, so it needs a person-shaped rig. This character is missing: ${missing.slice(0, 6).join(', ')}.`);
  const prepared = prepareFrames(take, options.smoothing);
  if (prepared.frames.length < 2) throw new Error('That clip is too short to copy. Use at least a second of visible movement.');
  const mirror = options.mirror;
  const point = (frame: PreparedFrame, index: number): THREE.Vector3 => {
    const source = frame.world[mirror ? MIRROR_SWAP[index] : index];
    // MediaPipe world space (x right, y down, z away from camera) into Still space (y up, z toward viewer).
    return new THREE.Vector3(mirror ? -source[0] : source[0], -source[1], -source[2]);
  };
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  const chain = (frame: PreparedFrame, a: number, b: number, c: number) => point(frame, a).distanceTo(point(frame, b)) + point(frame, b).distanceTo(point(frame, c));

  const measureLimbs = () => ({
    leg: { left: median(prepared.frames.map(f => chain(f, LM.leftHip, LM.leftKnee, LM.leftAnkle))), right: median(prepared.frames.map(f => chain(f, LM.rightHip, LM.rightKnee, LM.rightAnkle))) },
    arm: { left: median(prepared.frames.map(f => chain(f, LM.leftShoulder, LM.leftElbow, LM.leftWrist))), right: median(prepared.frames.map(f => chain(f, LM.rightShoulder, LM.rightElbow, LM.rightWrist))) },
    torso: median(prepared.frames.map(f => mid(point(f, LM.leftShoulder), point(f, LM.rightShoulder)).distanceTo(mid(point(f, LM.leftHip), point(f, LM.rightHip))))),
  });
  const heightFrom = (measured: ReturnType<typeof measureLimbs>) => Math.max(0.5, (measured.leg.left + measured.leg.right) / 2 + measured.torso + median(prepared.frames.map(f => point(f, LM.nose).distanceTo(mid(point(f, LM.leftShoulder), point(f, LM.rightShoulder))))) * 1.25);
  const legSpan = (frame: PreparedFrame) => Math.max(point(frame, LM.leftHip).y - point(frame, LM.leftAnkle).y, point(frame, LM.rightHip).y - point(frame, LM.rightAnkle).y);
  const provisionalHeight = heightFrom(measureLimbs());
  const imageHeights = take.frames.flatMap(frame => frame.image ? [Math.max(frame.image[LM.leftAnkle].y, frame.image[LM.rightAnkle].y) - frame.image[LM.nose].y] : []);
  const imageHeightFraction = Math.max(0.15, Math.min(1, median(imageHeights) || 0.8));

  // BlazePose world Y compresses vertical extremes (overhead hands read ~40% low),
  // while image-plane Y is pixel-true. Stretch world Y toward the image measurement
  // where the image reaches farther, so raised arms and jumps keep their height.
  const metersPerImageY = provisionalHeight / imageHeightFraction;
  for (const frame of prepared.frames) {
    const hipMediaY = (frame.world[LM.leftHip][1] + frame.world[LM.rightHip][1]) / 2;
    frame.world = frame.world.map((landmark, i) => {
      const upWorld = -(landmark[1] - hipMediaY);
      const upImage = (frame.imageHip.y - frame.image[i].y) * metersPerImageY;
      if (Math.abs(upImage) <= Math.abs(upWorld)) return landmark;
      const limit = Math.abs(upWorld) * 1.8 + 0.1;
      const stretched = Math.sign(upImage) * Math.min(Math.abs(upWorld + (upImage - upWorld) * 0.65), limit);
      return [landmark[0], hipMediaY - stretched, landmark[2]] as Vec3;
    });
  }
  // Calibrate IK from the same corrected coordinates the limb targets use.
  const corrected = measureLimbs();
  const perfLeg = corrected.leg;
  const perfArm = corrected.arm;
  const perfHeight = heightFrom(corrected);
  // A straight leg's anatomical length is the standing reference, so a take that
  // never stands up stays crouched instead of normalizing itself to standing height.
  const standingSpan = Math.max(0.05, (perfLeg.left + perfLeg.right) / 2);
  // The grounded reference is a near-straight frame whose hips sit lowest in the
  // image. A straight airborne frame can otherwise win by a rounding error.
  const straightFrames = prepared.frames.filter(frame => legSpan(frame) >= standingSpan * 0.95);
  const verticalCandidates = straightFrames.length ? straightFrames : prepared.frames;
  const verticalReference = verticalCandidates.reduce((best, frame) => frame.imageHip.y > best.imageHip.y ? frame : best, verticalCandidates[0]);
  const verticalReferenceSpan = legSpan(verticalReference);
  const aspect = take.width > 0 && take.height > 0 ? take.width / take.height : 16 / 9;

  const saved = capturePose(asset);
  try {
    applyPose(asset, asset.restPose);
    const restWorld = asset.bones.map(bone => bone.getWorldPosition(new THREE.Vector3()));
    const restQuat = asset.bones.map(bone => bone.getWorldQuaternion(new THREE.Quaternion()));
    const chestBone = bones.spine[bones.spine.length - 1];
    const scaleFor = (character: number, performer: number) => performer > 1e-6 ? character / performer : 1;
    const legScale = {
      left: scaleFor(restWorld[bones.left.upLeg].distanceTo(restWorld[bones.left.leg]) + restWorld[bones.left.leg].distanceTo(restWorld[bones.left.foot]), perfLeg.left),
      right: scaleFor(restWorld[bones.right.upLeg].distanceTo(restWorld[bones.right.leg]) + restWorld[bones.right.leg].distanceTo(restWorld[bones.right.foot]), perfLeg.right),
    };
    const armScale = {
      left: scaleFor(restWorld[bones.left.arm].distanceTo(restWorld[bones.left.foreArm]) + restWorld[bones.left.foreArm].distanceTo(restWorld[bones.left.hand]), perfArm.left),
      right: scaleFor(restWorld[bones.right.arm].distanceTo(restWorld[bones.right.foreArm]) + restWorld[bones.right.foreArm].distanceTo(restWorld[bones.right.hand]), perfArm.right),
    };
    const restPelvisBasis = basisFromRightUp(restWorld[bones.left.upLeg].clone().sub(restWorld[bones.right.upLeg]), restWorld[chestBone].clone().sub(restWorld[bones.hips])) ?? new THREE.Quaternion();
    const restChestBasis = basisFromRightUp(restWorld[bones.left.arm].clone().sub(restWorld[bones.right.arm]), restWorld[bones.neck ?? bones.head].clone().sub(restWorld[chestBone])) ?? restPelvisBasis.clone();
    const restHipWorld = restWorld[bones.hips].clone();
    const restClearance = Math.min(restWorld[bones.left.foot].y, restWorld[bones.right.foot].y);
    const travelAxis = restWorld[bones.left.upLeg].clone().sub(restWorld[bones.right.upLeg]).setY(0);
    if (travelAxis.lengthSq() < 1e-12) travelAxis.set(1, 0, 0); else travelAxis.normalize();
    const globalScale = scaleFor(Math.max(0.1, asset.height), perfHeight);
    const firstHip = prepared.frames[0].imageHip;
    const worldOf = (index: number) => asset.bones[index].getWorldPosition(new THREE.Vector3());
    const yawOf = (basis: THREE.Quaternion) => { const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(basis); return Math.atan2(forward.x, forward.z); };
    const sides = [
      { bones: bones.left, shoulder: LM.leftShoulder, elbow: LM.leftElbow, wrist: LM.leftWrist, hip: LM.leftHip, knee: LM.leftKnee, ankle: LM.leftAnkle, heel: LM.leftHeel, toe: LM.leftFootIndex, armScale: armScale.left, legScale: legScale.left },
      { bones: bones.right, shoulder: LM.rightShoulder, elbow: LM.rightElbow, wrist: LM.rightWrist, hip: LM.rightHip, knee: LM.rightKnee, ankle: LM.rightAnkle, heel: LM.rightHeel, toe: LM.rightFootIndex, armScale: armScale.right, legScale: legScale.right },
    ] as const;

    const keys: PoseKey[] = [];
    let previous = asset.restPose;
    for (const frame of prepared.frames) {
      applyPose(asset, previous);
      const hipCenter = mid(point(frame, LM.leftHip), point(frame, LM.rightHip));
      const shoulderCenter = mid(point(frame, LM.leftShoulder), point(frame, LM.rightShoulder));
      const earCenter = mid(point(frame, LM.leftEar), point(frame, LM.rightEar));

      const hipTarget = restHipWorld.clone();
      const span = legSpan(frame);
      // Leg extension gives crouch depth. Image hip motion beyond the signed
      // extension change from the reference frame is airborne travel, which
      // hip-relative world landmarks cannot express. Signed matters when the
      // reference is itself a crouch (no standing frame in the take):
      // straightening raises the hips in the image by the same leg extension
      // the span ratio below already adds, so counting it again would float
      // a grounded squat pulse into a jump.
      const extensionMeters = span - verticalReferenceSpan;
      const imageRiseMeters = (verticalReference.imageHip.y - frame.imageHip.y) * metersPerImageY;
      const airborneMeters = THREE.MathUtils.clamp(imageRiseMeters - extensionMeters, 0, 1);
      hipTarget.y = restHipWorld.y * THREE.MathUtils.clamp(span / standingSpan, 0.35, 1.08) + airborneMeters * globalScale;
      if (options.travel) {
        const dxMeters = (frame.imageHip.x - firstHip.x) * perfHeight * aspect / imageHeightFraction;
        hipTarget.addScaledVector(travelAxis, (mirror ? -dxMeters : dxMeters) * globalScale);
      }
      setWorldPosition(asset, bones.hips, hipTarget);

      const pelvisBasis = basisFromRightUp(point(frame, LM.leftHip).sub(point(frame, LM.rightHip)), shoulderCenter.clone().sub(hipCenter));
      const pelvisDelta = pelvisBasis ? pelvisBasis.clone().multiply(restPelvisBasis.clone().invert()) : null;
      if (pelvisDelta) setWorldRotation(asset, bones.hips, pelvisDelta.clone().multiply(restQuat[bones.hips]));

      const chestBasis = basisFromRightUp(point(frame, LM.leftShoulder).sub(point(frame, LM.rightShoulder)), earCenter.clone().sub(shoulderCenter));
      const chestDelta = chestBasis ? chestBasis.clone().multiply(restChestBasis.clone().invert()) : pelvisDelta;
      if (chestDelta) bones.spine.forEach((boneIndex, position) => {
        const blend = (position + 1) / (bones.spine.length + 1);
        const delta = pelvisDelta ? pelvisDelta.clone().slerp(chestDelta, blend) : chestDelta.clone();
        setWorldRotation(asset, boneIndex, delta.multiply(restQuat[boneIndex]));
      });

      const headBasis = basisFromRightForward(point(frame, LM.leftEar).sub(point(frame, LM.rightEar)), point(frame, LM.nose).sub(earCenter));
      const headDelta = headBasis ? headBasis.clone().multiply(restChestBasis.clone().invert()) : chestDelta;
      if (headDelta) {
        if (bones.neck !== null) {
          const neckDelta = (chestDelta ? chestDelta.clone().slerp(headDelta, 0.5) : headDelta.clone());
          setWorldRotation(asset, bones.neck, neckDelta.multiply(restQuat[bones.neck]));
        }
        setWorldRotation(asset, bones.head, headDelta.clone().multiply(restQuat[bones.head]));
      }

      for (const side of sides) {
        const shoulderJoint = worldOf(side.bones.arm);
        solveIK(asset, side.bones.hand, shoulderJoint.clone().add(point(frame, side.wrist).sub(point(frame, side.shoulder)).multiplyScalar(side.armScale)));
        swingLimbPole(asset, side.bones.foreArm, shoulderJoint.clone().add(point(frame, side.elbow).sub(point(frame, side.shoulder)).multiplyScalar(side.armScale)));
        const hipJoint = worldOf(side.bones.upLeg);
        solveIK(asset, side.bones.foot, hipJoint.clone().add(point(frame, side.ankle).sub(point(frame, side.hip)).multiplyScalar(side.legScale)));
        swingLimbPole(asset, side.bones.leg, hipJoint.clone().add(point(frame, side.knee).sub(point(frame, side.hip)).multiplyScalar(side.legScale)));
        if (side.bones.toe !== null && pelvisBasis) {
          const charBasis = basisFromRightUp(worldOf(bones.left.upLeg).sub(worldOf(bones.right.upLeg)), worldOf(chestBone).sub(worldOf(bones.hips)));
          if (charBasis) aimBone(asset, side.bones.foot, side.bones.toe, point(frame, side.toe).sub(point(frame, side.heel)).applyAxisAngle(new THREE.Vector3(0, 1, 0), yawOf(charBasis) - yawOf(pelvisBasis)));
        }
      }
      const pose = capturePose(asset);
      keys.push({ id: crypto.randomUUID(), time: frame.time, pose });
      previous = pose;
    }

    // Keep feet out of the floor when the hip-height estimate runs low.
    for (const key of keys) {
      applyPose(asset, key.pose);
      const lowest = Math.min(worldOf(bones.left.foot).y, worldOf(bones.right.foot).y);
      if (lowest < restClearance - 1e-4) {
        setWorldPosition(asset, bones.hips, worldOf(bones.hips).add(new THREE.Vector3(0, restClearance - lowest, 0)));
        key.pose = capturePose(asset);
      }
    }

    const warnings: string[] = [];
    if (prepared.filledSeconds > 0.3) warnings.push(`Filled about ${prepared.filledSeconds.toFixed(1)}s where the tracker lost you.`);
    if (options.travel) warnings.push('Side-to-side travel is kept. Walking toward or away from the camera stays in place.');
    const step = prepared.frames.length > 1 ? prepared.duration / (prepared.frames.length - 1) : 1 / 15;
    return { keys, duration: Math.max(prepared.duration, step), warnings };
  } finally { applyPose(asset, saved); }
}
