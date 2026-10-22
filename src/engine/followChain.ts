import * as THREE from 'three';
import type { CharacterAsset } from '../types';

/** 0 bends the whole chain in one smooth curve; 1 bends it at a few stiff hinges. */
export const DEFAULT_FOLLOW_FEEL = 0.2;
const MAX_CHAIN = 24;
const ROOTLIKE = /(?:hips|pelvis|root)$/i;
// Limbs keep the knee/elbow solver; follow is for necks, tails and tentacles.
const LIMB = /hand|arm|leg|foot|toe|hoof|paw|wrist|ankle|knee|elbow|finger|thumb/i;

function depth(bone: THREE.Bone): number {
  let deepest = 0;
  for (const child of bone.children) if (child instanceof THREE.Bone) deepest = Math.max(deepest, 1 + depth(child));
  return deepest;
}

/** The joints a posed bone drags along, base first: every ancestor up to where chains meet (the body under three necks). */
export function followChain(asset: CharacterAsset, boneIndex: number): THREE.Bone[] {
  const effector = asset.bones[boneIndex];
  if (!effector || LIMB.test(effector.name) || ROOTLIKE.test(effector.name)) return [];
  const chain: THREE.Bone[] = [];
  let joint = effector.parent;
  while (joint instanceof THREE.Bone && chain.length < MAX_CHAIN) {
    // The skeleton root anchors the chain and never bends with it.
    if (!(joint.parent instanceof THREE.Bone) || ROOTLIKE.test(joint.name)) break;
    // Short side bones (a jaw, a leaf) don't make a joint a branch point; a second long chain does.
    const long = joint.children.filter(child => child instanceof THREE.Bone && depth(child) >= 2).length;
    if (long > 1) break;
    chain.unshift(joint);
    joint = joint.parent;
  }
  return chain;
}

/** The hinge joints a robotic chain bends at; the joints between them stay locked as stiff segments. */
function hinges(count: number): number[] {
  if (count <= 2) return [...Array(count).keys()];
  const links = count >= 6 ? 3 : 2;
  return [...new Set([...Array(links).keys()].map(i => Math.round(i * count / links)))];
}

const turn = (v: THREE.Vector3) => { const angle = v.length(); return angle < 1e-12 ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(v.clone().divideScalar(angle), angle); };

/** Per-joint share of the bend: even along the whole chain when snaky, only at the hinges when robotic. */
function shares(count: number, feel: number): number[] {
  const hinge = new Set(hinges(count));
  return [...Array(count).keys()].map(i => THREE.MathUtils.lerp(1, hinge.has(i) ? count / hinge.size : 0, feel));
}

const evenScale = (s: THREE.Vector3) => Math.min(s.x, s.y, s.z) > 0 && Math.max(s.x, s.y, s.z) <= Math.min(s.x, s.y, s.z) * (1 + 1e-4);

/** Carries one drag's last answer into the next pointer move, so the bend never jumps to a different shape mid-drag. */
export interface FollowMemory { solution?: number[] }

/**
 * Move a chain's end bone (a head) and let the joints behind it follow.
 * Every joint turns by its share of one bend, so feel 0 is snaky (one smooth curve)
 * and 1 is robotic (stiff links, sharp hinges); the base swings only as much as the bend can't cover.
 * The moved bone keeps its world aim. Returns false (pose untouched) when the bone has no chain to follow
 * or the chain is stretched unevenly, so the caller can fall back to the classic IK.
 */
export function solveFollow(asset: CharacterAsset, boneIndex: number, target: THREE.Vector3, feel: number, memory?: FollowMemory): boolean {
  const effector = asset.bones[boneIndex];
  const chain = followChain(asset, boneIndex);
  if (!effector || !chain.length || !target.toArray().every(Number.isFinite)) return false;
  asset.root.updateMatrixWorld(true);
  const base = chain[0].parent as THREE.Object3D, parentScale = new THREE.Vector3();
  base.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), parentScale);
  // Rigid world segments only hold when nothing in the chain is stretched or mirrored.
  if (base.matrixWorld.determinant() <= 0 || !evenScale(parentScale) || ![...chain, effector].every(bone => evenScale(bone.scale))) return false;
  const points = [...chain, effector].map(bone => bone.getWorldPosition(new THREE.Vector3()));
  const segments = points.slice(1).map((p, i) => p.clone().sub(points[i]));
  const reach = segments.reduce((sum, s) => sum + s.length(), 0), tolerance = reach * 1e-5;
  if (reach < 1e-6) return false;
  const weights = shares(chain.length, Math.max(0, Math.min(1, Number.isFinite(feel) ? feel : DEFAULT_FOLLOW_FEEL)));
  const turns = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0)), total = turns.at(-1)!;
  // x = [base swing (3), shared bend (3)]; segment i turns by swing then bend * turns[i].
  const rotation = (x: number[], i: number) => turn(new THREE.Vector3(x[0], x[1], x[2])).multiply(turn(new THREE.Vector3(x[3], x[4], x[5]).multiplyScalar(turns[i])));
  const tip = (x: number[]) => segments.reduce((at, s, i) => at.add(s.clone().applyQuaternion(rotation(x, i))), points[0].clone());
  const miss = (x: number[]) => tip(x).sub(target);
  // No more than one full coil along the chain.
  const limit = 2 * Math.PI / total;
  const clamp = (x: number[]) => { const bend = new THREE.Vector3(x[3], x[4], x[5]); if (bend.length() > limit) bend.setLength(limit); return [x[0], x[1], x[2], bend.x, bend.y, bend.z]; };
  // A base swing costs eight times what the same total bend costs, so the neck curves before it pivots.
  const cost = [8, 8, 8, total * total, total * total, total * total];
  const price = (x: number[]) => x.reduce((sum, v, k) => sum + v * v * cost[k], 0);

  // Gauss-Newton toward the cheapest pose that reaches.
  const refine = (seed: number[]) => {
    let x = clamp(seed), error = miss(x).length(), polish = false;
    for (let iteration = 0, settled = 0; iteration < 80 && settled < 2; iteration++) {
      if (error <= tolerance) settled++;
      const residual = miss(x), columns: THREE.Vector3[] = [];
      for (let k = 0; k < 6; k++) {
        const plus = x.slice(), minus = x.slice(); plus[k] += 1e-5; minus[k] -= 1e-5;
        columns.push(miss(plus).sub(miss(minus)).divideScalar(2e-5));
      }
      const system = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0), e = system.elements;
      for (let k = 0; k < 6; k++) {
        const c = columns[k].toArray();
        for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) e[s * 3 + r] += c[r] * c[s] / cost[k];
      }
      const damping = Math.max(e[0], e[4], e[8], 1e-12) * 1e-6;
      e[0] += damping; e[4] += damping; e[8] += damping;
      if (Math.abs(system.determinant()) < 1e-24) break;
      // Minimise the weighted size of the whole pose (not just this step) under the linearised reach;
      // once that stalls, polish with plain least-change steps until the tip sits on the target.
      const lambda = (polish ? residual.clone().negate() : columns.reduce((sum, c, k) => sum.addScaledVector(c, x[k]), residual.clone().negate())).applyMatrix3(system.invert());
      const step = columns.map((c, k) => c.dot(lambda) / cost[k] - (polish ? 0 : x[k]));
      let improved = false;
      for (let scale = 1; scale > 1e-3 && !improved; scale /= 2) {
        const trial = clamp(x.map((v, k) => v + step[k] * scale)), trialError = miss(trial).length();
        if (trialError < error || trialError <= tolerance) { x = trial; error = trialError; improved = true; }
      }
      if (!improved) { if (polish) break; polish = true; }
    }
    return { x, error };
  };

  // Seed the bend's side: toward the target, leaning forward (+Z) so a dead-straight pull still picks a side smoothly.
  const axis = points.at(-1)!.clone().sub(points[0]), toward = target.clone().sub(points[0]);
  const lean = axis.clone().cross(new THREE.Vector3(0, 0, 1));
  if (lean.lengthSq() < 1e-12 * axis.lengthSq()) lean.copy(axis).cross(new THREE.Vector3(1, 0, 0));
  const side = axis.clone().cross(toward).addScaledVector(lean.normalize(), axis.length() * toward.length() * .02);
  if (side.lengthSq() < 1e-12) side.copy(lean);
  side.normalize();
  // Curl that way, or the other way, until the neck's reach matches the target's distance: nearest bracket first.
  const curl = (angle: number) => { const bend = side.clone().multiplyScalar(angle); return [0, 0, 0, bend.x, bend.y, bend.z]; };
  const gap = (angle: number) => tip(curl(angle)).distanceTo(points[0]) - toward.length();
  let seedAngle = 0, closest = Math.abs(gap(0));
  search: for (let k = 1; k <= 24; k++) for (const sign of [1, -1]) {
    let a = sign * limit * .98 * (k - 1) / 24, b = sign * limit * .98 * k / 24;
    if (Math.abs(gap(b)) < closest) { closest = Math.abs(gap(b)); seedAngle = b; }
    if (gap(a) * gap(b) > 0) continue;
    for (let step = 0; step < 40; step++) { const mid = (a + b) / 2; if (gap(a) * gap(mid) <= 0) b = mid; else a = mid; }
    seedAngle = (a + b) / 2;
    break search;
  }
  const warm = memory?.solution?.length === 6 && memory.solution.every(Number.isFinite) ? refine(memory.solution) : null;
  // Mid-drag, staying on the same shape beats a marginally cheaper one.
  let best = warm && warm.error <= reach * 1e-4 ? warm : null;
  if (!best) {
    // Fresh drags (or a warm start that lost the target) try the curl seed and the untouched pose.
    const tried = [refine(curl(seedAngle)), refine([0, 0, 0, 0, 0, 0]), ...(warm ? [warm] : [])];
    best = tried.reduce((a, b) => (b.error < a.error - tolerance || (Math.abs(b.error - a.error) <= tolerance && price(b.x) < price(a.x)) ? b : a));
  }
  if (memory) memory.solution = best.x;

  const saved = [...chain, effector].map(bone => bone.quaternion.clone());
  const rotations = [...chain, effector].map(bone => bone.getWorldQuaternion(new THREE.Quaternion()));
  let parentWorld = base.getWorldQuaternion(new THREE.Quaternion());
  chain.forEach((joint, i) => {
    const world = rotation(best.x, i).multiply(rotations[i]);
    joint.quaternion.copy(parentWorld.clone().invert().multiply(world)).normalize();
    parentWorld = world;
  });
  effector.quaternion.copy(parentWorld.clone().invert().multiply(rotations.at(-1)!)).normalize();
  asset.root.updateMatrixWorld(true);
  // Safety net: if the skeleton didn't land where the solver predicted, put it back and let the classic IK run.
  if (effector.getWorldPosition(new THREE.Vector3()).distanceTo(tip(best.x)) > reach * 1e-3) {
    [...chain, effector].forEach((bone, i) => bone.quaternion.copy(saved[i]));
    asset.root.updateMatrixWorld(true);
    if (memory) memory.solution = undefined;
    return false;
  }
  return true;
}
