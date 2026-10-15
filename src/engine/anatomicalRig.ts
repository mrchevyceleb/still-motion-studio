import * as THREE from 'three';
import type { RigKind, Vec3 } from '../types';
import type { HandFitInfo } from './handRig';

export interface RigJointSpec { name: string; parent?: string; position: Vec3 }
export interface AutoRigDiagnostics {
  version: 1;
  method: 'geometry-sections' | 'creature-chains';
  bodyType: RigKind;
  evidence: 'clear' | 'limited';
  reviewRequired: true;
  sampledVertices: number;
  measurements: Record<string, number>;
  warnings: string[];
  maxBindError?: number;
  maxBendDisplacement?: number;
  hands?: HandFitInfo[];
}
export interface AnatomicalFit { joints: RigJointSpec[]; diagnostics: AutoRigDiagnostics }

type Point = { x: number; y: number; z: number };
const quantile = (values: number[], fraction: number): number => {
  if (!values.length) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
};
const center = (points: Point[], fallback: Point): Point => points.length < 3 ? fallback : ({
  x: quantile(points.map(p => p.x), .5),
  y: quantile(points.map(p => p.y), .5),
  z: quantile(points.map(p => p.z), .5),
});
const clamp = THREE.MathUtils.clamp;

/** Fits neutral-pose geometry, not learned anatomical inference. Coordinates are
 * normalized by height, so fitting and validation do not depend on FBX units. */
export function fitAnatomicalRig(kind: RigKind, vertices: THREE.Vector3[], bounds: THREE.Box3): AnatomicalFit {
  const size = bounds.getSize(new THREE.Vector3());
  const origin = bounds.getCenter(new THREE.Vector3());
  if (!(size.y > 1e-7) || ![size.x, size.y, size.z].every(Number.isFinite)) {
    throw new Error('This mesh has no usable height. Import an upright character with real 3D geometry.');
  }
  const points: Point[] = vertices.map(p => ({ x: (p.x - origin.x) / size.y, y: (p.y - bounds.min.y) / size.y, z: (p.z - origin.z) / size.y }));
  const warnings: string[] = [];
  const measurements: Record<string, number> = { widthToHeight: size.x / size.y, depthToHeight: size.z / size.y };
  if (size.x / size.y < .08 || size.z / size.y < .012 || Math.max(size.x, size.z) / size.y > 3) {
    throw new Error('The mesh is flat, extremely stretched, or lying on its side. Stand it on its feet with Y up before adding a rig.');
  }
  const joints: RigJointSpec[] = [];
  const add = (name: string, parent: string | undefined, p: Point): void => {
    joints.push({ name, ...(parent ? { parent } : {}), position: [origin.x + p.x * size.y, bounds.min.y + p.y * size.y, origin.z + p.z * size.y] });
  };
  const section = (low: number, high: number, predicate: (p: Point) => boolean = () => true) => points.filter(p => p.y >= low && p.y <= high && predicate(p));
  const lower = section(.06, .28);
  if (lower.length < 20) throw new Error('The feet and lower legs could not be found. Use a complete, upright neutral-pose character.');
  if (kind === 'humanoid') {
    if (size.z / size.y > .85) throw new Error('This shape does not have an upright humanoid profile. Choose the correct body type and remove floor planes or large props.');
    const waist = section(.48, .65);
    if (waist.length < 20) throw new Error('The torso could not be found. Use a complete character in an A-pose or T-pose.');
    // Prefer the central torso cluster rather than treating outstretched arms as
    // body width. The median depth is robust to a nose, backpack or breasts.
    const torsoX = quantile(waist.map(p => p.x), .5);
    const centralWaist = waist.filter(p => Math.abs(p.x - torsoX) < .20);
    const halfTorso = clamp(quantile(centralWaist.map(p => Math.abs(p.x - torsoX)), .94), .065, .19);
    const torsoZ = quantile(centralWaist.map(p => p.z), .5);
    const legSection = lower.filter(p => Math.abs(p.x - torsoX) < .27);
    const centerBridge = legSection.filter(p => Math.abs(p.x - torsoX) < .012).length / Math.max(1, legSection.length);
    const negative = legSection.filter(p => p.x < torsoX);
    const positive = legSection.filter(p => p.x > torsoX);
    if (negative.length < 8 || positive.length < 8) throw new Error('Two legs could not be found. Separate the feet slightly and use an upright A-pose or T-pose.');
    const innerGap = quantile(positive.map(p => p.x), .04) - quantile(negative.map(p => p.x), .96);
    measurements.lowerLegGap = innerGap;
    measurements.torsoHalfWidth = halfTorso;
    if (innerGap < .008 || centerBridge > .04) throw new Error('Two separate lower legs could not be identified. Separate the feet slightly and use a complete upright character without a floor plane.');
    if (innerGap < .025) warnings.push('The legs are close together in this pose. Check the inner thighs and separate the feet if bending pulls the opposite leg.');
    const hips: Point = { x: torsoX, y: .49, z: torsoZ };
    // Detect the highest separated leg section: this adapts to long legs and
    // short torsos instead of assuming a fixed pelvis percentage.
    let crotch = .40;
    for (let y = .30; y <= .55; y += .025) {
      const band = section(y, y + .025, p => Math.abs(p.x - torsoX) < halfTorso * 1.15);
      const left = band.filter(p => p.x > torsoX);
      const right = band.filter(p => p.x < torsoX);
      const joined = band.filter(p => Math.abs(p.x - torsoX) < .012).length / Math.max(1, band.length);
      if (joined < .01 && left.length > 4 && right.length > 4 && quantile(left.map(p => p.x), .03) - quantile(right.map(p => p.x), .97) > .018) crotch = y;
    }
    hips.y = clamp(crotch + .075, .43, .60);
    measurements.hipHeight = hips.y;
    add('Hips', undefined, hips);
    add('Spine', 'Hips', { x: torsoX, y: hips.y + (.73 - hips.y) * .42, z: torsoZ });
    add('Spine1', 'Spine', { x: torsoX, y: .73, z: torsoZ });
    const head = center(section(.86, .985, p => Math.abs(p.x - torsoX) < .18), { x: torsoX, y: .91, z: torsoZ });
    add('Neck', 'Spine1', { x: head.x, y: .825, z: head.z });
    add('Head', 'Neck', { ...head, y: clamp(head.y, .87, .95) });
    for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
      const arm = section(.35, .88, p => (p.x - torsoX) * sign > halfTorso * 1.12);
      const reach = quantile(arm.map(p => (p.x - torsoX) * sign), .95);
      if (arm.length < 12 || reach - halfTorso < .075) {
        throw new Error(`The ${side.toLowerCase()} arm overlaps the body or cannot be identified. Use an A-pose or T-pose with both arms clear of the torso.`);
      }
      const distal = arm.filter(p => (p.x - torsoX) * sign > reach * .86);
      const hand = center(distal, { x: torsoX + sign * reach, y: .70, z: torsoZ });
      // Regress the arm centerline to distinguish A-pose from T-pose. Fitting
      // never rotates or changes the source mesh to match a template pose.
      const meanX = arm.reduce((sum, p) => sum + (p.x - torsoX) * sign, 0) / arm.length;
      const meanY = arm.reduce((sum, p) => sum + p.y, 0) / arm.length;
      const variance = arm.reduce((sum, p) => sum + ((p.x - torsoX) * sign - meanX) ** 2, 0);
      const slope = variance > 1e-8 ? arm.reduce((sum, p) => sum + ((p.x - torsoX) * sign - meanX) * (p.y - meanY), 0) / variance : 0;
      const shoulderY = clamp(meanY + slope * (halfTorso - meanX), .68, .83);
      const shoulder: Point = { x: torsoX + sign * halfTorso, y: shoulderY, z: torsoZ };
      add(`${side}Shoulder`, 'Spine1', { ...shoulder, x: torsoX + sign * halfTorso * .56 });
      add(`${side}Arm`, `${side}Shoulder`, shoulder);
      const elbow: Point = { x: (shoulder.x + hand.x) * .5, y: (shoulder.y + hand.y) * .5, z: (shoulder.z + hand.z) * .5 };
      add(`${side}ForeArm`, `${side}Arm`, elbow);
      add(`${side}Hand`, `${side}ForeArm`, hand);
      measurements[`${side.toLowerCase()}ArmReach`] = reach;
      const atHeight = (y: number, fallback: Point) => center(section(y - .035, y + .035, p => (p.x - torsoX) * sign > .005 && Math.abs(p.x - torsoX) < .27), fallback);
      const ankle = atHeight(.075, { x: torsoX + sign * .08, y: .075, z: torsoZ });
      const kneeY = (hips.y + ankle.y) * .51;
      const knee = atHeight(kneeY, { x: ankle.x, y: kneeY, z: ankle.z });
      const upper = atHeight(hips.y - .025, { x: ankle.x, y: hips.y - .025, z: torsoZ });
      add(`${side}UpLeg`, 'Hips', { x: upper.x, y: hips.y - .025, z: upper.z });
      add(`${side}Leg`, `${side}UpLeg`, { x: knee.x, y: kneeY, z: knee.z });
      add(`${side}Foot`, `${side}Leg`, { x: ankle.x, y: .065, z: ankle.z });
      const foot = section(0, .07, p => (p.x - torsoX) * sign > .005 && Math.abs(p.x - ankle.x) < .09);
      const toeZ = Math.max(ankle.z + .025, quantile(foot.map(p => p.z), .86));
      add(`${side}ToeBase`, `${side}Foot`, { x: ankle.x, y: .025, z: toeZ });
    }
    warnings.push('Geometry fitting found the torso, arms and legs. Check shoulders, elbows and knees with a small bend; clothing and hidden anatomy can shift these estimates.');
  } else {
    const midX = quantile(lower.map(p => p.x), .5);
    const midZ = quantile(lower.map(p => p.z), .5);
    const leftLower = lower.filter(p => p.x > midX), rightLower = lower.filter(p => p.x < midX);
    const frontLower = lower.filter(p => p.z > midZ), hindLower = lower.filter(p => p.z < midZ);
    const acrossGap = quantile(leftLower.map(p => p.x), .04) - quantile(rightLower.map(p => p.x), .96);
    const lengthGap = quantile(frontLower.map(p => p.z), .04) - quantile(hindLower.map(p => p.z), .96);
    if (acrossGap < .008 || lengthGap < .02) throw new Error('Four separate lower legs could not be identified. Use a standing quadruped without a floor plane and with space between its feet.');
    const feet: Record<string, Point> = {};
    for (const [pair, forward] of [['Front', 1], ['Hind', -1]] as const) for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
      const cloud = lower.filter(p => (p.x - midX) * sign > .005 && (p.z - midZ) * forward > .015);
      if (cloud.length < 8) throw new Error('Four separate legs could not be found. Use a standing quadruped with Y up, its head toward +Z, and all four feet visible.');
      feet[`${pair}${side}`] = center(cloud, { x: midX + sign * .10, y: .08, z: midZ + forward * .30 });
    }
    const frontZ = (feet.FrontLeft.z + feet.FrontRight.z) * .5;
    const hindZ = (feet.HindLeft.z + feet.HindRight.z) * .5;
    const sideWidth = (Math.abs(feet.FrontLeft.x - feet.FrontRight.x) + Math.abs(feet.HindLeft.x - feet.HindRight.x)) * .5;
    if (frontZ - hindZ < .22 || sideWidth < .055) throw new Error('The four-leg stance is too compressed to fit safely. Separate the feet and face the model toward +Z.');
    const trunk = points.filter(p => p.y > .32 && p.y < .82 && p.z > hindZ && p.z < frontZ && Math.abs(p.x - midX) < sideWidth * .55);
    const trunkCenter = center(trunk, { x: midX, y: .57, z: midZ });
    const bodyY = clamp(trunkCenter.y, .43, .72);
    measurements.bodyHeight = bodyY;
    measurements.frontHindSpacing = frontZ - hindZ;
    measurements.leftRightSpacing = sideWidth;
    add('Hips', undefined, { x: midX, y: bodyY, z: hindZ });
    add('Spine', 'Hips', { x: midX, y: bodyY, z: frontZ });
    const headCloud = points.filter(p => p.z > frontZ + .04 && p.y > bodyY * .9 && Math.abs(p.x - midX) < sideWidth * .65);
    const head = center(headCloud, { x: midX, y: bodyY + .17, z: frontZ + .23 });
    add('Neck', 'Spine', { x: midX, y: bodyY + (head.y - bodyY) * .55, z: frontZ + (head.z - frontZ) * .45 });
    add('Head', 'Neck', head);
    const tailCloud = points.filter(p => p.z < hindZ - .10 && p.y > .25);
    const tail = center(tailCloud, { x: midX, y: bodyY, z: hindZ - .15 });
    add('Tail', 'Hips', { x: midX, y: bodyY, z: hindZ - .06 });
    add('TailTip', 'Tail', tail);
    if (headCloud.length < 12) warnings.push('The head is not clearly in front of the front legs. Confirm that the animal faces +Z and check the neck and head joints.');
    if (tailCloud.length < 12) warnings.push('No distinct tail was found; the optional tail joints may remain unused.');
    for (const [pair, z, parent] of [['Front', frontZ, 'Spine'], ['Hind', hindZ, 'Hips']] as const) for (const side of ['Left', 'Right']) {
      const foot = feet[`${pair}${side}`];
      const kneeY = bodyY * .53;
      const legCloud = section(kneeY - .055, kneeY + .055, p => Math.abs(p.x - foot.x) < sideWidth * .35 && Math.abs(p.z - foot.z) < (frontZ - hindZ) * .23);
      const knee = center(legCloud, { ...foot, y: kneeY });
      add(`${pair}${side}UpperLeg`, parent, { x: foot.x, y: bodyY * .95, z });
      add(`${pair}${side}LowerLeg`, `${pair}${side}UpperLeg`, { ...knee, y: kneeY });
      add(`${pair}${side}Foot`, `${pair}${side}LowerLeg`, { ...foot, y: .065 });
    }
    warnings.push('Geometry fitting located the four feet and trunk. Check hocks, shoulders, neck and tail; animal anatomy varies and these are estimated joints.');
  }
  for (const joint of joints) if (!joint.position.every(Number.isFinite)) throw new Error('The mesh produced an invalid joint position. Re-export a clean neutral-pose mesh.');
  return { joints, diagnostics: { version: 1, method: 'geometry-sections', bodyType: kind, evidence: warnings.length > 1 ? 'limited' : 'clear', reviewRequired: true, sampledVertices: points.length, measurements, warnings } };
}

/** Restrict nearby-but-unconnected limbs from pulling each other's skin. The
 * nearest branch owns the vertex; its parent torso joints can blend at a seam. */
export function influenceFamily(name: string): string {
  const branch = name.match(/^Chain\d+_/);
  if (branch) return branch[0];
  const finger = name.match(/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)/);
  if (finger) return `${finger[1]}Hand${finger[2]}`;
  const quad = name.match(/^(Front|Hind)(Left|Right)/);
  if (quad) return quad[0];
  const humanoid = name.match(/^(Left|Right)(Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot|ToeBase)/);
  if (humanoid) return humanoid[1] + (/^(Shoulder|Arm|ForeArm|Hand)$/.test(humanoid[2]) ? 'Arm' : 'Leg');
  if (/^Tail/.test(name)) return 'Tail';
  return 'Torso';
}
