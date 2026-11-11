import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { isFingerBone } from './handRig';
import type { BodyParts } from './agentIntent';
import type { CharacterAsset } from '../types';

/**
 * Rough body volumes (a head ball and a torso tube shaped like the real torso) and the mesh of every prop, so poses and clips can be checked
 * for a weapon, hat or pet cutting into the body. Built once per character from its skinned mesh in the rest pose.
 */
export interface PropInfo { bone: number; name: string; carrier?: number; rigidTo: Set<number>; points: THREE.Vector3[]; axis: THREE.Vector3 }
/** at: for a carried prop, how far from the carrying hand (meters along the prop) its deepest point sits. floor: height of its lowest point (meters; negative = sunk into the floor). */
export interface PropDepth { name: string; carried: boolean; head: number; torso: number; floor: number; at?: number; headwear?: string }
export interface ContactModel {
  props: PropInfo[];
  /** Bones whose world matrices measure() reads. */
  watch: number[];
  /** How much deeper than at rest each prop sits in the head and torso (meters; <= 0 means no new contact). */
  measure(matrix: (bone: number) => THREE.Matrix4): PropDepth[];
}

/** Skinned vertices grouped by their dominant bone, in that bone's own space, for the pose currently applied. */
function shapesByBone(asset: CharacterAsset, wanted: Set<number>, cap = 300): Map<number, THREE.Vector3[]> {
  const out = new Map<number, THREE.Vector3[]>();
  const meshes: THREE.SkinnedMesh[] = [];
  asset.root.traverse(o => { if (o instanceof THREE.SkinnedMesh) meshes.push(o); });
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position'), index = mesh.geometry.getAttribute('skinIndex'), weight = mesh.geometry.getAttribute('skinWeight');
    if (!pos || !index || !weight) continue;
    mesh.skeleton.update();
    const map = mesh.skeleton.bones.map(b => asset.bones.indexOf(b));
    const stride = Math.max(1, Math.floor(pos.count / 20000));
    for (let i = 0; i < pos.count; i += stride) {
      let best = -1, top = 0;
      for (let k = 0; k < 4; k++) { const w = weight.getComponent(i, k); if (w > top) { top = w; best = map[index.getComponent(i, k)] ?? -1; } }
      if (best < 0 || top < .5 || !wanted.has(best)) continue;
      mesh.applyBoneTransform(i, v.fromBufferAttribute(pos, i));
      const list = out.get(best) ?? [];
      list.push(asset.bones[best].worldToLocal(mesh.localToWorld(v.clone())));
      out.set(best, list);
    }
  }
  for (const [bone, list] of out) if (list.length > cap) { const every = Math.ceil(list.length / cap); out.set(bone, list.filter((_, i) => i % every === 0)); }
  return out;
}

export const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0; };

const cache = new WeakMap<CharacterAsset, ContactModel>();
export function contactModel(asset: CharacterAsset, parts: BodyParts): ContactModel {
  const cached = cache.get(asset);
  if (cached) return cached;
  const original = capturePose(asset);
  try {
    applyPose(asset, asset.restPose); asset.root.updateMatrixWorld(true);
    const model = build(asset, parts);
    cache.set(asset, model);
    return model;
  } finally { applyPose(asset, original); asset.root.updateMatrixWorld(true); }
}

function build(asset: CharacterAsset, parts: BodyParts): ContactModel {
  const limbBones = new Set(parts.limbs.flatMap(l => [l.upper, l.mid, l.tip]));
  const body = new Set<number>([...Object.values(parts.roles), ...parts.torso, ...limbBones]);
  const hands = new Set(parts.limbs.filter(l => /Hand$/.test(l.end)).map(l => l.tip));
  const hips = parts.roles.hips, head = parts.roles.head, neck = parts.roles.neck ?? parts.roles.chest, chest = parts.roles.chest ?? neck;
  const torsoBones = new Set([...parts.torso, ...(hips !== undefined ? [hips] : [])]);
  const candidates = asset.bones.map((bone, i) => body.has(i) || isFingerBone(bone.name) ? -1 : i).filter(i => i >= 0);
  const shapes = shapesByBone(asset, new Set([...candidates, ...(head !== undefined ? [head] : []), ...torsoBones]));
  const props: PropInfo[] = candidates.filter(i => shapes.get(i)?.length).map(i => {
    let carrier: number | undefined;
    const rigidTo = new Set<number>();
    for (let node = asset.bones[i].parent, crossedLimb = false; node instanceof THREE.Bone; node = node.parent) {
      const j = asset.bones.indexOf(node);
      if (carrier === undefined && hands.has(j)) carrier = j;
      if (limbBones.has(j)) crossedLimb = true;
      if (!crossedLimb) rigidTo.add(j);
    }
    const points = shapes.get(i)!, size = new THREE.Box3().setFromPoints(points).getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? new THREE.Vector3(1, 0, 0) : size.y >= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    return { bone: i, name: asset.bones[i].name, carrier, rigidTo, points, axis };
  });

  const headPoints = head !== undefined ? shapes.get(head) ?? [] : [];
  const headCenter = headPoints.length ? headPoints.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(headPoints.length) : null;
  const headRadius = headCenter ? percentile(headPoints.map(p => p.distanceTo(headCenter)), .75) : 0;
  // Hats, helmets and horns count as part of the head: a weapon must not pass through a hat brim either.
  // Built in rest-pose world meters (bones may be scaled); a point is mapped back into that rest frame to test it.
  const headwear = head === undefined ? [] : props.filter(p => p.carrier === undefined && p.rigidTo.has(head)).map(p => {
    const rest = asset.bones[p.bone].matrixWorld.clone();
    return { prop: p, rest, inside: ringShape(p.points.map(q => q.clone().applyMatrix4(rest))) };
  });
  const torso = hips !== undefined && neck !== undefined && chest !== undefined ? torsoShape(asset, chest, asset.bones[hips].getWorldPosition(new THREE.Vector3()), asset.bones[neck].getWorldPosition(new THREE.Vector3()), [...torsoBones].flatMap(b => (shapes.get(b) ?? []).map(p => asset.bones[b].localToWorld(p.clone())))) : null;

  const depthOf = (prop: PropInfo, matrix: (bone: number) => THREE.Matrix4) => {
    let inHead = -Infinity, inTorso = -Infinity, floor = Infinity, deepest: THREE.Vector3 | null = null, deepestBy = -Infinity;
    const center = headCenter && head !== undefined && !prop.rigidTo.has(head) ? headCenter.clone().applyMatrix4(matrix(head)) : null;
    const inTorsoOf = torso && ![...torsoBones].some(b => prop.rigidTo.has(b)) ? torso.depth(matrix(chest!)) : null;
    const w = new THREE.Vector3(), m = matrix(prop.bone), local = new THREE.Vector3();
    const worn = headwear.filter(h => h.prop !== prop && !prop.rigidTo.has(h.prop.bone)).map(h => ({ ...h, toLocal: h.rest.clone().multiply(matrix(h.prop.bone).clone().invert()) }));
    let headwearName: string | undefined, headwearDepth = -Infinity;
    for (const p of prop.points) {
      w.copy(p).applyMatrix4(m);
      floor = Math.min(floor, w.y);
      let h = center ? headRadius - w.distanceTo(center) : -Infinity;
      const t = inTorsoOf ? inTorsoOf(w) : -Infinity;
      for (const hw of worn) {
        const d = hw.inside(local.copy(w).applyMatrix4(hw.toLocal));
        if (d > h) h = d;
        if (d > headwearDepth) { headwearDepth = d; headwearName = hw.prop.name; }
      }
      inHead = Math.max(inHead, h); inTorso = Math.max(inTorso, t);
      if (Math.max(h, t) > deepestBy) { deepestBy = Math.max(h, t); deepest = w.clone(); }
    }
    // Where the deepest point sits on the prop, measured from the hand along the prop's long axis.
    const at = prop.carrier !== undefined && deepest
      ? Math.abs(deepest.sub(new THREE.Vector3().setFromMatrixPosition(matrix(prop.carrier))).dot(prop.axis.clone().transformDirection(m)))
      : undefined;
    return { head: inHead, torso: inTorso, floor, at, headwear: headwearDepth > 0 && headwearDepth >= inHead ? headwearName : undefined };
  };
  const rest = new Map(props.map(p => [p.bone, depthOf(p, i => asset.bones[i].matrixWorld)]));
  return {
    props,
    watch: [...new Set([...props.flatMap(p => [p.bone, ...(p.carrier !== undefined ? [p.carrier] : [])]), ...[head, chest].filter((b): b is number => b !== undefined)])],
    measure(matrix) {
      return props.map(prop => {
        const d = depthOf(prop, matrix), base = rest.get(prop.bone)!;
        return { name: prop.name, carried: prop.carrier !== undefined, head: d.head - Math.max(0, base.head), torso: d.torso - Math.max(0, base.torso), floor: d.floor, at: d.at, headwear: d.headwear };
      });
    },
  };
}

/**
 * A worn prop (a hat: crown on a brim) as rings stacked up the world vertical, each ring as wide as the mesh at that
 * height. The points are in rest-pose world space, where a hat sits upright on the head, so world up is its axis
 * whatever its proportions (a tall pointed hat is taller than it is deep). Returns how far a point sits inside it:
 * the smaller of the way in from the ring's edge and the way in from the nearest open end, so a shaft skimming the
 * thin brim reads as a few centimeters, not the brim's whole radius. Negative or -Infinity outside.
 */
function ringShape(points: THREE.Vector3[]) {
  const ROWS = 8;
  const box = new THREE.Box3().setFromPoints(points), mid = box.getCenter(new THREE.Vector3());
  const height = Math.max(box.max.y - box.min.y, 1e-4), row = height / ROWS;
  const rowOf = (y: number) => Math.min(ROWS - 1, Math.floor((y - box.min.y) / row));
  const radii = Array.from({ length: ROWS }, () => [] as number[]);
  for (const p of points) radii[rowOf(p.y)].push(Math.hypot(p.x - mid.x, p.z - mid.z));
  // A low-poly hat can leave rows with no vertices (a crown with only a base ring and a tip): blend across those
  // gaps from the nearest filled rows, so the volume has no hollow bands a prop could slip through.
  const filled = radii.map(r => r.length ? percentile(r, .9) : NaN);
  const radius = filled.map((r, i) => {
    if (!Number.isNaN(r)) return r;
    let lo = i, hi = i;
    while (lo >= 0 && Number.isNaN(filled[lo])) lo--;
    while (hi < ROWS && Number.isNaN(filled[hi])) hi++;
    if (lo < 0 && hi >= ROWS) return -Infinity;
    if (lo < 0) return filled[hi];
    if (hi >= ROWS) return filled[lo];
    return filled[lo] + (filled[hi] - filled[lo]) * (i - lo) / (hi - lo);
  });
  return (p: THREE.Vector3) => {
    if (p.y < box.min.y || p.y > box.max.y) return -Infinity;
    const i = rowOf(p.y), side = radius[i] - Math.hypot(p.x - mid.x, p.z - mid.z);
    if (side <= 0) return side;
    // A ring that is wider than both its neighbours is a lip (the brim): only as thick as its own row.
    let lo = i, hi = i;
    while (lo > 0 && radius[lo - 1] > radius[i] - side) lo--;
    while (hi < ROWS - 1 && radius[hi + 1] > radius[i] - side) hi++;
    const ends = Math.min(p.y - (box.min.y + lo * row), box.min.y + (hi + 1) * row - p.y);
    return Math.min(side, ends);
  };
}

/**
 * The torso as a tube around the hips-to-neck line whose radius depends on height and on direction around the spine,
 * read from the real torso mesh, so a body that is wider than it is deep (and a coat) is not a round capsule. Kept in the
 * chest's rigid frame so it bends and twists with the upper body.
 */
function torsoShape(asset: CharacterAsset, chest: number, hipsAt: THREE.Vector3, neckAt: THREE.Vector3, points: THREE.Vector3[]) {
  const ROWS = 5, SECTORS = 12;
  const rigid = (m: THREE.Matrix4) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(); m.decompose(p, q, new THREE.Vector3()); return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)); };
  const toChest = rigid(asset.bones[chest].matrixWorld).invert();
  const a = hipsAt.clone().applyMatrix4(toChest), b = neckAt.clone().applyMatrix4(toChest);
  const ab = b.clone().sub(a), len2 = ab.lengthSq();
  const u = new THREE.Vector3(1, 0, 0).projectOnPlane(ab.clone().normalize());
  if (u.lengthSq() < 1e-6) u.set(0, 0, 1).projectOnPlane(ab.clone().normalize());
  u.normalize();
  const v = ab.clone().normalize().cross(u);
  /** Height along the axis (0 hips, 1 neck, unclamped), sector and distance from the axis, in the chest frame. */
  const locate = (q: THREE.Vector3) => {
    const t = q.clone().sub(a).dot(ab) / len2, off = q.clone().sub(a.clone().addScaledVector(ab, Math.max(0, Math.min(1, t))));
    const angle = Math.atan2(off.dot(v), off.dot(u));
    return { t, row: Math.max(0, Math.min(ROWS - 1, Math.floor(t * ROWS))), sector: (Math.floor((angle + Math.PI) / (2 * Math.PI) * SECTORS) + SECTORS) % SECTORS, dist: off.length() };
  };
  const bins: number[][] = Array.from({ length: ROWS * SECTORS }, () => []);
  for (const p of points) { const at = locate(p.clone().applyMatrix4(toChest)); if (at.t >= 0 && at.t <= 1) bins[at.row * SECTORS + at.sector].push(at.dist); }
  const all = bins.flat();
  // Most of the surface, not its loose edges (a flared coat hem or a stray strap).
  const radius = bins.map(list => percentile(list.length >= 4 ? list : all, .6));
  return {
    depth(chestMatrix: THREE.Matrix4) {
      const into = rigid(chestMatrix).invert();
      return (w: THREE.Vector3) => { const at = locate(w.clone().applyMatrix4(into)); return at.t < 0 || at.t > 1 ? -Infinity : radius[at.row * SECTORS + at.sector] - at.dist; };
    },
  };
}

/** Advice for a prop that cuts into the body. */
export const clipAdvice = (depth: PropDepth) => depth.carried
  ? depth.at === undefined || depth.at > .15
    ? `the deepest point is ${(depth.at ?? 0).toFixed(2)} m along it from the hand: turn that end away from the body or slide the grip (pose.intent grip along)`
    : depth.headwear
      ? `the hands themselves are at the ${depth.headwear}: carry them higher or further out to the side so the shaft passes beside it`
      : 'the hands themselves are in the body: hold it further out (reach the hands away from the chest)'
  : `turn it where it is strapped (pose.intent turn on "${depth.name}") or change the pose around it`;
