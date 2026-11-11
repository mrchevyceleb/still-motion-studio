import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { isFingerBone } from './handRig';
import { bodyParts, frameFor } from './agentIntent';
import { clipAdvice, contactModel } from './bodyContact';
import type { CharacterAsset, Pose } from '../types';

/**
 * Animator-style checks an agent can read as text: sliding feet, floor
 * penetration, floaty jumps, single-frame pops, hyperextended knees,
 * off-balance holds, dead holds, props cutting into the body, broken wrists
 * and a second hand slipping off a held prop. Numbers are editor meters and seconds.
 */
export interface ReviewIssue { severity: 'high' | 'medium' | 'low'; kind: string; time: [number, number]; part?: string; message: string }
export interface MotionReview {
  duration: number; sampledFps: number; frames: number;
  issues: ReviewIssue[];
  summary: Record<string, unknown>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const range = (a: number, b: number): [number, number] => [r2(a), r2(b)];
const RANK = { high: 0, medium: 1, low: 2 };

function spans(flags: boolean[], minLength = 1): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((flag, i) => {
    if (flag && start < 0) start = i;
    if ((!flag || i === flags.length - 1) && start >= 0) {
      const end = flag ? i : i - 1;
      if (end - start + 1 >= minLength) out.push([start, end]);
      start = -1;
    }
  });
  return out;
}

function fallbackFeet(asset: CharacterAsset): number[] {
  const feet = asset.bones.map((b, i) => /foot|ankle|hoof|paw/i.test(b.name) && !/end|tip|ik|twist/i.test(b.name) ? i : -1).filter(i => i >= 0);
  return feet.length ? feet : asset.bones.map((b, i) => /toe/i.test(b.name) && !/end|tip/i.test(b.name) ? i : -1).filter(i => i >= 0);
}

/** Distance from a point to the convex hull of support points (0 when inside). */
function outside(point: THREE.Vector2, points: THREE.Vector2[]): number {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hull: THREE.Vector2[] = [];
  for (const pass of [sorted, [...sorted].reverse()]) {
    const start = hull.length;
    for (const q of pass) {
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], q) <= 0) hull.pop();
      hull.push(q);
    }
    hull.pop();
  }
  if (hull.length === 0) return point.distanceTo(points[0]);
  if (hull.length >= 3 && hull.every((a, i) => cross(a, hull[(i + 1) % hull.length], point) >= 0)) return 0;
  let best = Infinity;
  hull.forEach((a, i) => {
    const b = hull[(i + 1) % hull.length], ab = b.clone().sub(a);
    const t = ab.lengthSq() > 1e-12 ? Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / ab.lengthSq())) : 0;
    best = Math.min(best, point.distanceTo(a.clone().addScaledVector(ab, t)));
  });
  return best;
}

export function reviewMotion(asset: CharacterAsset, sample: (time: number) => Pose, start: number, end: number, fps: number, keys: { time: number; label?: string }[]): MotionReview {
  const original = capturePose(asset);
  try {
    const parts = bodyParts(asset);
    const nameOf = (index: number) => Object.entries(parts.roles).find(([, i]) => i === index)?.[0] ?? asset.bones[index].name;
    const span = Math.max(1e-3, end - start);
    const step = Math.max(1 / fps, span / 600);
    const times: number[] = [];
    for (let t = start; t < end - 1e-9; t += step) times.push(t);
    times.push(end);
    const n = times.length;
    const height = Math.max(.1, asset.height);
    const scale = height / 1.8;
    const feet = parts.feet.length ? parts.feet : fallbackFeet(asset);
    const hipsIndex = parts.roles.hips ?? asset.bones.findIndex(b => !(b.parent instanceof THREE.Bone));
    const tracked = asset.bones.map((bone, i) => !isFingerBone(bone.name) && !/end$|_end|tip$|leaf|twist|ik_|_ik|helper|socket|prop|weapon/i.test(bone.name) ? i : -1).filter(i => i >= 0);

    // Toes let a heel-strike or toe-off read as rolling, not sliding.
    const toeOf = new Map(feet.map(i => {
      const role = Object.entries(parts.roles).find(([, j]) => j === i)?.[0];
      const toe = role ? parts.roles[role.replace(/Foot$/, 'Toe')] : undefined;
      return [i, toe !== undefined && toe !== i ? toe : -1];
    }));
    const groundJoints = [...feet, ...[...toeOf.values()].filter(i => i >= 0)];
    applyPose(asset, asset.restPose); asset.root.updateMatrixWorld(true);
    const clearance = new Map(groundJoints.map(i => [i, Math.max(0, Math.min(height * .12, asset.bones[i].getWorldPosition(new THREE.Vector3()).y))]));
    const tolerance = height * .025;

    const bodyContact = contactModel(asset, parts);
    const watched = bodyContact.watch;
    const mats: Map<number, THREE.Matrix4>[] = [];
    const restPositions = asset.bones.map(b => b.getWorldPosition(new THREE.Vector3()));
    const positions: THREE.Vector3[][] = [], quats: THREE.Quaternion[][] = [], frames: ReturnType<typeof frameFor>[] = [];
    let lowest = { y: Infinity, bone: -1, frame: 0 };
    for (let f = 0; f < n; f++) {
      applyPose(asset, sample(times[f])); asset.root.updateMatrixWorld(true);
      const p = asset.bones.map(b => b.getWorldPosition(new THREE.Vector3()));
      positions.push(p);
      quats.push(asset.bones.map(b => b.quaternion.clone()));
      frames.push(frameFor(asset));
      mats.push(new Map(watched.map(i => [i, asset.bones[i].matrixWorld.clone()])));
      for (const i of tracked) if (p[i].y < lowest.y && !groundJoints.includes(i)) lowest = { y: p[i].y, bone: i, frame: f };
    }
    const dt = (f: number) => Math.max(1e-6, times[f] - times[f - 1]);
    const issues: ReviewIssue[] = [];
    const contacts: Record<string, [number, number][]> = {};
    const low = (i: number, f: number) => positions[f][i].y - clearance.get(i)! <= tolerance;
    const contact = feet.map(i => positions.map((_, f) => low(i, f) || toeOf.get(i)! >= 0 && low(toeOf.get(i)!, f)));
    const flatPath = (joint: number, a: number, b: number) => {
      let distance = 0, peak = 0;
      // Skip the touch-down and lift-off frames; a plant is judged on its middle.
      for (let f = a + 2; f <= b - 1; f++) {
        const d = Math.hypot(positions[f][joint].x - positions[f - 1][joint].x, positions[f][joint].z - positions[f - 1][joint].z);
        distance += d; peak = Math.max(peak, d / dt(f));
      }
      return { distance, peak };
    };

    // Sliding while planted: flat foot (ankle + toe down) must not drift; a toe pivot keeps the toe still.
    const inPlace = hipsIndex >= 0 && Math.hypot(positions[n - 1][hipsIndex].x - positions[0][hipsIndex].x, positions[n - 1][hipsIndex].z - positions[0][hipsIndex].z) < .1 * scale;
    feet.forEach((footIndex, k) => {
      const name = nameOf(footIndex), toe = toeOf.get(footIndex)!;
      contacts[name] = spans(contact[k]).map(([a, b]) => range(times[a], times[b]));
      const slow = (joint: number, f: number) => !f || Math.hypot(positions[f][joint].x - positions[f - 1][joint].x, positions[f][joint].z - positions[f - 1][joint].z) / dt(f) < scale;
      const checks: [number, boolean[], string][] = [[footIndex, positions.map((_, f) => low(footIndex, f) && (toe < 0 || low(toe, f)) && slow(footIndex, f)), 'planted']];
      if (toe >= 0) checks.push([toe, positions.map((_, f) => positions[f][toe].y - clearance.get(toe)! <= tolerance * .5 && !low(footIndex, f) && slow(toe, f)), 'pivoting on the toe']);
      // Skating: the whole body glides with a flat foot on the floor (it travels with the hips instead of
      // pushing against them, which is what an in-place walk cycle does), whatever its speed.
      const flatDown = positions.map((_, f) => low(footIndex, f) && (toe < 0 || low(toe, f)));
      const skates: [number, number][] = [];
      const net = (joint: number, a: number, b: number) => new THREE.Vector2(positions[b][joint].x - positions[a][joint].x, positions[b][joint].z - positions[a][joint].z);
      for (const [a, b] of spans(flatDown, Math.max(4, Math.ceil(.25 / step)))) {
        const { distance, peak } = flatPath(footIndex, a, b);
        if (distance < .15 * scale || distance / Math.max(1e-6, times[b] - times[a]) < scale) continue;
        const foot = net(footIndex, a, b);
        if (hipsIndex < 0 || net(hipsIndex, a, b).dot(foot) < .5 * foot.lengthSq()) continue;
        skates.push([a, b]);
        issues.push({ severity: 'high', kind: 'foot-slide', part: name, time: range(times[a], times[b]), message: `${name} skates ${r2(distance * 100)} cm along the floor (peak ${r2(peak)} m/s) without lifting. Add steps or pin the foot with motion.quickGround.` });
      }
      for (const [joint, flags, how] of checks) for (const [a, b] of spans(flags, 4)) {
        if (skates.some(([c, d]) => a <= d && b >= c)) continue;
        const { distance, peak } = flatPath(joint, a, b);
        if (distance < .03 * scale) continue;
        // An in-place cycle (the hips never travel) drags its stance feet straight back, like a treadmill. That is expected
        // for in-place loops, so it is only a hint, not a defect.
        const drift = net(joint, a, b), back = new THREE.Vector2(-frames[a].forward.x, -frames[a].forward.z);
        if (inPlace && drift.length() > 1e-6 && drift.dot(back) > .7 * drift.length() * back.length()) {
          issues.push({ severity: 'low', kind: 'foot-slide', part: name, time: range(times[a], times[b]), message: `${name} drifts back ${r2(distance * 100)} cm while ${how}, as an in-place cycle does. If the character should travel, add root motion; to lock the feet, use motion.quickGround.` });
          continue;
        }
        issues.push({ severity: how === 'planted' ? distance > .08 * scale ? 'high' : 'medium' : distance > .1 * scale ? 'medium' : 'low', kind: 'foot-slide', part: name, time: range(times[a], times[b]), message: `${name} slides ${r2(distance * 100)} cm (peak ${r2(peak)} m/s) while ${how}. Pin it with motion.quickGround or re-key the plant.` });
      }
      // Ankles can't drop below their flat standing height; toes bend, so they are only held to the floor itself.
      for (const joint of toe >= 0 ? [footIndex, toe] : [footIndex]) {
        const jointName = nameOf(joint), floor = joint === toe ? 0 : clearance.get(joint)!;
        for (const [a, b] of spans(positions.map(p => p[joint].y < floor - tolerance * 1.5))) {
          const depth = Math.max(...positions.slice(a, b + 1).map(p => floor - p[joint].y));
          // A one-frame dip is usually a landing blip; a held sink is a real problem.
          issues.push({ severity: depth > .06 * scale && b > a ? 'high' : 'medium', kind: 'floor-penetration', part: jointName, time: range(times[a], times[b]), message: joint === toe ? `${jointName} goes ${r2(depth * 100)} cm below the floor.` : `${jointName} sinks ${r2(depth * 100)} cm below its standing height (into the floor).` });
        }
      }
    });
    if (lowest.y < -.03 * scale) issues.push({ severity: 'high', kind: 'floor-penetration', part: nameOf(lowest.bone), time: range(times[lowest.frame], times[lowest.frame]), message: `${nameOf(lowest.bone)} goes ${r2(-lowest.y * 100)} cm below the floor.` });

    // Airborne spans: floating vs. jumps that hang too long.
    const airborne: { time: [number, number]; rise: number }[] = [];
    if (feet.length && hipsIndex >= 0) {
      for (const [a, b] of spans(positions.map((_, f) => contact.every(c => !c[f])), 2)) {
        const duration = times[b] - times[a];
        const base = positions[Math.max(0, a - 1)][hipsIndex].y;
        const rise = Math.max(0, ...positions.slice(a, b + 1).map(p => p[hipsIndex].y - base));
        airborne.push({ time: range(times[a], times[b]), rise: r2(rise) });
        const ballistic = 2 * Math.sqrt(2 * Math.max(rise, 1e-4) / 9.81);
        if (rise < .03 * scale && duration > .15) issues.push({ severity: 'medium', kind: 'floating', time: range(times[a], times[b]), message: `All feet leave the floor for ${r2(duration)} s without the hips rising: the character looks like it is floating. Lower the hips or plant a foot.` });
        else if (duration > .25 && duration > ballistic * 1.6) issues.push({ severity: 'medium', kind: 'floaty-jump', time: range(times[a], times[b]), message: `Airborne ${r2(duration)} s, but a ${r2(rise * 100)} cm rise only hangs ~${r2(ballistic)} s under gravity. Shorten the air time or raise the jump.` });
      }
    }

    // Single-frame pops: one joint spikes far above its neighbors' speed.
    const angular = quats.map((q, f) => f ? tracked.map(i => q[i].angleTo(quats[f - 1][i]) / dt(f)) : tracked.map(() => 0));
    const pops: { f: number; bone: number; speed: number }[] = [];
    for (let f = 1; f < n - 1; f++) tracked.forEach((bone, k) => {
      const w = angular[f][k], around = Math.max(angular[f - 1][k], angular[f + 1][k], THREE.MathUtils.degToRad(60));
      const step = (frame: number) => frame ? quats[frame][bone].angleTo(quats[frame - 1][bone]) : 0;
      const stepAngle = step(f), near = Math.max(step(f - 1), step(f + 1));
      // A one-frame excursion jumps out and straight back, so both steps are large but the poses around it agree.
      const excursion = f + 1 < n && dt(f) <= 1.5 / fps && stepAngle > THREE.MathUtils.degToRad(40) && step(f + 1) > THREE.MathUtils.degToRad(40)
        && quats[f + 1][bone].angleTo(quats[f - 1][bone]) < .35 * Math.min(stepAngle, step(f + 1));
      if (stepAngle > Math.PI / 2 || excursion || stepAngle > THREE.MathUtils.degToRad(40) && stepAngle > 3 * near && w > 2.5 * around) pops.push({ f, bone, speed: w });
    });
    pops.sort((a, b) => b.speed - a.speed).slice(0, 4).forEach(pop => issues.push({ severity: 'high', kind: 'pop', part: nameOf(pop.bone), time: range(times[pop.f - 1], times[pop.f]), message: `${nameOf(pop.bone)} snaps ${Math.round(THREE.MathUtils.radToDeg(pop.speed * dt(pop.f)))}° in one frame (a pop). Check the keys around it for a flipped rotation.` }));
    if (hipsIndex >= 0) {
      const v = positions.map((p, f) => f ? p[hipsIndex].distanceTo(positions[f - 1][hipsIndex]) / dt(f) : 0);
      // A spike, or a one-frame jump out and straight back (both steps large, the frames around it agree).
      const stepLength = (f: number) => positions[f][hipsIndex].distanceTo(positions[f - 1][hipsIndex]);
      const excursion = (f: number) => Math.min(v[f], v[f + 1]) > 3 * scale && stepLength(f) > .1 * scale && stepLength(f + 1) > .1 * scale && positions[f + 1][hipsIndex].distanceTo(positions[f - 1][hipsIndex]) < .35 * Math.min(stepLength(f), stepLength(f + 1));
      for (let f = 1; f < n - 1; f++) if (v[f] > 3 * scale && v[f] > 3 * Math.max(v[f - 1], v[f + 1], .3) || excursion(f)) issues.push({ severity: 'high', kind: 'pop', part: 'hips', time: range(times[f - 1], times[f]), message: `The hips jump ${r2(v[f] * dt(f) * 100)} cm in one frame.` });
    }

    // Knees bending backwards (humanoid legs only).
    for (const limb of parts.limbs.filter(l => /^(left|right)Foot$/.test(l.end))) {
      const bad = positions.map((p, f) => {
        const up = p[limb.mid].clone().sub(p[limb.upper]), low = p[limb.tip].clone().sub(p[limb.mid]);
        return p[limb.tip].y < p[limb.mid].y - .1 * scale && THREE.MathUtils.radToDeg(up.angleTo(low)) > 6 && up.cross(low).dot(frames[f].right) > 0;
      });
      for (const [a, b] of spans(bad)) issues.push({ severity: 'high', kind: 'hyperextension', part: limb.end.replace('Foot', 'Knee'), time: range(times[a], times[b]), message: `${limb.end.replace('Foot', 'Knee')} bends backwards. Use pose.intent bend or reach with pole "forward".` });
    }

    // Off-balance: slow moments whose mass sits outside every low support point (feet, toes, knees, hands).
    const chest = parts.roles.chest ?? parts.roles.neck;
    if (asset.kind === 'humanoid' && hipsIndex >= 0 && chest !== undefined && feet.length >= 2) {
      const supports = [...groundJoints, ...['leftShin', 'rightShin', 'leftHand', 'rightHand'].map(role => parts.roles[role]).filter((i): i is number => i !== undefined)];
      const off = positions.map((p, f) => {
        if (f && p[hipsIndex].distanceTo(positions[f - 1][hipsIndex]) / dt(f) > .35 * scale) return 0;
        const points = supports.filter(i => clearance.has(i) ? low(i, f) : p[i].y < height * .08).map(i => new THREE.Vector2(p[i].x, p[i].z));
        if (!points.length) return 0;
        const mass = p[hipsIndex].clone().multiplyScalar(.6).addScaledVector(p[chest], .4);
        return outside(new THREE.Vector2(mass.x, mass.z), points);
      });
      for (const [a, b] of spans(off.map(d => d > .2 * scale), 6)) issues.push({ severity: 'medium', kind: 'off-balance', time: range(times[a], times[b]), message: `The body's weight sits ${r2(Math.max(...off.slice(a, b + 1)) * 100)} cm outside its support during a slow moment; it will read as falling. Shift the hips over the feet or widen the stance.` });
    }

    // Props cutting into the head or torso, beyond however far they already sit in the rest pose.
    const depths = mats.map(m => bodyContact.measure(i => m.get(i)!));
    bodyContact.props.forEach((prop, k) => {
      for (const region of ['head', 'torso'] as const) {
        const extra = depths.map(d => d[k][region]);
        for (const [a, b] of spans(extra.map(e => e > .03 * scale))) {
          const worst = Math.max(...extra.slice(a, b + 1));
          issues.push({ severity: worst > .08 * scale ? 'high' : 'medium', kind: 'prop-clip', part: prop.name, time: range(times[a], times[b]), message: `${prop.name} cuts ${r2(worst * 100)} cm into the ${region === 'head' && depths[a][k].headwear ? `${depths[a][k].headwear} on the head` : region}; ${clipAdvice(depths[a][k])}.` });
        }
      }
      // A weapon that hits the ground should stop on it, not sink through.
      const floor = depths.map(d => d[k].floor);
      for (const [a, b] of spans(floor.map(y => y < -.02 * scale))) {
        const worst = -Math.min(...floor.slice(a, b + 1));
        issues.push({ severity: worst > .08 * scale ? 'high' : 'medium', kind: 'prop-floor', part: prop.name, time: range(times[a], times[b]), message: `${prop.name} sinks ${r2(worst * 100)} cm into the floor; raise the hands or flatten its angle so it stops on the ground.` });
      }
    });

    // Broken wrists: the hand folds far past its rest angle against the forearm.
    const handLimbs = parts.limbs.filter(l => /Hand$/.test(l.end));
    const knucklesOf = (tip: number) => asset.bones[tip].children.filter((c): c is THREE.Bone => c instanceof THREE.Bone && isFingerBone(c.name)).map(c => asset.bones.indexOf(c));
    const palmAt = (p: THREE.Vector3[], tip: number, knuckles: number[]) => knuckles.reduce((a, i) => a.add(p[i]), new THREE.Vector3()).divideScalar(knuckles.length).add(p[tip]).multiplyScalar(.5);
    for (const limb of handLimbs) {
      const knuckles = knucklesOf(limb.tip);
      if (!knuckles.length) continue;
      const bendAt = (p: THREE.Vector3[]) => THREE.MathUtils.radToDeg(p[limb.tip].clone().sub(p[limb.mid]).angleTo(palmAt(p, limb.tip, knuckles).sub(p[limb.tip])));
      const restBend = bendAt(restPositions), bend = positions.map(bendAt);
      for (const [a, b] of spans(bend.map(x => x - restBend > 55))) issues.push({ severity: 'medium', kind: 'wrist', part: limb.end, time: range(times[a], times[b]), message: `${limb.end} bends ${Math.round(Math.max(...bend.slice(a, b + 1)))}° at the wrist (${Math.round(restBend)}° at rest); it reads as broken. Roll the hand (pose.intent grip on a held prop) or move the elbow (reach with a pole).` });
    }

    // A second hand that holds a carried prop at two keys but drifts off it in between.
    const frameAt = (t: number) => Math.max(0, Math.min(n - 1, Math.round((t - start) / step)));
    const keyed = [...new Set(keys.map(k => k.time).filter(t => t >= start - 1e-6 && t <= end + 1e-6))].sort((a, b) => a - b);
    for (const prop of bodyContact.props.filter(p => p.carrier !== undefined)) {
      const { points, name } = prop;
      for (const other of handLimbs.filter(l => l.tip !== prop.carrier)) {
        const knuckles = knucklesOf(other.tip);
        const gap = positions.map((p, f) => {
          const palm = (knuckles.length ? palmAt(p, other.tip, knuckles) : p[other.tip].clone()).applyMatrix4(mats[f].get(prop.bone)!.clone().invert());
          let best = Infinity;
          for (const q of points) best = Math.min(best, q.distanceTo(palm));
          return best * mats[f].get(prop.bone)!.getMaxScaleOnAxis();
        });
        for (let k = 1; k < keyed.length; k++) {
          const a = frameAt(keyed[k - 1]), b = frameAt(keyed[k]);
          if (gap[a] > .07 * scale || gap[b] > .07 * scale) continue;
          const worst = Math.max(...gap.slice(a, b + 1));
          if (worst > Math.max(gap[a], gap[b]) + .05 * scale) issues.push({ severity: 'medium', kind: 'grip-slip', part: other.end, time: range(keyed[k - 1], keyed[k]), message: `${other.end} holds ${name} at both keys but comes ${r2(worst * 100)} cm off it in between. Add a key in the middle, re-grip there with pose.intent grip, or bring the keys closer.` });
        }
      }
    }

    // Dead holds: everything stops (animators keep a little moving hold).
    const total = angular.map(row => row.reduce((s, w) => s + w, 0));
    const hipsMoving = positions.map((p, f) => f && hipsIndex >= 0 ? p[hipsIndex].distanceTo(positions[f - 1][hipsIndex]) / dt(f) : 0);
    for (const [a, b] of spans(total.map((w, f) => f > 0 && w < THREE.MathUtils.degToRad(4) && hipsMoving[f] < .01))) {
      if (times[b] - times[a] >= .5) issues.push({ severity: 'low', kind: 'dead-hold', time: range(times[a], times[b]), message: `Nothing moves for ${r2(times[b] - times[a])} s. Add a slight settle or breath so the hold stays alive (unless the clip should stop here).` });
    }

    // Summary numbers.
    const summary: Record<string, unknown> = { contacts, airborne };
    if (hipsIndex >= 0) {
      let path = 0, top = 0;
      for (let f = 1; f < n; f++) { const d = Math.hypot(positions[f][hipsIndex].x - positions[f - 1][hipsIndex].x, positions[f][hipsIndex].z - positions[f - 1][hipsIndex].z); path += d; top = Math.max(top, d / dt(f)); }
      const net = positions[n - 1][hipsIndex].clone().sub(positions[0][hipsIndex]);
      summary.hips = { pathMeters: r2(path), netMeters: [r2(net.dot(frames[0].right)), r2(net.y), r2(net.dot(frames[0].forward))], netNote: '[right, up, forward] in the starting frame', topSpeed: r2(top), heightRange: [r2(Math.min(...positions.map(p => p[hipsIndex].y))), r2(Math.max(...positions.map(p => p[hipsIndex].y)))] };
    }
    const handSpeeds: Record<string, unknown> = {};
    for (const role of ['leftHand', 'rightHand']) {
      const i = parts.roles[role];
      if (i === undefined) continue;
      let top = 0, at = 0;
      for (let f = 1; f < n; f++) { const s = positions[f][i].distanceTo(positions[f - 1][i]) / dt(f); if (s > top) { top = s; at = times[f]; } }
      handSpeeds[role] = { topSpeed: r2(top), at: r2(at) };
    }
    if (Object.keys(handSpeeds).length) summary.hands = handSpeeds;
    let seam = 0, seamBone = -1;
    for (const i of tracked) { const a = quats[0][i].angleTo(quats[n - 1][i]); if (a > seam) { seam = a; seamBone = i; } }
    summary.loopSeam = { maxJointDegrees: Math.round(THREE.MathUtils.radToDeg(seam)), joint: seamBone >= 0 ? nameOf(seamBone) : null, note: 'Difference between the first and last frame; near 0 means it can loop.' };
    summary.keys = keys.length <= 24 ? keys.map(k => ({ time: r2(k.time), label: k.label ?? null })) : { count: keys.length, note: 'Dense baked keys (imported or simplified clip). Use keys.simplify to edit by poses.' };
    issues.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.time[0] - b.time[0]);
    return { duration: r2(span), sampledFps: r2(1 / step), frames: n, issues: issues.slice(0, 24), summary: { ...summary, ...(issues.length > 24 ? { moreIssues: issues.length - 24 } : {}), verdict: issues.some(i => i.severity === 'high') ? 'fix high-severity issues' : issues.length ? 'readable; polish the listed notes' : 'no mechanical problems found; judge the look on the contact sheet' } };
  } finally { applyPose(asset, original); asset.root.updateMatrixWorld(true); }
}
