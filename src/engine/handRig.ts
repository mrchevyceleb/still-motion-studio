import { Box3, Vector3 } from 'three';
import type { AnatomicalFit, RigJointSpec } from './anatomicalRig';
import type { Vec3 } from '../types';

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const;
export type HandSide = 'Left' | 'Right';
export type LandmarkConfidence = 'detected' | 'estimated' | 'manual';
export interface DigitFitInfo { finger: typeof FINGERS[number]; landmarks: Record<'1' | '2' | '3' | 'End', LandmarkConfidence> }
export interface HandFitInfo { side: HandSide; detectedTips: number; status: 'detected' | 'estimated'; digits?: DigitFitInfo[]; region?: { min: Vec3; max: Vec3 } }
export const isFingerBone = (name: string) => /finger|thumb|hand(?:index|middle|ring|pinky|little)|pinky|(?:^|[_. -])(?:index|middle|ring|little)(?:[_. -]|\d)/i.test(name);

interface Point { position: Vector3; along: number; across: number; depth: number }
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** Voxel flood fill separates exposed digits without depending on mesh indexing. */
function components(points: Point[], cell: number): Point[][] {
  const bins = new Map<string, Point[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const p of points) {
    const k = key(Math.floor(p.position.x / cell), Math.floor(p.position.y / cell), Math.floor(p.position.z / cell));
    const bin = bins.get(k); if (bin) bin.push(p); else bins.set(k, [p]);
  }
  const result: Point[][] = [];
  while (bins.size) {
    const first = bins.keys().next().value!;
    const queue = [first], group: Point[] = [];
    for (let head = 0; head < queue.length; head++) {
      const k = queue[head], bin = bins.get(k);
      if (!bin) continue;
      bins.delete(k); group.push(...bin);
      const [x, y, z] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const neighbor = key(x + dx, y + dy, z + dz);
        if (bins.has(neighbor)) queue.push(neighbor);
      }
    }
    if (group.length >= 3) result.push(group);
  }
  return result.sort((a, b) => b.length - a.length);
}

function principalWidth(points: Vector3[], forward: Vector3) {
  const mean = points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / Math.max(1, points.length));
  let axis = new Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
  if (axis.lengthSq() < .01) axis.set(0, 0, 1).addScaledVector(forward, -forward.z);
  axis.normalize();
  for (let iteration = 0; iteration < 12; iteration++) {
    const next = new Vector3();
    for (const p of points) { const delta = p.clone().sub(mean); next.addScaledVector(delta, delta.dot(axis)); }
    next.addScaledVector(forward, -next.dot(forward));
    if (next.lengthSq() < 1e-14) break;
    axis.copy(next.normalize());
  }
  // A stable sign makes the default mirrored hands use corresponding labels.
  if (axis.y < 0 || Math.abs(axis.y) < .1 && axis.z < 0) axis.negate();
  return axis;
}

/** Estimate a five-digit hand from neutral geometry; unresolved digits remain
 * explicitly marked estimates and can be repositioned before skin binding. */
export function fitHandRig(fit: AnatomicalFit, vertices: Vector3[], bounds: Box3): AnatomicalFit {
  const joints = structuredClone(fit.joints), hands: HandFitInfo[] = [], warnings = [...fit.diagnostics.warnings];
  const height = bounds.getSize(new Vector3()).y;
  for (const side of ['Left', 'Right'] as const) {
    const palm = joints.find(j => j.name === `${side}Hand`), elbow = joints.find(j => j.name === `${side}ForeArm`);
    if (!palm || !elbow) throw new Error(`The ${side.toLowerCase()} hand needs an arm and wrist first.`);
    const handPoint = new Vector3().fromArray(palm.position), elbowPoint = new Vector3().fromArray(elbow.position);
    const forward = handPoint.clone().sub(elbowPoint).normalize();
    if (forward.lengthSq() < .9) throw new Error('The wrist and elbow overlap. Separate the arms before fitting fingers.');
    const reach = handPoint.distanceTo(elbowPoint);
    const candidates = vertices.filter(p => {
      const delta = p.clone().sub(elbowPoint), along = delta.dot(forward);
      return along > reach * .65 && delta.addScaledVector(forward, -along).length() < height * .10;
    });
    const width = principalWidth(candidates, forward), normal = forward.clone().cross(width).normalize();
    const projected: Point[] = candidates.map(position => {
      const delta = position.clone().sub(elbowPoint);
      return { position, along: delta.dot(forward), across: delta.dot(width), depth: delta.dot(normal) };
    });
    const far = projected.length ? Math.max(...projected.map(p => p.along)) : reach + height * .035;
    const length = Math.min(height * .13, Math.max(height * .085, reach * .65));
    const wristAt = Math.max(reach * .65, far - length);
    const handCloud = projected.filter(p => p.along >= wristAt);
    const widthCenter = median(handCloud.map(p => p.across)), depthCenter = median(handCloud.map(p => p.depth));
    const wrist = elbowPoint.clone().addScaledVector(forward, wristAt).addScaledVector(width, widthCenter).addScaledVector(normal, depthCenter);
    palm.position = wrist.toArray();
    let best: Point[][] = [];
    for (const cut of [.30, .42, .54, .66, .78]) {
      const exposed = handCloud.filter(p => p.along >= wristAt + length * cut);
      for (const cell of [height * .0025, height * .004]) {
        const groups = components(exposed, cell).filter(g => Math.max(...g.map(p => p.along)) - Math.min(...g.map(p => p.along)) > height * .005);
        if (groups.length >= 4 && groups.length <= 5 && groups.length > best.length) best = groups;
      }
    }
    // A short, off-axis branch is a thumb; do not relabel a long finger as one.
    const branchTip = (group: Point[]) => {
      const end = Math.max(...group.map(p => p.along));
      const cap = group.filter(p => p.along >= end - height * .004);
      return { along: end, across: median(cap.map(p => p.across)), depth: median(cap.map(p => p.depth)) };
    };
    const tips = best.map(branchTip).sort((a, b) => b.across - a.across);
    let thumb = tips.length === 5 ? tips.reduce((a, b) => a.along < b.along ? a : b) : undefined;
    const longest = tips.length ? Math.max(...tips.map(t => t.along)) : far;
    if (thumb && (longest - thumb.along < length * .15 || Math.abs(thumb.across - widthCenter) < height * .012)) thumb = undefined;
    const longTips = tips.filter(t => t !== thumb);
    const detected = longTips.length === 4 ? longTips : [];
    const thumbSign = thumb ? Math.sign(thumb.across - widthCenter) || 1 : 1;
    detected.sort((a, b) => thumbSign * (b.across - a.across));
    const handWidth = Math.min(height * .06, Math.max(height * .032, handCloud.length ? Math.max(...handCloud.map(p => p.across)) - Math.min(...handCloud.map(p => p.across)) : 0));
    let detectedCount = detected.length + (thumb ? 1 : 0);
    if (!detected.length) { thumb = undefined; detectedCount = 0; }
    const digits: DigitFitInfo[] = [];
    const region = new Box3().setFromPoints(handCloud.map(p => p.position)); region.expandByPoint(wrist);
    for (const [digit, finger] of FINGERS.entries()) {
      const isThumb = digit === 0;
      const tip = isThumb ? thumb : detected[digit - 1];
      const across = tip?.across ?? widthCenter + thumbSign * handWidth * (isThumb ? .7 : [.3, .1, -.1, -.3][digit - 1]);
      const depth = tip?.depth ?? depthCenter;
      const tipAlong = tip?.along ?? wristAt + length * (isThumb ? .57 : [.88, 1, .92, .75][digit - 1]);
      const baseAcross = widthCenter + (across - widthCenter) * (isThumb ? .55 : .85);
      const baseAlong = wristAt + length * (isThumb ? .20 : .45);
      const base = elbowPoint.clone().addScaledVector(forward, baseAlong).addScaledVector(width, baseAcross).addScaledVector(normal, depthCenter);
      const end = elbowPoint.clone().addScaledVector(forward, tipAlong).addScaledVector(width, across).addScaledVector(normal, depth);
      if (base.distanceTo(end) < height * .008) end.addScaledVector(forward, height * .015);
      region.expandByPoint(base); region.expandByPoint(end);
      digits.push({ finger, landmarks: { '1': 'estimated', '2': 'estimated', '3': 'estimated', End: tip ? 'detected' : 'estimated' } });
      let parent = palm.name;
      for (const [segment, fraction] of [0, .43, .76, 1].entries()) {
        const name = `${side}Hand${finger}${segment === 3 ? 'End' : segment + 1}`;
        joints.push({ name, parent, position: base.clone().lerp(end, fraction).toArray() }); parent = name;
      }
    }
    region.expandByScalar(height * .025);
    hands.push({ side, detectedTips: detectedCount, status: detectedCount === 5 ? 'detected' : 'estimated', digits, region: { min: region.min.toArray(), max: region.max.toArray() } });
    if (detectedCount < 5) warnings.push(`${side} hand: ${detectedCount}/5 separated fingertips found. Finger joints are estimates; adjust them in the hand preview before binding. Use open, separated fingers for better detection.`);
  }
  warnings.push('Finger skin weights separate each digit. Inspect a small finger bend; gloves, fused fingers and unusual anatomy need manual placement.');
  return { joints, diagnostics: { ...fit.diagnostics, hands, evidence: hands.some(h => h.status === 'estimated') ? 'limited' : fit.diagnostics.evidence, warnings } };
}

/** Validate all edited landmarks before any skin data is replaced. */
export function validateRigFit(fit: AnatomicalFit, bounds: Box3, kind: 'humanoid' | 'quadruped' | 'creature') {
  if (!fit || fit.diagnostics.bodyType !== kind || !Array.isArray(fit.joints) || fit.joints.length < 1 || fit.joints.length > 150) throw new Error('The rig preview does not match this character. Detect it again.');
  const names = new Map<string, RigJointSpec>();
  const height = bounds.getSize(new Vector3()).y;
  const allowed = bounds.clone().expandByScalar(height * .1);
  for (const j of fit.joints) {
    if (!j || typeof j.name !== 'string' || names.has(j.name) || !Array.isArray(j.position) || j.position.length !== 3 || !j.position.every(Number.isFinite) || !allowed.containsPoint(new Vector3().fromArray(j.position))) throw new Error('A joint is invalid or too far outside the mesh. Correct its placement before binding.');
    if (j.parent && !names.has(j.parent)) throw new Error('The rig contains an invalid joint hierarchy. Detect it again.');
    if (j.parent && new Vector3().fromArray(j.position).distanceTo(new Vector3().fromArray(names.get(j.parent)!.position)) < height * 1e-5) throw new Error(`${j.name} overlaps its parent. Separate these joints before binding.`);
    names.set(j.name, j);
  }
  for (const side of ['Left', 'Right']) {
    if (!names.has(`${side}HandThumb1`)) continue;
    for (const finger of FINGERS) for (const segment of ['1', '2', '3', 'End']) if (!names.has(`${side}Hand${finger}${segment}`)) throw new Error('A finger chain is incomplete. Detect the hands again.');
    const wrist = new Vector3().fromArray(names.get(`${side}Hand`)!.position);
    const elbow = new Vector3().fromArray(names.get(`${side}ForeArm`)!.position);
    if (wrist.distanceTo(elbow) > height * .3) throw new Error(`${side} wrist is too far from its forearm. Correct its placement before binding.`);
    const info = fit.diagnostics.hands?.find(h => h.side === side);
    const local = info?.region ? new Box3(new Vector3().fromArray(info.region.min), new Vector3().fromArray(info.region.max)) : new Box3(wrist.clone().addScalar(-height * .18), wrist.clone().addScalar(height * .18));
    if (!local.containsPoint(wrist)) throw new Error(`${side} wrist is outside its hand area. Correct its placement before binding.`);
    for (const finger of FINGERS) {
      const chain = ['1', '2', '3', 'End'].map(segment => new Vector3().fromArray(names.get(`${side}Hand${finger}${segment}`)!.position));
      if (chain.some(p => !local.containsPoint(p) || p.distanceTo(wrist) > height * .18)) throw new Error(`${side} ${finger.toLowerCase()} is outside its hand area. Keep its joints on that hand.`);
      const axis = chain[3].clone().sub(chain[0]);
      if (axis.length() < height * .006) throw new Error(`${side} ${finger.toLowerCase()} has overlapping knuckle and tip. Separate them.`);
      axis.normalize();
      let total = 0;
      for (let i = 1; i < chain.length; i++) {
        const segment = chain[i].clone().sub(chain[i - 1]), length = segment.length(); total += length;
        if (length < height * .001 || length > height * .07 || segment.dot(axis) <= height * .0002) throw new Error(`${side} ${finger.toLowerCase()} joints must run from knuckle through middle and last joint to fingertip, with sensible spacing.`);
      }
      if (total > height * .16) throw new Error(`${side} ${finger.toLowerCase()} chain is too long. Check the joint positions.`);
    }
    const point = (finger: typeof FINGERS[number], segment: string) => new Vector3().fromArray(names.get(`${side}Hand${finger}${segment}`)!.position);
    for (let i = 0; i < FINGERS.length; i++) for (let j = i + 1; j < FINGERS.length; j++) {
      for (const segment of ['1', '2', '3', 'End']) {
        if (point(FINGERS[i], segment).distanceTo(point(FINGERS[j], segment)) < height * .001) throw new Error(`${side} ${FINGERS[i].toLowerCase()} and ${FINGERS[j].toLowerCase()} overlap. Separate their joints before binding.`);
      }
    }
    // Derive the fan direction from the edited index/pinky, allowing a whole
    // hand to be relabeled while rejecting a swapped pair within its fan.
    const order = ['Index', 'Middle', 'Ring', 'Pinky'] as const;
    for (const segment of ['1', 'End']) {
      const across = point('Index', segment).sub(point('Pinky', segment)).normalize();
      for (let i = 1; i < order.length; i++) {
        if (point(order[i - 1], segment).sub(point(order[i], segment)).dot(across) < height * .0002) throw new Error(`${side} fingers are crossed or out of order. Place index, middle, ring and pinky on their matching digits before binding.`);
      }
    }
  }
}
