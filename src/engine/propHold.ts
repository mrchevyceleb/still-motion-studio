import * as THREE from 'three';
import { applyPose, capturePose } from './character';
import { contactModel } from './bodyContact';
import { applyPhysics, bakeTimes, createPoseSampler } from './motion';
import { createMorphKeySampler } from './morphs';
import {
  bodyParts, currentFrame, direction, finite, forearmTakesTwist, isAncestor, resolvePart, restData, runAction, segmentEnd,
  setWorldQuat, toWorldDir, twoBoneIK, vec3, worldPos, worldQuat,
  type BodyFrame, type BodyParts, type IntentAction, type IntentResult, type Rest,
} from './agentIntent';
import type { CharacterAsset, MotionSettings, PoseKey, Vec3 } from '../types';

/**
 * Prop-first animation. The agent says where a held prop goes; the engine does the geometry: both hands on it,
 * clear of the head, hat, torso and floor (`hold`), and a clean arc between keys with the hands re-solved on every
 * frame (`carryProp`). An agent should never have to search hand layouts itself.
 */

type Limb = BodyParts['limbs'][number];
interface Held { prop: number; name: string; holder: Limb; other?: Limb }
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const rad = THREE.MathUtils.degToRad, deg = THREE.MathUtils.radToDeg;
const round = (n: number) => Math.round(n * 100) / 100;
const toChar = (f: BodyFrame, v: THREE.Vector3): Vec3 => [v.dot(f.right), v.dot(f.up), v.dot(f.forward)];

function heldProp(asset: CharacterAsset, value: unknown): Held {
  if (value === undefined) throw new Error('Name the held prop with prop (for example "Pitchfork").');
  const { limbs } = bodyParts(asset);
  const prop = resolvePart(asset, value).bones[0];
  const holder = limbs.find(l => /Hand$/.test(l.end) && l.tip !== prop && isAncestor(asset, l.tip, prop));
  if (!holder) throw new Error(`"${asset.bones[prop].name}" is not carried by a hand; hold and motion.carry work on props parented under a hand.`);
  const mirror = holder.end.replace(/^(left|right)/, side => side === 'left' ? 'right' : 'left');
  return { prop, name: asset.bones[prop].name, holder, other: limbs.find(l => l.end === mirror && l.end !== holder.end) };
}

/** The prop's long axis, pointing at its working end (the same axis `aim` with a pointer uses). */
function propAxis(asset: CharacterAsset, prop: number) {
  const start = worldPos(asset.bones[prop]), tip = segmentEnd(asset, prop);
  return (tip ? tip.sub(start) : V(0, 1, 0).applyQuaternion(worldQuat(asset.bones[prop]))).normalize();
}

/** Middle of the palm: between the wrist and the knuckles (the fingers that are not the prop). */
function palm(asset: CharacterAsset, hand: number, prop: number) {
  const wrist = worldPos(asset.bones[hand]);
  const fingers = asset.bones[hand].children.filter((c): c is THREE.Bone => c instanceof THREE.Bone && c !== asset.bones[prop] && !isAncestor(asset, asset.bones.indexOf(c), prop));
  if (!fingers.length) return wrist;
  return fingers.reduce((sum, f) => sum.add(worldPos(f)), V()).divideScalar(fingers.length).add(wrist).multiplyScalar(.5);
}

const onShaft = (asset: CharacterAsset, prop: number, p: THREE.Vector3) => {
  const start = worldPos(asset.bones[prop]), axis = propAxis(asset, prop);
  return start.addScaledVector(axis, p.clone().sub(start).dot(axis));
};

function wristBend(asset: CharacterAsset, limb: Limb, prop: number) {
  const wrist = worldPos(asset.bones[limb.tip]), knuckles = palm(asset, limb.tip, prop).sub(wrist);
  if (knuckles.lengthSq() < 1e-10) return 0;
  return deg(knuckles.angleTo(wrist.sub(worldPos(asset.bones[limb.mid]))));
}

/** How deep the prop sits in the body (excess over rest) and under the floor, in meters. */
function clearance(asset: CharacterAsset, held: Held) {
  const depth = contactModel(asset, bodyParts(asset)).measure(i => asset.bones[i].matrixWorld).find(d => d.name === held.name);
  if (!depth) return { cut: 0, sink: 0, where: '' };
  return { cut: Math.max(0, depth.head, depth.torso), sink: Math.max(0, -depth.floor), where: depth.head >= depth.torso ? depth.headwear ?? 'head' : 'torso' };
}

/** Shaft length behind the holding hand with the prop where the rig holds it at rest. */
/** Where the prop's mesh starts and ends along its long axis, in meters from the prop bone (negative = behind it). */
function shaftExtent(asset: CharacterAsset, prop: number): [number, number] | null {
  const shape = contactModel(asset, bodyParts(asset)).props.find(p => p.bone === prop);
  if (!shape?.points.length) return null;
  const start = worldPos(asset.bones[prop]), axis = propAxis(asset, prop);
  const along = shape.points.map(p => p.clone().applyMatrix4(asset.bones[prop].matrixWorld).sub(start).dot(axis));
  return [Math.min(...along), Math.max(...along)];
}

/** Whether a point sits on the prop's actual shaft (within `reach` of it), not just on the endless line through it. */
function onProp(asset: CharacterAsset, prop: number, p: THREE.Vector3, reach: number) {
  const extent = shaftExtent(asset, prop);
  if (!extent) return false;
  const t = p.clone().sub(worldPos(asset.bones[prop])).dot(propAxis(asset, prop));
  return t >= extent[0] - reach && t <= extent[1] + reach && onShaft(asset, prop, p).distanceTo(p) < reach;
}

/** The shaft behind the holding hand where the rig holds it at rest, and the whole shaft's length. */
function shaftAtRest(asset: CharacterAsset, held: Held) {
  const bone = asset.bones[held.prop], saved = bone.position.clone();
  bone.position.fromArray(asset.restPose[held.prop].position); asset.root.updateMatrixWorld(true);
  try {
    const extent = shaftExtent(asset, held.prop);
    if (!extent) return { behind: 0, length: 0 };
    const hold = palm(asset, held.holder.tip, held.prop).sub(worldPos(bone)).dot(propAxis(asset, held.prop));
    return { behind: Math.max(0, hold - extent[0]), length: extent[1] - extent[0] };
  } finally { bone.position.copy(saved); asset.root.updateMatrixWorld(true); }
}

const TURNS: [number, number][] = [-45, -30, -15, 0, 15, 30, 45].flatMap(da => [-30, -15, 0, 15].map(de => [da, de] as [number, number]));
const SHIFTS: Vec3[] = [[0, 0, 0], [.1, 0, 0], [-.1, 0, 0], [0, .1, 0], [0, 0, .1], [.2, 0, 0], [-.2, 0, 0], [0, .2, 0]];
const DUCKS = [0, 12, -12, 25, -25];

/**
 * `{do:"hold", prop, at, toward}`: put the point between the hands at `at` with the prop's working end pointing
 * `toward`, the back hand near the butt for leverage. If that pose cuts into the body, hat or floor, it tries the
 * nearest clean variation (the prop turned up to 45°, the hands moved up to 20 cm, the head ducked) and says what it changed.
 */
export function hold(asset: CharacterAsset, action: IntentAction, rest: Rest): IntentResult {
  const held = heldProp(asset, action.prop ?? action.part);
  if (action.at === undefined) throw new Error('hold needs at: [right, up, forward] for the point between the hands (add relativeTo, for example "chest").');
  if (action.hands !== undefined && action.hands !== 'one' && action.hands !== 'both') throw new Error('hands must be "one" or "both".');
  const scale = Math.max(.1, asset.height) / 1.8, frame = currentFrame(asset, rest);
  const anchor = action.relativeTo !== undefined ? worldPos(asset.bones[resolvePart(asset, action.relativeTo).bones[0]]) : frame.origin.clone();
  const center = anchor.add(toWorldDir(frame, vec3(action.at, 'at')));
  const [r0, u0, f0] = toChar(frame, toWorldDir(frame, direction(action.toward, held.holder.end)).normalize());
  const az0 = Math.atan2(r0, f0), el0 = Math.asin(Math.max(-1, Math.min(1, u0)));

  // The back hand rides just in front of the butt (the prop slides through the holding hand to make room); a short
  // prop is held in one hand. The front hand keeps a little shaft ahead of it.
  const { behind, length } = shaftAtRest(asset, held), margin = .03 * scale, room = length - margin - .1 * scale;
  const armLength = (limb: Limb) => worldPos(asset.bones[limb.upper]).distanceTo(worldPos(asset.bones[limb.mid])) + worldPos(asset.bones[limb.mid]).distanceTo(worldPos(asset.bones[limb.tip]));
  const requested = finite(action.spread, 'spread', .05, 2, Math.min(.3 * scale, .45 * armLength(held.holder)));
  const twoHands = action.hands !== 'one' && !!held.other && room >= .08 * scale;
  const spread = twoHands ? Math.min(requested, room) : 0;
  const slide = twoHands ? spread + margin - behind : 0;

  const clear = action.clear !== false;
  const ducks = clear && bodyParts(asset).roles.head !== undefined ? DUCKS : [0];
  const candidates = (clear ? TURNS : [[0, 0] as [number, number]]).flatMap(([da, de]) => (clear ? SHIFTS : [SHIFTS[0]]).flatMap(shift => ducks.map(duck => {
    const az = az0 + rad(da), el = Math.max(rad(-89), Math.min(rad(89), el0 + rad(de)));
    return { da, de, shift: shift.map(n => n * scale) as Vec3, duck, dir: [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)] as Vec3, cost: Math.abs(da) + Math.abs(de) + Math.hypot(...shift) * 100 + Math.abs(duck) * .4 };
  }))).sort((a, b) => a.cost - b.cost);

  // An agent cannot know every rig's reach: pull the hold toward whichever shoulder is overstretched until both hands
  // can get there. (Pulling toward the middle of the chest would drag a hold at the hip into the belly.)
  const shoulder = (limb: Limb) => worldPos(asset.bones[limb.upper]);
  const withinReach = (wanted: THREE.Vector3, axis: THREE.Vector3) => {
    const middle = wanted.clone();
    for (let pass = 0; pass < 8; pass++) {
      const strain = (limb: Limb, side: number) => {
        const hand = middle.clone().addScaledVector(axis, side * spread / 2);
        return { limb, hand, over: hand.distanceTo(shoulder(limb)) - .9 * armLength(limb) };
      };
      const worst = [strain(held.holder, 1), ...(twoHands ? [strain(held.other!, -1)] : [])].reduce((x, y) => y.over > x.over ? y : x);
      if (worst.over <= .005) break;
      // From the midpoint toward that shoulder; if the midpoint sits on the shoulder, along the hand's own line to it.
      const pull = shoulder(worst.limb).sub(middle);
      middle.addScaledVector((pull.lengthSq() > 1e-8 ? pull : shoulder(worst.limb).sub(worst.hand)).normalize(), worst.over);
    }
    return { target: middle.clone().addScaledVector(axis, spread / 2), pulled: middle.distanceTo(wanted) };
  };
  const base = capturePose(asset), cm = (m: number) => m * 100 / scale;
  const evaluate = (c: typeof candidates[number]) => {
    applyPose(asset, base); asset.root.updateMatrixWorld(true);
    runAction(asset, { do: 'aim', part: held.holder.end, pointer: held.prop, direction: c.dir }, frame, rest);
    const { target, pulled } = withinReach(center.clone().add(toWorldDir(frame, c.shift)), propAxis(asset, held.prop));
    const by = target.clone().sub(onShaft(asset, held.prop, palm(asset, held.holder.tip, held.prop)));
    runAction(asset, { do: 'reach', part: held.holder.end, by: toChar(frame, by), keepOrientation: true }, frame, rest);
    // Slide the prop through the hand and roll the hand about the shaft last, so the wrist ends straight.
    runAction(asset, { do: 'grip', part: held.holder.end, on: held.prop, along: slide }, frame, rest);
    let miss = onShaft(asset, held.prop, palm(asset, held.holder.tip, held.prop)).distanceTo(target);
    if (twoHands) { const second = runAction(asset, { do: 'grip', part: held.other!.end, on: held.prop, along: -spread, reverse: false, pole: 'down-out' }, frame, rest); if (!second.ok) miss += second.error ?? .1; }
    if (c.duck) runAction(asset, { do: 'turn', part: 'head', roll: c.duck }, frame, rest);
    const { cut, sink, where } = clearance(asset, held);
    const bend = Math.max(wristBend(asset, held.holder, held.prop), twoHands ? wristBend(asset, held.other!, held.prop) : 0);
    const score = c.cost + cm(miss) * 25 + Math.max(0, cm(cut) - 1) * 30 + Math.max(0, cm(sink) - 1) * 30 + Math.max(0, bend - 35) * .5;
    return { c, score, cut, sink, where, miss, bend, pulled, pose: capturePose(asset) };
  };
  // Cheapest change first; stop once no remaining variation could beat the best pose found.
  let best: ReturnType<typeof evaluate> | null = null;
  for (const c of candidates) {
    if (best && c.cost >= best.score) break;
    const tried = evaluate(c);
    if (!best || tried.score < best.score) best = tried;
  }
  applyPose(asset, best!.pose); asset.root.updateMatrixWorld(true);

  const { c, cut, sink, where, miss, bend, pulled } = best!;
  const changes = [
    ...(c.da ? [`turned ${Math.abs(c.da)}° ${c.da > 0 ? 'right' : 'left'}`] : []),
    ...(c.de ? [`tipped ${Math.abs(c.de)}° ${c.de > 0 ? 'up' : 'down'}`] : []),
    ...(c.shift.some(Boolean) ? [`hands moved ${Math.round(Math.hypot(...c.shift) * 100)} cm ${c.shift[0] > 0 ? 'right' : c.shift[0] < 0 ? 'left' : c.shift[1] > 0 ? 'up' : 'forward'}`] : []),
    ...(c.duck ? [`head ducked ${Math.abs(c.duck)}° ${c.duck > 0 ? 'right' : 'left'}`] : []),
  ];
  const fitted = pulled > .02 * scale ? `pulled ${Math.round(pulled * 100)} cm toward the shoulders to stay within reach; ` : '';
  const clean = cut <= .03 * scale && sink <= .02 * scale, reached = miss < .03 * scale;
  const notes = [
    fitted + (changes.length ? `adjusted to stay clear: ${changes.join(', ')}` : 'held at the requested angle'),
    clean ? 'clear of the body, head, hat and floor' : `${cut > .03 * scale ? `still cuts ${Math.round(cut * 100)} cm into the ${where}` : ''}${cut > .03 * scale && sink > .02 * scale ? ' and ' : ''}${sink > .02 * scale ? `sinks ${Math.round(sink * 100)} cm into the floor` : ''}: move at further ${cut > .03 * scale ? `out from the ${where}` : 'up'}, or point toward away from it`,
    twoHands ? `both hands on it, ${round(spread)} m apart` : 'one hand',
    `wrists bent up to ${Math.round(bend)}°`,
    ...(reached ? [] : [`hands miss the target by ${round(miss)} m: bring at closer to the shoulders`]),
  ];
  return { do: 'hold', part: held.name, ok: clean && reached, ...(reached ? {} : { error: round(miss) }), note: notes.join('; ') };
}

/* ------------------------------------------------------------------ carry */

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

/** Which way an elbow points off its shoulder-to-wrist line, and that line (both in character space). */
interface Arm { pole: THREE.Vector3; reach: THREE.Vector3 }

interface Snapshot { arms: (Arm | null)[]; rel: THREE.Vector3; turn: THREE.Quaternion; grip: THREE.Vector3; other: { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 } | null; otherOn: boolean }

/**
 * Bake every frame between the authored keys so the held prop travels on an arc around the shoulders (its grip
 * point's direction and distance from them blend, its angle blends relative to the body's heading) and both hands
 * are re-solved to hold it. Where an in-between would still cut into the body or floor, the prop is slid up to
 * 20 cm or tipped up to 40° away from it, as one smooth bump across that span. Authored keys keep their poses, except that planted feet
 * are pinned across the whole take (keys included). The report measures that final grounded take.
 */
export function carryProp(asset: CharacterAsset, keys: PoseKey[], settings: MotionSettings, propValue: unknown, ground = true) {
  const sorted = keys.filter(k => Number.isFinite(k.time)).slice().sort((a, b) => a.time - b.time);
  if (sorted.length < 2) throw new Error('motion.carry needs at least two keys.');
  const held = heldProp(asset, propValue), parts = bodyParts(asset);
  const scale = Math.max(.1, asset.height) / 1.8, cm = (m: number) => m * 100 / scale;
  const shoulders = parts.limbs.filter(l => /Hand$/.test(l.end)).map(l => l.upper);
  const pivot = () => shoulders.reduce((sum, i) => sum.add(worldPos(asset.bones[i])), V()).divideScalar(shoulders.length);
  const rest = restData(asset), frameOf = () => currentFrame(asset, rest);
  const heading = (frame: BodyFrame) => new THREE.Quaternion().setFromUnitVectors(rest.forward, frame.forward);
  const saved = capturePose(asset);
  try {
    const snap = (): Snapshot => {
      asset.root.updateMatrixWorld(true);
      const frame = frameOf(), prop = asset.bones[held.prop], inverse = prop.matrixWorld.clone().invert();
      const grip = palm(asset, held.holder.tip, held.prop);
      let other: Snapshot['other'] = null, otherOn = false;
      if (held.other) {
        other = { p: V(), q: new THREE.Quaternion(), s: V() };
        inverse.clone().multiply(asset.bones[held.other.tip].matrixWorld).decompose(other.p, other.q, other.s);
        otherOn = onProp(asset, held.prop, palm(asset, held.other.tip, held.prop), .06 * scale);
      }
      const arms = [held.holder, held.other].map((limb): Arm | null => {
        if (!limb) return null;
        const a = worldPos(asset.bones[limb.upper]), reach = worldPos(asset.bones[limb.tip]).sub(a).normalize(), elbow = worldPos(asset.bones[limb.mid]).sub(a);
        const off = elbow.sub(reach.clone().multiplyScalar(elbow.dot(reach)));
        return off.lengthSq() > 1e-8 ? { pole: V(...toChar(frame, off.normalize())), reach: V(...toChar(frame, reach)) } : null;
      });
      return { arms, rel: V(...toChar(frame, grip.clone().sub(pivot()))), turn: heading(frame).invert().multiply(worldQuat(prop)), grip: grip.applyMatrix4(inverse), other, otherOn };
    };
    const snaps = sorted.map(key => { applyPose(asset, key.pose); return snap(); });
    // Both hands carry the prop through a span when both of its keys hold it with both hands. One loose key no longer
    // turns the whole take one-handed.
    const both = (i: number) => !!held.other && snaps[i].otherOn && snaps[i + 1].otherOn;
    const sample = createPoseSampler(sorted, settings.interpolation);
    const morphs = createMorphKeySampler(sorted, settings.interpolation, asset.restMorphs);
    const authored = new Map(sorted.map(key => [Math.fround(key.time), key]));
    // Every pass over a span walks its frames in order, so e only rises within a pass: unwrap each frame's elbow turn
    // next to the previous frame's (the same frame's again on a repeat pass), and start fresh when e falls.
    const turns = new Map<number, { e: number; ref: number | null; turn: number }>();
    const elbowTurn = (limb: Limb, e: number, now: number) => {
      const last = turns.get(limb.tip), ref = !last ? null : e === last.e ? last.ref : e > last.e ? last.turn : null;
      const turn = ref === null ? now : now + 2 * Math.PI * Math.round((ref - now) / (2 * Math.PI));
      turns.set(limb.tip, { e, ref, turn });
      return turn;
    };
    const place = (limb: Limb, target: THREE.Matrix4, frame: BodyFrame, arms: [Arm | null, Arm | null], e: number, swivel: number, onShaftRoll = false) => {
      const p = V(), q = new THREE.Quaternion(), s = V();
      target.decompose(p, q, s);
      const hand = asset.bones[limb.tip], axis = onShaftRoll ? propAxis(asset, held.prop) : null;
      // The palm sits at a fixed offset in the hand's own space, so the target says where it lands on the shaft.
      const center = axis ? onShaft(asset, held.prop, palm(asset, limb.tip, held.prop).applyMatrix4(hand.matrixWorld.clone().invert()).applyMatrix4(target)) : null;
      for (let pass = 0; pass < (axis ? 3 : 1); pass++) {
        // Each key's elbow direction is carried onto this frame's shoulder-to-wrist line and blended there, so the elbow
        // swings round the arm. Blending fixed directions lets the pole fall onto the arm line, and the elbow whips round.
        const reach = p.clone().sub(worldPos(asset.bones[limb.upper])).normalize();
        const carried = (arm: Arm | null) => arm && toWorldDir(frame, arm.pole.toArray()).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(toWorldDir(frame, arm.reach.toArray()).normalize(), reach));
        const [from, to] = arms.map(carried);
        // Both lie across the reach line, so blend by the signed angle about it (never through the line itself), and keep
        // going the same way round as the frame before: elbows pointing nearly opposite ways never flip sides mid-span.
        const pole = from && to ? from.clone().applyAxisAngle(reach, e * elbowTurn(limb, e, Math.atan2(reach.dot(from.clone().cross(to)), from.dot(to)))) : from ?? to;
        // Swivel turns the elbow about the shoulder-to-wrist line, the way an arm keeps its wrist straight mid-swing.
        const elbow = (pole ?? toWorldDir(frame, direction(limb.pole, limb.end))).applyAxisAngle(reach, rad(swivel));
        twoBoneIK(asset, limb.upper, limb.mid, limb.tip, p, elbow, !pole && !swivel);
        setWorldQuat(asset, hand, q);
        if (!axis || !center) break;
        // A hand round a shaft turns freely about it: roll it so the knuckles continue the forearm, as grip does at the
        // keys. Blending the keys' rolls instead folds the wrist back on itself when the prop swings across the body.
        const wrist = worldPos(hand), d = palm(asset, limb.tip, held.prop).sub(wrist), f = wrist.clone().sub(worldPos(asset.bones[limb.mid]));
        const across = d.sub(axis.clone().multiplyScalar(d.dot(axis)));
        if (across.lengthSq() < 1e-10) break;
        const roll = new THREE.Quaternion().setFromAxisAngle(axis, Math.atan2(f.dot(axis.clone().cross(across)), f.dot(across)));
        q.premultiply(roll);
        p.sub(center).applyQuaternion(roll).add(center);
      }
      forearmTakesTwist(asset, limb.mid, limb.tip);
      return worldPos(hand).distanceTo(p);
    };

    // A nudge slides the prop, tips it about its grip (spins are about character axes) or swivels the elbows. It rises
    // and falls as one smooth bump across an in-between span, zero at both keys, so the fix never flickers.
    interface Nudge { move: THREE.Vector3; spin: THREE.Quaternion; swivel: [number, number] }
    const none: Nudge = { move: V(), spin: new THREE.Quaternion(), swivel: [0, 0] };
    const solve = (time: number, i: number, nudge: Nudge) => {
      const a = snaps[i], b = snaps[i + 1], u = (time - sorted[i].time) / (sorted[i + 1].time - sorted[i].time);
      const e = settings.interpolation === 'smooth' ? u * u * (3 - 2 * u) : settings.interpolation === 'stepped' ? 0 : u;
      const w = Math.sin(Math.PI * u);
      const sampled = sample(time);
      applyPose(asset, sampled); asset.root.updateMatrixWorld(true);
      const frame = frameOf(), prop = asset.bones[held.prop];
      const from = a.rel.clone().normalize(), to = b.rel.clone().normalize();
      const along = from.applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(from.clone(), to), e));
      const grip = pivot().add(toWorldDir(frame, along.multiplyScalar(THREE.MathUtils.lerp(a.rel.length(), b.rel.length(), e)).toArray())).add(toWorldDir(frame, nudge.move.clone().multiplyScalar(w).toArray()));
      const spin = new THREE.Quaternion().slerp(nudge.spin, w), axis = toWorldDir(frame, [spin.x, spin.y, spin.z]);
      spin.set(axis.x, axis.y, axis.z, spin.w);
      const turn = spin.multiply(heading(frame)).multiply(a.turn.clone().slerp(b.turn, e));
      const size = V(); prop.matrixWorld.decompose(V(), new THREE.Quaternion(), size);
      const at = grip.sub(a.grip.clone().lerp(b.grip, e).multiply(size).applyQuaternion(turn));
      const target = new THREE.Matrix4().compose(at, turn, size);
      // The holding hand carries the prop: put the hand wherever the prop needs it.
      const handToProp = asset.bones[held.holder.tip].matrixWorld.clone().invert().multiply(prop.matrixWorld);
      let miss = place(held.holder, target.clone().multiply(handToProp.invert()), frame, [a.arms[0], b.arms[0]], e, nudge.swivel[0] * w);
      const two = both(i);
      if (two) miss += place(held.other!, target.clone().multiply(new THREE.Matrix4().compose(a.other!.p.clone().lerp(b.other!.p, e), a.other!.q.clone().slerp(b.other!.q, e), a.other!.s.clone().lerp(b.other!.s, e))), frame, [a.arms[1], b.arms[1]], e, nudge.swivel[1] * w, true);
      const { cut, sink, where } = clearance(asset, held);
      const hands = two ? [held.holder, held.other!] : [held.holder];
      const bend = Math.max(...hands.map(l => wristBend(asset, l, held.prop)));
      // How far each wrist strays from what the keys alone would do: a wrist whipping round between keys reads as a pop.
      const stray = Math.max(...hands.map(l => deg(asset.bones[l.tip].quaternion.angleTo(new THREE.Quaternion().fromArray(sampled[l.tip].quaternion)))));
      return { cut, sink, where, bend, bad: Math.max(0, cm(cut) - 1) * 30 + Math.max(0, cm(sink) - 1) * 30 + cm(miss) * 25 + Math.max(0, bend - 35) * .5 + Math.max(0, stray - 20) * .5 };
    };
    // A nudge costs its size, and more when the span is short: a big tip in a tenth of a second reads as a flick.
    const spinOf = (n: Nudge) => THREE.MathUtils.radToDeg(n.spin.angleTo(none.spin));
    const price = (n: Nudge, duration: number) => (cm(n.move.length()) + spinOf(n) * .5 + (Math.abs(n.swivel[0]) + Math.abs(n.swivel[1])) * .15) * Math.max(1, .25 / duration);
    const spanScore = (times: number[], i: number, n: Nudge) => times.reduce((sum, t) => sum + solve(t, i, n).bad, 0) + price(n, sorted[i + 1].time - sorted[i].time) * times.length;
    const turnBy = (d: Vec3, deg: number) => new THREE.Quaternion().setFromAxisAngle(V(...d), THREE.MathUtils.degToRad(deg));

    const times = bakeTimes(sorted[0].time, sorted[sorted.length - 1].time, sorted.map(k => k.time));
    const out: PoseKey[] = [];
    const nudges: { from: number; to: number; slideCm: number; tipDegrees: number; elbowSwivel: [number, number] }[] = [];
    let nudged = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const span = times.filter(t => t > sorted[i].time && t < sorted[i + 1].time && !authored.has(Math.fround(t)));
      let best = { nudge: none, score: spanScore(span, i, none) };
      if (span.some(t => solve(t, i, none).bad > 0)) {
        const rank = (nudges: Nudge[]) => nudges.map(nudge => ({ nudge, score: spanScore(span, i, nudge) })).reduce((x, y) => y.score < x.score ? y : x);
        const move = rank(AXES.flatMap(d => [.05, .1, .2].map(m => ({ ...none, move: V(...d).multiplyScalar(m * scale) }))));
        const spin = rank(AXES.slice(0, 3).flatMap(d => [-40, -20, 20, 40].map(deg => ({ ...none, spin: turnBy(d, deg) }))));
        const swivel = rank([-50, -25, 25, 50].flatMap(deg => [[deg, 0], ...(both(i) ? [[0, deg]] : [])].map(pair => ({ ...none, swivel: pair as [number, number] }))));
        // Sliding, tipping and swivelling together often fixes what none does alone.
        best = rank([best.nudge, move.nudge, spin.nudge, swivel.nudge, { move: move.nudge.move, spin: spin.nudge.spin, swivel: swivel.nudge.swivel }]);
        if (best.nudge !== none) { nudged += span.length; nudges.push({ from: round(sorted[i].time), to: round(sorted[i + 1].time), slideCm: Math.round(best.nudge.move.length() * 100), tipDegrees: Math.round(spinOf(best.nudge)), elbowSwivel: best.nudge.swivel }); }
      }
      const key = sorted[i];
      if (!out.length) out.push({ ...key, ...morphs(key.time) });
      for (const t of span) {
        solve(t, i, best.nudge);
        out.push({ id: crypto.randomUUID(), time: t, pose: capturePose(asset), ...morphs(t) });
      }
      out.push({ ...sorted[i + 1], ...morphs(sorted[i + 1].time) });
    }
    // Full strength: a planted foot stays exactly where it landed.
    const baked = ground ? applyPhysics(asset, out, { ...settings, floorContact: true, strength: 1 }) : out;
    // Report what actually ships: the grounded bake, keys included.
    let wrist = { degrees: 0, at: 0 }, cut = { cm: 0, at: 0, where: '' }, sink = { cm: 0, at: 0 };
    for (const key of baked) {
      applyPose(asset, key.pose); asset.root.updateMatrixWorld(true);
      const c = clearance(asset, held);
      const otherOn = !!held.other && onProp(asset, held.prop, palm(asset, held.other.tip, held.prop), .06 * scale);
      const bend = Math.max(wristBend(asset, held.holder, held.prop), otherOn ? wristBend(asset, held.other!, held.prop) : 0);
      if (bend > wrist.degrees) wrist = { degrees: Math.round(bend), at: round(key.time) };
      if (c.cut * 100 > cut.cm) cut = { cm: Math.round(c.cut * 100), at: round(key.time), where: c.where };
      if (c.sink * 100 > sink.cm) sink = { cm: Math.round(c.sink * 100), at: round(key.time) };
    }
    // Name the keys to change: the key at the problem, or the two keys around it.
    const named = (k: PoseKey) => `the ${k.label ? `"${k.label}" key` : 'key'} at ${round(k.time)}s`;
    const keysAt = (time: number) => {
      const at = sorted.find(k => Math.abs(k.time - time) < 1e-3);
      if (at) return named(at);
      const after = sorted.findIndex(k => k.time > time);
      return after > 0 ? `${named(sorted[after - 1])} or ${named(sorted[after])}` : named(sorted[after < 0 ? sorted.length - 1 : 0]);
    };
    const warnings: string[] = [];
    if (cut.cm > 3) warnings.push(`${held.name} still cuts ${cut.cm} cm into the ${cut.where} at ${cut.at}s. Re-hold ${keysAt(cut.at)} further from the body.`);
    if (sink.cm > 3) warnings.push(`${held.name} still sinks ${sink.cm} cm into the floor at ${sink.at}s. Raise the hands or flatten the prop at ${keysAt(sink.at)}.`);
    const loose = sorted.filter((_, k) => !snaps[k].otherOn);
    if (held.other && loose.length && loose.length < sorted.length) warnings.push(`The ${held.other.end} is off ${held.name} at ${loose.map(named).join(', ')}, so it hangs free next to ${loose.length > 1 ? 'those keys' : 'that key'}. Re-hold ${loose.length > 1 ? 'them' : 'it'} (see its hold note) to carry the prop with both hands all the way.`);
    return { keys: baked, metrics: { prop: held.name, frames: out.length, bothHands: !!held.other && !loose.length, nudgedFrames: nudged, nudges, worstCutCm: cut.cm, worstSinkCm: sink.cm, worstWrist: wrist }, warnings };
  } finally { applyPose(asset, saved); asset.root.updateMatrixWorld(true); }
}
