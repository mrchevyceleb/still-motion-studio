import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { solveIK } from './motion';
import { resolveBone } from './agentPose';
import { clipAdvice, contactModel } from './bodyContact';
import type { CharacterAsset, Pose, Vec3 } from '../types';

/**
 * Intent-level posing for agents. Everything is expressed in CHARACTER space:
 * [right, up, forward] in editor meters, measured from the floor point under the
 * hips and turned with the hips' heading. Rotations use named body axes instead
 * of local bone axes, so the same instruction works on Mixamo, Unreal and Still rigs.
 */

type Q = THREE.Quaternion;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const WORLD_UP = V(0, 1, 0);
const round = (n: number, step = 100) => Math.round(n * step) / step;
const deg = THREE.MathUtils.radToDeg;
const rad = THREE.MathUtils.degToRad;

/* ------------------------------------------------------------------ parts */

const IGNORED = /^(end|tip|nub|leaf|twist|roll|ik|fk|pole|target|helper|corrective|socket|ctrl|share|top|null|dummy|offset|aux|scale|bend|prop|weapon|attach)$/;
const PREFIX = new Set(['def', 'mch', 'org', 'bip', 'bip01', 'bip001', 'bn', 'jnt', 'j', 'b', 'mixamorig', 'cc', 'base_']);
const SIDE: Record<string, 'left' | 'right'> = { left: 'left', l: 'left', lf: 'left', lft: 'left', right: 'right', r: 'right', rt: 'right', rgt: 'right' };
const PAIR: Record<string, 'front' | 'hind'> = { front: 'front', fore: 'front', frnt: 'front', back: 'hind', hind: 'hind', rear: 'hind' };

function tokens(name: string): string[] {
  return (name.split(/[:|]/).pop() ?? name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

interface NameInfo { side?: 'left' | 'right'; pair?: 'front' | 'hind'; base: string; quadBase: string; ignored: boolean }
function nameInfo(name: string): NameInfo {
  const all = tokens(name);
  let side: NameInfo['side'], pair: NameInfo['pair'];
  const rest: string[] = [];
  all.forEach((token, index) => {
    if (SIDE[token] && !side) { side = SIDE[token]; return; }
    if (index === 0 && PREFIX.has(token) && all.length > 1) return;
    rest.push(token);
  });
  // "ForeArm" is a human forearm; only a separate front/hind token marks a quadruped leg pair.
  const quad = rest.filter(token => { if (PAIR[token] && !pair) { pair = PAIR[token]; return false; } return true; });
  return { side, pair, base: rest.join(''), quadBase: quad.join(''), ignored: rest.some(token => IGNORED.test(token)) };
}

const HUMAN_LIMB: [string, RegExp][] = [
  ['Shoulder', /^(clavicle|shoulder|collar|collarbone)$/],
  ['UpperArm', /^(upperarm|arm|uparm|humerus)$/],
  ['Forearm', /^(forearm|lowerarm|elbow)$/],
  ['Hand', /^(hand|wrist)$/],
  ['Thigh', /^(upleg|upperleg|thigh|hip)$/],
  ['Shin', /^(leg|lowerleg|calf|shin|knee)$/],
  ['Foot', /^(foot|ankle)$/],
  ['Toe', /^(toe0?|toes|toebase|ball)$/],
];
const QUAD_LIMB: [string, RegExp][] = [
  ['Upper', /(upper|thigh|humerus|upleg)/],
  ['Lower', /(lower|shin|calf|knee|forearm)/],
  ['Foot', /(foot|paw|hoof)/],
];
const SPINE = /^(spine\d*|chest|upperchest|torso|abdomen\d*|ribcage|waist)$/;

export const PART_ALIASES: Record<string, string> = {
  pelvis: 'hips', root: 'hips', body: 'torso', back: 'torso', upperChest: 'chest',
  leftClavicle: 'leftShoulder', rightClavicle: 'rightShoulder', leftArm: 'leftUpperArm', rightArm: 'rightUpperArm',
  leftElbow: 'leftForearm', rightElbow: 'rightForearm', leftLowerArm: 'leftForearm', rightLowerArm: 'rightForearm',
  leftWrist: 'leftHand', rightWrist: 'rightHand', leftLeg: 'leftThigh', rightLeg: 'rightThigh', leftUpperLeg: 'leftThigh', rightUpperLeg: 'rightThigh',
  leftKnee: 'leftShin', rightKnee: 'rightShin', leftCalf: 'leftShin', rightCalf: 'rightShin', leftLowerLeg: 'leftShin', rightLowerLeg: 'rightShin',
  leftAnkle: 'leftFoot', rightAnkle: 'rightFoot', leftToes: 'leftToe', rightToes: 'rightToe',
};

export interface BodyParts {
  roles: Record<string, number>;
  torso: number[];
  feet: number[];
  limbs: { end: string; upper: number; mid: number; tip: number; pole: 'forward' | 'back' }[];
}

function depth(bone: THREE.Object3D): number { let d = 0; for (let p = bone.parent; p instanceof THREE.Bone; p = p.parent) d++; return d; }
function isAncestor(asset: CharacterAsset, ancestor: number, child: number): boolean {
  for (let p: THREE.Object3D | null = asset.bones[child]; p; p = p.parent) if (p === asset.bones[ancestor]) return true;
  return false;
}

const cache = new WeakMap<CharacterAsset, BodyParts>();
export function bodyParts(asset: CharacterAsset): BodyParts {
  const cached = cache.get(asset);
  if (cached && Object.values(cached.roles).every(i => i < asset.bones.length)) return cached;
  const roles: Record<string, number> = {};
  const claim = (role: string, index: number) => {
    if (roles[role] === undefined || depth(asset.bones[index]) < depth(asset.bones[roles[role]])) roles[role] = index;
  };
  const spine: number[] = [], necks: number[] = [], tails: number[] = [];
  asset.bones.forEach((bone, index) => {
    const info = nameInfo(bone.name);
    if (info.ignored || !info.base) return;
    if (!info.side) {
      if (/^(hips|pelvis)$/.test(info.base)) claim('hips', index);
      else if (SPINE.test(info.base)) spine.push(index);
      else if (/^neck\d*$/.test(info.base)) necks.push(index);
      else if (/^head$/.test(info.base)) claim('head', index);
      else if (/^tail(base|root|start|mid|middle|\d+)*$/.test(info.base)) tails.push(index);
      return;
    }
    const human = HUMAN_LIMB.find(([, pattern]) => pattern.test(info.base));
    if (human) { claim(`${info.side}${human[0]}`, index); return; }
    if (info.pair) {
      const quad = QUAD_LIMB.find(([, pattern]) => pattern.test(info.quadBase));
      if (quad) claim(`${info.pair}${info.side === 'left' ? 'Left' : 'Right'}${quad[0]}`, index);
    }
  });
  if (roles.hips === undefined) {
    const root = asset.bones.findIndex(bone => !(bone.parent instanceof THREE.Bone));
    if (root >= 0 && (spine.length || roles.head !== undefined)) roles.hips = root;
  }
  const byDepth = (list: number[]) => [...list].sort((a, b) => depth(asset.bones[a]) - depth(asset.bones[b]));
  const top = roles.head ?? byDepth(necks)[0];
  const torso = byDepth(spine).filter(index => top === undefined || isAncestor(asset, index, top));
  if (torso.length) { roles.spine = torso[0]; roles.chest = torso[torso.length - 1]; }
  if (necks.length) roles.neck = byDepth(necks)[0];
  if (tails.length) { const t = byDepth(tails); roles.tail = t[0]; roles.tailTip = t[t.length - 1]; }
  // Quaternius-style quadrupeds sometimes lack the pair token on the hind leg.
  const limbs: BodyParts['limbs'] = [];
  for (const side of ['left', 'right'] as const) {
    const S = side === 'left' ? 'Left' : 'Right';
    if (roles[`${side}UpperArm`] !== undefined && roles[`${side}Forearm`] !== undefined && roles[`${side}Hand`] !== undefined) limbs.push({ end: `${side}Hand`, upper: roles[`${side}UpperArm`], mid: roles[`${side}Forearm`], tip: roles[`${side}Hand`], pole: 'back' });
    if (roles[`${side}Thigh`] !== undefined && roles[`${side}Shin`] !== undefined && roles[`${side}Foot`] !== undefined) limbs.push({ end: `${side}Foot`, upper: roles[`${side}Thigh`], mid: roles[`${side}Shin`], tip: roles[`${side}Foot`], pole: 'forward' });
    for (const pair of ['front', 'hind'] as const) {
      const p = `${pair}${S}`;
      if (roles[`${p}Upper`] !== undefined && roles[`${p}Lower`] !== undefined && roles[`${p}Foot`] !== undefined) limbs.push({ end: `${p}Foot`, upper: roles[`${p}Upper`], mid: roles[`${p}Lower`], tip: roles[`${p}Foot`], pole: pair === 'front' ? 'forward' : 'back' });
    }
  }
  const feet = limbs.filter(limb => /Foot$/.test(limb.end)).map(limb => limb.tip);
  const parts = { roles, torso, feet, limbs };
  cache.set(asset, parts);
  return parts;
}

/** A part is a body role ("leftHand", "torso"), an alias, an exact bone name, or a bone index. */
export function resolvePart(asset: CharacterAsset, part: unknown): { name: string; bones: number[] } {
  const parts = bodyParts(asset);
  if (typeof part === 'string') {
    const role = PART_ALIASES[part] ?? part;
    if (role === 'torso') {
      if (!parts.torso.length) throw new Error('This rig has no recognizable spine bones for "torso". Use a bone name.');
      return { name: 'torso', bones: parts.torso };
    }
    if (parts.roles[role] !== undefined) return { name: role, bones: [parts.roles[role]] };
  }
  try {
    const index = resolveBone(asset, part as number | string);
    const role = Object.entries(parts.roles).find(([, i]) => i === index)?.[0];
    return { name: role ?? asset.bones[index].name, bones: [index] };
  } catch {
    throw new Error(`Unknown body part "${String(part)}". Available parts: ${['torso', ...Object.keys(parts.roles)].join(', ')}; exact bone names and indices also work.`);
  }
}

/* ------------------------------------------------------------------ frame */

export interface BodyFrame { origin: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3 }
const worldPos = (bone: THREE.Object3D) => bone.getWorldPosition(V());
const worldQuat = (bone: THREE.Object3D) => bone.getWorldQuaternion(new THREE.Quaternion());
const flat = (v: THREE.Vector3) => V(v.x, 0, v.z);

interface Rest { quats: Q[]; positions: THREE.Vector3[]; forward: THREE.Vector3 }
const restCache = new WeakMap<CharacterAsset, Rest>();
/** Rest-pose world transforms; leaves the asset's current pose untouched. */
function rest(asset: CharacterAsset): Rest {
  const cached = restCache.get(asset);
  if (cached && cached.quats.length === asset.bones.length) return cached;
  const original = capturePose(asset);
  try { return computeRest(asset); } finally { applyPose(asset, original); asset.root.updateMatrixWorld(true); }
}
function computeRest(asset: CharacterAsset): Rest {
  applyPose(asset, asset.restPose); asset.root.updateMatrixWorld(true);
  const quats = asset.bones.map(worldQuat), positions = asset.bones.map(worldPos);
  const { roles } = bodyParts(asset);
  const right = V();
  for (const [l, r] of [['leftThigh', 'rightThigh'], ['leftUpperArm', 'rightUpperArm'], ['leftShoulder', 'rightShoulder'], ['frontLeftUpper', 'frontRightUpper'], ['hindLeftUpper', 'hindRightUpper']]) {
    if (roles[l] !== undefined && roles[r] !== undefined) right.add(flat(positions[roles[r]].clone().sub(positions[roles[l]])));
  }
  let forward: THREE.Vector3;
  if (right.lengthSq() > 1e-8) forward = WORLD_UP.clone().cross(right.normalize()).normalize();
  else if (roles.head !== undefined && roles.hips !== undefined && flat(positions[roles.head].clone().sub(positions[roles.hips])).lengthSq() > 1e-6) forward = flat(positions[roles.head].clone().sub(positions[roles.hips])).normalize();
  else forward = V(0, 0, 1);
  const value = { quats, positions, forward };
  restCache.set(asset, value);
  return value;
}

/** Frame for the pose currently applied to the asset. */
function currentFrame(asset: CharacterAsset, restData: Rest): BodyFrame {
  const { roles } = bodyParts(asset);
  const hips = roles.hips !== undefined ? asset.bones[roles.hips] : asset.bones[0];
  const hipsIndex = roles.hips ?? 0;
  const turn = worldQuat(hips).multiply(restData.quats[hipsIndex].clone().invert());
  let forward = flat(restData.forward.clone().applyQuaternion(turn));
  forward = forward.lengthSq() > 1e-8 ? forward.normalize() : restData.forward.clone();
  const right = forward.clone().cross(WORLD_UP).normalize();
  const origin = flat(worldPos(hips));
  return { origin, right, up: WORLD_UP.clone(), forward };
}
const toWorldDir = (f: BodyFrame, [r, u, w]: number[]) => f.right.clone().multiplyScalar(r).addScaledVector(f.up, u).addScaledVector(f.forward, w);
const toWorldPoint = (f: BodyFrame, v: number[]) => toWorldDir(f, v).add(f.origin);
const toChar = (f: BodyFrame, v: THREE.Vector3): Vec3 => [round(v.dot(f.right)), round(v.dot(f.up)), round(v.dot(f.forward))];
const toCharPoint = (f: BodyFrame, v: THREE.Vector3) => toChar(f, v.clone().sub(f.origin));

/* --------------------------------------------------------------- mutation */

function rotateWorld(asset: CharacterAsset, bone: THREE.Bone, delta: Q) {
  const parent = bone.parent ? worldQuat(bone.parent) : new THREE.Quaternion();
  bone.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent)).normalize();
  asset.root.updateMatrixWorld(true);
}
function setWorldQuat(asset: CharacterAsset, bone: THREE.Bone, target: Q) {
  const parent = bone.parent ? worldQuat(bone.parent) : new THREE.Quaternion();
  bone.quaternion.copy(parent.invert().multiply(target)).normalize();
  asset.root.updateMatrixWorld(true);
}
function setWorldPos(asset: CharacterAsset, bone: THREE.Bone, target: THREE.Vector3) {
  bone.position.copy(bone.parent ? bone.parent.worldToLocal(target.clone()) : target);
  asset.root.updateMatrixWorld(true);
}
const swing = (from: THREE.Vector3, to: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
const scaled = (q: Q, weight: number) => new THREE.Quaternion().slerp(q, Math.max(0, Math.min(1, weight)));

/** Where a bone's segment ends: its role child, else the mean of its child joints. */
function segmentEnd(asset: CharacterAsset, index: number): THREE.Vector3 | null {
  const { roles, limbs } = bodyParts(asset);
  const limb = limbs.find(l => l.upper === index || l.mid === index);
  if (limb) return worldPos(asset.bones[limb.upper === index ? limb.mid : limb.tip]);
  const chain: Record<string, string> = { hips: 'spine', neck: 'head', leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm', leftFoot: 'leftToe', rightFoot: 'rightToe', tail: 'tailTip' };
  const role = Object.entries(roles).find(([, i]) => i === index)?.[0];
  if (role === 'chest' && (roles.neck ?? roles.head) !== undefined) return worldPos(asset.bones[(roles.neck ?? roles.head)!]);
  if (role && chain[role] && roles[chain[role]] !== undefined && roles[chain[role]] !== index) return worldPos(asset.bones[roles[chain[role]]]);
  const children = asset.bones[index].children.filter((c): c is THREE.Bone => c instanceof THREE.Bone);
  if (!children.length) return null;
  const mean = V();
  for (const child of children) mean.add(worldPos(child));
  mean.divideScalar(children.length);
  return mean.distanceToSquared(worldPos(asset.bones[index])) > 1e-10 ? mean : null;
}

function poleDirection(frame: BodyFrame, value: unknown, fallback: 'forward' | 'back', side: string): THREE.Vector3 {
  if (Array.isArray(value)) return toWorldDir(frame, vec3(value, 'pole'));
  const name = typeof value === 'string' ? value : fallback;
  return toWorldDir(frame, direction(name, side));
}

/** Analytic two-bone IK with an explicit pole, so knees and elbows bend the natural way. */
function twoBoneIK(asset: CharacterAsset, upperIndex: number, midIndex: number, tipIndex: number, target: THREE.Vector3, pole: THREE.Vector3, keepPole: boolean) {
  const upper = asset.bones[upperIndex], mid = asset.bones[midIndex], tip = asset.bones[tipIndex];
  const a = worldPos(upper), b = worldPos(mid), c = worldPos(tip);
  const lenA = a.distanceTo(b), lenB = b.distanceTo(c);
  const toTarget = target.clone().sub(a);
  const dist = Math.max(1e-4, Math.min(lenA + lenB - 1e-4, Math.max(Math.abs(lenA - lenB) + 1e-4, toTarget.length())));
  const d = toTarget.lengthSq() > 1e-10 ? toTarget.normalize() : c.clone().sub(a).normalize();
  // Prefer the limb's current bend plane when it is clearly bent, else the requested pole.
  const currentBend = b.clone().sub(a).sub(d.clone().multiplyScalar(b.clone().sub(a).dot(d)));
  let p = keepPole && currentBend.length() > lenA * .08 ? currentBend : pole.clone().sub(d.clone().multiplyScalar(pole.dot(d)));
  if (p.lengthSq() < 1e-10) p = V(0, 1, 0).sub(d.clone().multiplyScalar(d.y));
  p.normalize();
  const cosA = Math.max(-1, Math.min(1, (lenA * lenA + dist * dist - lenB * lenB) / (2 * lenA * dist)));
  const knee = a.clone().addScaledVector(d, lenA * cosA).addScaledVector(p, lenA * Math.sqrt(1 - cosA * cosA));
  rotateWorld(asset, upper, swing(b.clone().sub(a), knee.clone().sub(a)));
  const b2 = worldPos(mid), c2 = worldPos(tip);
  rotateWorld(asset, mid, swing(c2.clone().sub(b2), target.clone().sub(b2)));
}

/**
 * Move a hand's twist (relative to rest) into its forearm. The world pose is unchanged, but keys stop
 * storing a forearm rolled one way and a hand rolled back, which unwinds into a spin between keys.
 */
/** The hand's twist from rest about the forearm's long axis (the part a forearm, not a wrist, turns), and that axis. */
function handTwist(asset: CharacterAsset, tipIndex: number) {
  const hand = asset.bones[tipIndex];
  if (hand.position.lengthSq() < 1e-12) return null;
  const axis = hand.position.clone().normalize();
  const delta = hand.quaternion.clone().multiply(new THREE.Quaternion().fromArray(asset.restPose[tipIndex].quaternion).invert());
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const along = axis.clone().multiplyScalar(V(delta.x, delta.y, delta.z).dot(axis));
  const twist = new THREE.Quaternion(along.x, along.y, along.z, delta.w);
  if (twist.lengthSq() < 1e-12) return null;
  twist.normalize();
  return { twist, degrees: deg(2 * Math.atan2(V(twist.x, twist.y, twist.z).dot(axis), twist.w)) };
}

/** Move the hand's twist into the forearm, so in-betweens turn the forearm instead of spinning the wrist. */
function forearmTakesTwist(asset: CharacterAsset, midIndex: number, tipIndex: number) {
  const forearm = asset.bones[midIndex], hand = asset.bones[tipIndex];
  const found = hand.parent === forearm ? handTwist(asset, tipIndex) : null;
  if (!found) return;
  forearm.quaternion.multiply(found.twist).normalize();
  hand.quaternion.premultiply(found.twist.invert()).normalize();
  asset.root.updateMatrixWorld(true);
}

/* ------------------------------------------------------------- parsing */

function vec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1000)) throw new Error(`${label} must be [right, up, forward] with three numbers.`);
  return value as Vec3;
}
function finite(value: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a number between ${min} and ${max}.`);
  return value;
}
const DIRECTIONS: Record<string, Vec3> = { forward: [0, 0, 1], back: [0, 0, -1], backward: [0, 0, -1], up: [0, 1, 0], down: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
function direction(value: unknown, side: string): Vec3 {
  if (Array.isArray(value)) return vec3(value, 'direction');
  if (typeof value !== 'string') throw new Error('direction must be a named direction or [right, up, forward].');
  const sideSign = /^(left|frontLeft|hindLeft)/.test(side) ? -1 : /^(right|frontRight|hindRight)/.test(side) ? 1 : 0;
  const parts = value.split(/[-+\s]+/).filter(Boolean);
  const out: Vec3 = [0, 0, 0];
  for (const word of parts) {
    const v: Vec3 | undefined = word === 'out' || word === 'outward' ? (sideSign ? [sideSign, 0, 0] : undefined) : word === 'in' || word === 'inward' ? (sideSign ? [-sideSign, 0, 0] : undefined) : DIRECTIONS[word];
    if (!v) throw new Error(`Unknown direction "${word}". Use forward, back, up, down, left, right, out, in, combinations like "forward-up", or [right, up, forward].`);
    out[0] += v[0]; out[1] += v[1]; out[2] += v[2];
  }
  if (Math.hypot(...out) < 1e-6) throw new Error(`Direction "${value}" cancels out.`);
  return out;
}

/* --------------------------------------------------------------- actions */

export interface IntentAction { do: string; part?: unknown; [key: string]: unknown }
export interface IntentResult { do: string; part?: string; ok: boolean; note?: string; error?: number }

function plantFeet(asset: CharacterAsset, saved: { index: number; pos: THREE.Vector3; quat: Q }[], frame: BodyFrame) {
  const { limbs } = bodyParts(asset);
  for (const foot of saved) {
    const limb = limbs.find(l => l.tip === foot.index);
    if (limb) twoBoneIK(asset, limb.upper, limb.mid, limb.tip, foot.pos, toWorldDir(frame, direction(limb.pole, limb.end)), true);
    else solveIK(asset, foot.index, foot.pos);
    setWorldQuat(asset, asset.bones[foot.index], foot.quat);
  }
}
const footState = (asset: CharacterAsset) => bodyParts(asset).feet.map(index => ({ index, pos: worldPos(asset.bones[index]), quat: worldQuat(asset.bones[index]) }));

function runAction(asset: CharacterAsset, action: IntentAction, frame: BodyFrame, restData: Rest): IntentResult {
  const parts = bodyParts(asset);
  const kind = action.do;
  const weight = finite(action.weight, 'weight', 0, 1, 1);
  if (kind === 'reset') {
    const all = action.part === 'all' || action.part === undefined;
    const { name, bones } = all ? { name: 'all', bones: asset.bones.map((_, i) => i) } : resolvePart(asset, action.part);
    for (const i of bones) {
      const restBone = asset.restPose[i];
      asset.bones[i].quaternion.slerp(new THREE.Quaternion().fromArray(restBone.quaternion), weight).normalize();
      asset.bones[i].position.lerp(V(...restBone.position), weight);
      if (all) asset.bones[i].scale.lerp(V(...restBone.scale), weight);
    }
    asset.root.updateMatrixWorld(true);
    return { do: kind, part: name, ok: true };
  }
  if (kind === 'mirror') {
    const from = action.from === 'right' ? 'right' : action.from === 'left' ? 'left' : null;
    if (!from) throw new Error('mirror needs from: "left" or "right".');
    const to = from === 'left' ? 'right' : 'left';
    const which = action.limbs ?? 'all';
    const roles = (which === 'arms' ? ['Shoulder', 'UpperArm', 'Forearm', 'Hand'] : which === 'legs' ? ['Thigh', 'Shin', 'Foot', 'Toe'] : ['Shoulder', 'UpperArm', 'Forearm', 'Hand', 'Thigh', 'Shin', 'Foot', 'Toe']);
    // Mirror in the rest heading: strip the character's turn, reflect across the rest sagittal plane, turn back.
    const heading = new THREE.Quaternion().setFromUnitVectors(restData.forward, frame.forward);
    const unheading = heading.clone().invert();
    const n = restData.forward.clone().cross(WORLD_UP).normalize();
    // Apply the full mirror parent-first, then blend each bone's local rotation once so weight never bends straight joints.
    const blended: { bone: THREE.Bone; before: Q }[] = [];
    for (const role of roles) {
      const src = parts.roles[`${from}${role}`], dst = parts.roles[`${to}${role}`];
      if (src === undefined || dst === undefined) continue;
      const delta = unheading.clone().multiply(worldQuat(asset.bones[src])).multiply(restData.quats[src].clone().invert());
      const v = V(delta.x, delta.y, delta.z);
      const reflected = v.sub(n.clone().multiplyScalar(2 * v.dot(n))).negate();
      const mirrored = new THREE.Quaternion(reflected.x, reflected.y, reflected.z, delta.w).normalize();
      blended.push({ bone: asset.bones[dst], before: asset.bones[dst].quaternion.clone() });
      setWorldQuat(asset, asset.bones[dst], heading.clone().multiply(mirrored).multiply(restData.quats[dst]));
    }
    for (const { bone, before } of blended) bone.quaternion.copy(before.clone().slerp(bone.quaternion, weight)).normalize();
    asset.root.updateMatrixWorld(true);
    const count = blended.length;
    if (!count) throw new Error('mirror found no paired left/right limb bones on this rig.');
    return { do: kind, part: `${from}→${to}`, ok: true };
  }
  if (kind === 'lookAt') {
    const { name, bones } = resolvePart(asset, action.part ?? 'head');
    const index = bones[bones.length - 1];
    const bone = asset.bones[index];
    const target = typeof action.at === 'string' || typeof action.at === 'number' ? worldPos(asset.bones[resolvePart(asset, action.at).bones[0]]) : toWorldPoint(frame, vec3(action.at, 'at'));
    const facing = () => restData.forward.clone().applyQuaternion(worldQuat(bone).multiply(restData.quats[index].clone().invert()));
    const neck = name === 'head' ? parts.roles.neck : undefined;
    if (neck !== undefined) rotateWorld(asset, asset.bones[neck], scaled(swing(facing(), target.clone().sub(worldPos(bone))), .4 * weight));
    rotateWorld(asset, bone, scaled(swing(facing(), target.clone().sub(worldPos(bone))), weight));
    return { do: kind, part: name, ok: true };
  }
  if (kind === 'turn') {
    const { name, bones } = resolvePart(asset, action.part);
    const pitch = finite(action.pitch, 'pitch', -360, 360, 0), yaw = finite(action.yaw, 'yaw', -360, 360, 0), roll = finite(action.roll, 'roll', -360, 360, 0);
    const planted = name === 'hips' && action.plantFeet !== false ? footState(asset) : [];
    const share = 1 / bones.length;
    // pitch: top tips forward; yaw: front turns to the character's right; roll: top tips right.
    const delta = new THREE.Quaternion().setFromAxisAngle(frame.forward, rad(roll * share * weight))
      .multiply(new THREE.Quaternion().setFromAxisAngle(frame.up.clone().negate(), rad(yaw * share * weight)))
      .multiply(new THREE.Quaternion().setFromAxisAngle(frame.right.clone().negate(), rad(pitch * share * weight)));
    for (const i of bones) rotateWorld(asset, asset.bones[i], delta);
    if (planted.length) plantFeet(asset, planted, frame);
    return { do: kind, part: name, ok: true, ...(planted.length ? { note: 'feet kept planted' } : {}) };
  }
  if (kind === 'aim') {
    const { name, bones } = resolvePart(asset, action.part);
    const index = bones[0];
    const target = toWorldDir(frame, direction(action.direction, name));
    if (action.pointer !== undefined) {
      // Point a carried bone (a weapon or prop) by turning the part that holds it.
      const pointer = resolvePart(asset, action.pointer).bones[0];
      let carried = false;
      for (let node: THREE.Object3D | null = asset.bones[pointer].parent; node; node = node.parent) if (node === asset.bones[index]) { carried = true; break; }
      if (!carried) throw new Error(`"${asset.bones[pointer].name}" is not carried by "${name}". Aim the part that holds it (for a held prop, the hand).`);
      const tip = segmentEnd(asset, pointer);
      const axis = tip ? tip.sub(worldPos(asset.bones[pointer])) : V(0, 1, 0).applyQuaternion(worldQuat(asset.bones[pointer]));
      rotateWorld(asset, asset.bones[index], scaled(swing(axis, target), weight));
      return { do: kind, part: name, ok: true };
    }
    const end = segmentEnd(asset, index);
    if (!end) throw new Error(`"${name}" has no child segment to aim. Use turn or lookAt instead.`);
    const start = worldPos(asset.bones[index]);
    rotateWorld(asset, asset.bones[index], scaled(swing(end.sub(start), target), weight));
    return { do: kind, part: name, ok: true };
  }
  if (kind === 'bend') {
    const { name, bones } = resolvePart(asset, action.part);
    const index = bones[0];
    const limb = parts.limbs.find(l => l.mid === index);
    if (!limb) throw new Error(`bend works on elbows and knees (forearm/shin parts); "${name}" is not a limb hinge.`);
    const degrees = finite(action.degrees, 'degrees', 0, 175);
    const a = worldPos(asset.bones[limb.upper]), b = worldPos(asset.bones[limb.mid]), c = worldPos(asset.bones[limb.tip]);
    const upper = b.clone().sub(a).normalize(), lower = c.clone().sub(b).normalize();
    const current = deg(upper.angleTo(lower));
    let axis = upper.clone().cross(lower);
    if (current < 3 || axis.lengthSq() < 1e-8) {
      // Straight limb: knees fold backward, elbows forward, front legs backward, hind legs forward.
      const preferred = toWorldDir(frame, limb.pole === 'forward' ? [0, 0, -1] : [0, 0, 1]);
      axis = lower.clone().cross(preferred);
      if (axis.lengthSq() < 1e-8) axis = frame.right.clone().negate();
    }
    rotateWorld(asset, asset.bones[index], new THREE.Quaternion().setFromAxisAngle(axis.normalize(), rad((degrees - current) * weight)));
    return { do: kind, part: name, ok: true };
  }
  if (kind === 'reach' || kind === 'move') {
    const { name, bones } = resolvePart(asset, action.part ?? (kind === 'move' ? 'hips' : undefined));
    const index = bones[bones.length - 1], bone = asset.bones[index];
    const now = worldPos(bone);
    let target: THREE.Vector3;
    if (action.to !== undefined && action.by !== undefined) throw new Error('Use either to or by, not both.');
    if (action.by !== undefined) target = now.clone().add(toWorldDir(frame, vec3(action.by, 'by')));
    else if (action.to !== undefined) {
      const anchor = action.relativeTo !== undefined ? worldPos(asset.bones[resolvePart(asset, action.relativeTo).bones[0]]) : frame.origin;
      target = anchor.clone().add(toWorldDir(frame, vec3(action.to, 'to')));
    } else throw new Error(`${kind} needs to: [right, up, forward] or by: [right, up, forward].`);
    target = now.clone().lerp(target, weight);
    const isRoot = name === 'hips' || !(bone.parent instanceof THREE.Bone);
    if (isRoot) {
      const planted = action.plantFeet !== false ? footState(asset) : [];
      setWorldPos(asset, bone, target);
      if (planted.length) plantFeet(asset, planted, frame);
      return { do: kind, part: name, ok: true, ...(planted.length ? { note: 'feet kept planted' } : {}) };
    }
    const limb = parts.limbs.find(l => l.tip === index);
    const keep = limb && (/Foot$/.test(limb.end) ? action.keepOrientation !== false : action.keepOrientation === true) ? worldQuat(bone) : null;
    if (limb) twoBoneIK(asset, limb.upper, limb.mid, limb.tip, target, poleDirection(frame, action.pole, limb.pole, limb.end), action.pole === undefined);
    else solveIK(asset, index, target);
    if (keep) setWorldQuat(asset, bone, keep);
    if (keep && limb && !/Foot$/.test(limb.end)) forearmTakesTwist(asset, limb.mid, limb.tip);
    const error = worldPos(bone).distanceTo(target);
    return { do: kind, part: name, ok: error < .02, error: round(error), ...(error >= .02 ? { note: `target is out of reach by ${round(error)} m; the limb points at it instead` } : {}) };
  }
  if (kind === 'grip') return grip(asset, action, frame, restData);
  throw new Error(`Unknown action "${kind}". Use turn, aim, bend, reach, move, lookAt, mirror, grip or reset.`);
}

/**
 * Wrap a hand around a held prop the way the rig itself holds it. The holding hand rolls about the shaft until
 * its wrist is straight; the other hand takes the holding hand's grip, mirrored, at `along` meters down the shaft.
 */
function grip(asset: CharacterAsset, action: IntentAction, frame: BodyFrame, restData: Rest): IntentResult {
  const parts = bodyParts(asset);
  const { name, bones } = resolvePart(asset, action.part);
  const hand = bones[bones.length - 1];
  const limb = parts.limbs.find(l => l.tip === hand);
  if (!limb) throw new Error(`grip works on hands; "${name}" is not the end of an arm.`);
  if (action.on === undefined) throw new Error('grip needs on: the held prop bone (for example "Pitchfork").');
  const prop = resolvePart(asset, action.on).bones[0];
  const holder = parts.limbs.find(l => l.tip !== prop && isAncestor(asset, l.tip, prop))?.tip;
  if (holder === undefined) throw new Error(`"${asset.bones[prop].name}" is not carried by a hand, so there is no grip to copy.`);
  if (holder !== hand && action.along === undefined) throw new Error(`grip with the hand that does not carry "${asset.bones[prop].name}" needs along: meters down the shaft from the holding hand (negative toward the butt).`);
  const along = action.along === undefined ? 0 : finite(action.along, 'along', -5, 5);
  // No pole given: try the natural elbow directions and keep the one that lets the wrist stay straightest.
  const poles: [string, THREE.Vector3][] = action.pole !== undefined ? [[Array.isArray(action.pole) ? 'given' : String(action.pole), poleDirection(frame, action.pole, limb.pole, limb.end)]]
    : ['down', 'down-out', 'out', 'out-up', 'back-out', 'down-back', 'back'].map(p => [p, toWorldDir(frame, direction(p, limb.end)).normalize()]);
  if (action.reverse !== undefined && typeof action.reverse !== 'boolean') throw new Error('reverse must be true or false.');
  const signs = hand === holder ? [1] : action.reverse === undefined ? [1, -1] : [action.reverse ? -1 : 1];

  // The shaft and the holding hand's grip on it, read from the pose as it stands.
  const shaftStart = worldPos(asset.bones[prop]);
  const tip = segmentEnd(asset, prop);
  const axis = (tip ? tip.sub(shaftStart) : V(0, 1, 0).applyQuaternion(worldQuat(asset.bones[prop]))).normalize();
  if (hand === holder) {
    // The holding hand's along slides the prop through it, from where it sits at rest: negative chokes down toward the
    // butt, so a long weapon swings without its butt end stabbing back into the body.
    const bone = asset.bones[prop], parent = bone.parent!;
    const atRest = parent.localToWorld(V(...asset.restPose[prop].position));
    bone.position.copy(parent.worldToLocal(atRest.addScaledVector(axis, -along)));
    asset.root.updateMatrixWorld(true);
    shaftStart.copy(worldPos(bone));
  }
  const fingers = (index: number) => asset.bones[index].children.filter((c): c is THREE.Bone => c instanceof THREE.Bone && c !== asset.bones[prop] && !isAncestor(asset, asset.bones.indexOf(c), prop));
  const palm = (index: number) => {
    const wrist = worldPos(asset.bones[index]);
    const kids = fingers(index);
    if (!kids.length) return wrist;
    const knuckles = V();
    for (const k of kids) knuckles.add(worldPos(k));
    return wrist.add(knuckles.divideScalar(kids.length)).multiplyScalar(.5);
  };
  const onShaft = (p: THREE.Vector3) => shaftStart.clone().addScaledVector(axis, p.clone().sub(shaftStart).dot(axis));
  const holdCenter = onShaft(palm(holder));
  const holdQuat = worldQuat(asset.bones[holder]);
  const toHolderLocal = (v: THREE.Vector3) => v.clone().applyQuaternion(holdQuat.clone().invert());
  const gripAxis = toHolderLocal(axis);
  const gripOffset = toHolderLocal(holdCenter.clone().sub(worldPos(asset.bones[holder])));
  // Carry the holding hand's grip into this hand: mirror across the rest sagittal plane when it is the other hand.
  const n = restData.forward.clone().cross(WORLD_UP).normalize();
  const reflect = (v: THREE.Vector3) => v.clone().sub(n.clone().multiplyScalar(2 * v.dot(n)));
  const carry = (v: THREE.Vector3) => hand === holder ? v.clone()
    : reflect(v.clone().applyQuaternion(restData.quats[holder])).applyQuaternion(restData.quats[hand].clone().invert());
  const localAxis = carry(gripAxis), localOffset = carry(gripOffset);
  const center = holdCenter.clone().addScaledVector(axis, hand === holder ? 0 : along);
  // How much shaft sticks out past this hand toward the butt: the part that can stab back into the body.
  const shape = contactModel(asset, parts).props.find(p => p.bone === prop);
  const butt = shape ? Math.max(0, -Math.min(...shape.points.map(p => p.clone().applyMatrix4(asset.bones[prop].matrixWorld).sub(center).dot(axis)))) : 0;

  const arm = [limb.upper, limb.mid, limb.tip];
  const save = () => arm.map(i => asset.bones[i].quaternion.clone());
  const restore = (saved: Q[]) => { arm.forEach((i, k) => asset.bones[i].quaternion.copy(saved[k])); asset.root.updateMatrixWorld(true); };
  /** How straight the wrist is: the hand's line to its knuckles against the forearm's line. */
  const straightness = () => {
    const wrist = worldPos(asset.bones[hand]);
    return palm(hand).sub(wrist).normalize().dot(wrist.clone().sub(worldPos(asset.bones[limb.mid])).normalize());
  };
  const settle = (start: Q, pole: THREE.Vector3) => {
    let q = start.clone();
    for (let pass = 0; pass < 4; pass++) {
      twoBoneIK(asset, limb.upper, limb.mid, limb.tip, center.clone().sub(localOffset.clone().applyQuaternion(q)), pole, false);
      setWorldQuat(asset, asset.bones[hand], q);
      // Roll the hand about the shaft so the knuckles continue the forearm.
      const wrist = worldPos(asset.bones[hand]);
      const d = palm(hand).sub(wrist), f = wrist.clone().sub(worldPos(asset.bones[limb.mid]));
      const across = d.sub(axis.clone().multiplyScalar(d.dot(axis)));
      if (across.lengthSq() < 1e-10) break;
      const angle = Math.atan2(f.dot(axis.clone().cross(across)), f.dot(across));
      q = new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(q);
    }
    twoBoneIK(asset, limb.upper, limb.mid, limb.tip, center.clone().sub(localOffset.clone().applyQuaternion(q)), pole, false);
    setWorldQuat(asset, asset.bones[hand], q);
  };
  // Either way round the shaft is a real grip (overhand or underhand): keep the straighter wrist.
  const before = save();
  const now = worldQuat(asset.bones[hand]);
  let best: { saved: Q[]; score: number; pole: string; sign: number; twist: number } | null = null;
  for (const [poleName, pole] of poles) for (const sign of signs) {
    restore(before);
    settle(swing(localAxis.clone().applyQuaternion(now), axis.clone().multiplyScalar(sign)).multiply(now), pole);
    const reached = palm(hand).sub(center).length();
    const twist = handTwist(asset, hand)?.degrees ?? 0;
    const score = straightness() - reached * 10;
    if (!best || score > best.score) best = { saved: save(), score, pole: poleName, sign, twist };
  }
  restore(best!.saved);
  forearmTakesTwist(asset, limb.mid, limb.tip);
  const missed = palm(hand).distanceTo(center) - holdCenter.distanceTo(palm(holder));
  const bend = Math.round(deg(Math.acos(Math.max(-1, Math.min(1, straightness())))));
  return { do: 'grip', part: name, ok: missed < .03, ...(missed >= .03 ? { error: round(missed), note: `the shaft is out of reach by ${round(missed)} m` } : { note: `wrist bent ${bend}°, elbow ${best!.pole}${hand === holder ? '' : best!.sign < 0 ? ', reversed grip' : ', mirrored grip'}, forearm twist ${Math.round(best!.twist)}°, ${round(butt)} m of shaft behind this hand` }) };
}

/** Apply actions in order, then describe the result. Restores the asset's original pose. */
export function applyIntent(asset: CharacterAsset, pose: Pose, actions: unknown): { pose: Pose; results: IntentResult[]; description: PoseDescription } {
  if (!Array.isArray(actions) || !actions.length || actions.length > 64) throw new Error('Provide 1–64 actions.');
  const original = capturePose(asset);
  try {
    const restData = rest(asset);
    applyPose(asset, pose); asset.root.updateMatrixWorld(true);
    const results = actions.map((action, i) => {
      if (!action || typeof action !== 'object' || typeof (action as IntentAction).do !== 'string') throw new Error(`Action ${i} needs a "do" field.`);
      // Character space follows the hips, so re-read it after every action (a turn or move changes it).
      try { return runAction(asset, action as IntentAction, currentFrame(asset, restData), restData); }
      catch (error) { throw new Error(`Action ${i} (${(action as IntentAction).do}): ${error instanceof Error ? error.message : String(error)}`); }
    });
    const next = capturePose(asset);
    return { pose: next, results, description: describeApplied(asset, restData) };
  } finally { applyPose(asset, original); }
}

/* -------------------------------------------------------------- describe */

export interface PoseDescription {
  frame: { origin: Vec3; forward: Vec3; right: Vec3; note: string };
  parts: Record<string, Vec3>;
  angles: Record<string, number>;
  ground: Record<string, number>;
  warnings: string[];
}

function describeApplied(asset: CharacterAsset, restData: Rest): PoseDescription {
  const { roles, limbs } = bodyParts(asset);
  const frame = currentFrame(asset, restData);
  const parts: Record<string, Vec3> = {};
  for (const role of ['head', 'chest', 'hips', 'leftHand', 'rightHand', 'leftForearm', 'rightForearm', 'leftFoot', 'rightFoot', 'leftShin', 'rightShin', 'frontLeftFoot', 'frontRightFoot', 'hindLeftFoot', 'hindRightFoot', 'tailTip']) {
    if (roles[role] !== undefined) parts[role.replace(/Forearm$/, 'Elbow').replace(/Shin$/, 'Knee')] = toCharPoint(frame, worldPos(asset.bones[roles[role]]));
  }
  const angles: Record<string, number> = {}, warnings: string[] = [];
  for (const limb of limbs) {
    const a = worldPos(asset.bones[limb.upper]), b = worldPos(asset.bones[limb.mid]), c = worldPos(asset.bones[limb.tip]);
    const up = b.clone().sub(a), low = c.clone().sub(b);
    const bend = Math.round(deg(up.angleTo(low)));
    const label = limb.end.replace(/Hand$/, 'Elbow').replace(/Foot$/, 'Knee');
    angles[label] = bend;
    if (/^(left|right)Foot$/.test(limb.end) && bend > 4 && up.clone().cross(low).dot(frame.right) > 0) warnings.push(`${label} bends backwards (hyperextended).`);
  }
  const chestIndex = roles.chest ?? roles.neck;
  if (chestIndex !== undefined) {
    // The chest's own tilt, measured from its rest orientation (matches turn pitch/roll).
    const up = toChar(frame, V(0, 1, 0).applyQuaternion(worldQuat(asset.bones[chestIndex]).multiply(restData.quats[chestIndex].clone().invert())));
    angles.torsoPitch = Math.round(deg(Math.atan2(up[2], up[1])));
    angles.torsoLean = Math.round(deg(Math.atan2(up[0], up[1])));
  }
  const facing = (index: number) => toChar(frame, restData.forward.clone().applyQuaternion(worldQuat(asset.bones[index]).multiply(restData.quats[index].clone().invert())));
  if (roles.chest !== undefined) { const f = facing(roles.chest); angles.chestYaw = Math.round(deg(Math.atan2(f[0], f[2]))); }
  if (roles.head !== undefined) {
    const f = facing(roles.head);
    angles.headYaw = Math.round(deg(Math.atan2(f[0], f[2])));
    angles.headPitch = Math.round(deg(Math.atan2(-f[1], Math.hypot(f[0], f[2]))));
  }
  const ground: Record<string, number> = {};
  let lowest = Infinity, lowestName = '';
  asset.bones.forEach((bone, index) => { const y = worldPos(bone).y; if (y < lowest) { lowest = y; lowestName = Object.entries(roles).find(([, i]) => i === index)?.[0] ?? bone.name; } });
  for (const limb of limbs) if (/Foot$/.test(limb.end)) ground[limb.end] = round(worldPos(asset.bones[limb.tip]).y);
  if (roles.hips !== undefined) ground.hips = round(worldPos(asset.bones[roles.hips]).y);
  if (lowest < -.02 * Math.max(1, asset.height)) warnings.push(`${lowestName} is ${round(-lowest)} m below the floor.`);
  const scale = Math.max(.1, asset.height) / 1.8;
  for (const depth of contactModel(asset, bodyParts(asset)).measure(i => asset.bones[i].matrixWorld)) {
    for (const region of ['head', 'torso'] as const) if (depth[region] > .03 * scale) warnings.push(`${depth.name} cuts ${round(depth[region] * 100)} cm into the ${region}; ${clipAdvice(depth)}.`);
  }
  return {
    frame: { origin: frame.origin.toArray().map(n => round(n)) as Vec3, forward: frame.forward.toArray().map(n => round(n)) as Vec3, right: frame.right.toArray().map(n => round(n)) as Vec3, note: 'parts are [right, up, forward] meters from the floor under the hips; ground values are joint heights above the floor (joints sit above the sole).' },
    parts, angles, ground, warnings,
  };
}

export function describePose(asset: CharacterAsset, pose: Pose): PoseDescription & { bodyParts: Record<string, string> } {
  const original = capturePose(asset);
  try {
    const restData = rest(asset);
    applyPose(asset, pose); asset.root.updateMatrixWorld(true);
    const { roles, torso } = bodyParts(asset);
    return { ...describeApplied(asset, restData), bodyParts: { ...Object.fromEntries(Object.entries(roles).map(([role, i]) => [role, asset.bones[i].name])), ...(torso.length ? { torso: torso.map(i => asset.bones[i].name).join(' + ') } : {}) } };
  } finally { applyPose(asset, original); }
}

/** Shared by review metrics: rest-relative frame and helpers. */
export function frameFor(asset: CharacterAsset): BodyFrame { return currentFrame(asset, rest(asset)); }
export function restForward(asset: CharacterAsset): THREE.Vector3 { return rest(asset).forward.clone(); }
export { toCharPoint };
