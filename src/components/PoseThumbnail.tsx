import { useMemo } from 'react';
import * as THREE from 'three';
import type { CharacterAsset, Pose } from '../types';

interface Props { asset: CharacterAsset; pose: Pose }
interface Segment { key: string; from: THREE.Vector3; to: THREE.Vector3; width: number; depth: number }

const DETAIL_JOINT = /thumb|index|middle|ring|pinky|little|finger|metacarp|twist|roll|end|nub|helper|target|pole|(^|[_:])ik([_:]|$)/i;
const HEAD_JOINT = /(^|[:_])head$|head$/i;

/** Evaluate pose transforms independently of the animated scene graph. */
function positionsFor(asset: CharacterAsset, pose: Pose): Map<THREE.Bone, THREE.Vector3> {
  const indices = new Map(asset.bones.map((bone, index) => [bone as THREE.Object3D, index]));
  const world = new Map<THREE.Object3D, THREE.Matrix4>();
  const matrixFor = (object: THREE.Object3D): THREE.Matrix4 => {
    const cached = world.get(object);
    if (cached) return cached;
    const index = indices.get(object);
    const transform = index === undefined ? undefined : pose[index];
    let local: THREE.Matrix4;
    if (transform) {
      local = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(transform.position),
        new THREE.Quaternion().fromArray(transform.quaternion).normalize(),
        new THREE.Vector3().fromArray(transform.scale),
      );
    } else {
      local = object.matrixAutoUpdate
        ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
        : object.matrix.clone();
    }
    // Include the asset's normalization groups, but not the editor's scene or camera.
    if (object !== asset.root && object.parent) local.premultiply(matrixFor(object.parent));
    world.set(object, local);
    return local;
  };
  return new Map(asset.bones.map((bone) => [bone, new THREE.Vector3().setFromMatrixPosition(matrixFor(bone))]));
}

export default function PoseThumbnail({ asset, pose }: Props) {
  const model = useMemo(() => {
    const shown = asset.bones.filter((bone) => !DETAIL_JOINT.test(bone.name));
    const shownSet = new Set(shown);
    const rest = positionsFor(asset, asset.restPose);
    const current = positionsFor(asset, pose);
    // A three-quarter yaw separates overlapping limbs, particularly on animals.
    const yaw = asset.kind === 'quadruped' ? 0.94 : 0.27;
    const cosine = Math.cos(yaw);
    const sine = Math.sin(yaw);
    const projectX = (point: THREE.Vector3) => point.x * cosine + point.z * sine;
    const depth = (point: THREE.Vector3) => point.z * cosine - point.x * sine;
    const height = Math.max(asset.height, 0.01);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const bone of shown) {
      const point = rest.get(bone)!;
      minX = Math.min(minX, projectX(point));
      maxX = Math.max(maxX, projectX(point));
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    if (!shown.length) return null;
    // Framing is fixed to the rest pose, so a crouch remains shorter than a stand.
    const scale = Math.min(69 / Math.max(maxX - minX + height * 0.20, height * 0.52), 76 / Math.max(height, maxY - minY + height * 0.15));
    const centerX = (minX + maxX) / 2;
    const floorY = minY - height * 0.035;
    const project = (point: THREE.Vector3) => ({ x: 45 + (projectX(point) - centerX) * scale, y: 86 - (point.y - floorY) * scale });
    const segments: Segment[] = [];
    for (const bone of shown) {
      let parent: THREE.Object3D | null = bone.parent;
      while (parent && parent !== asset.root && !shownSet.has(parent as THREE.Bone)) parent = parent.parent;
      if (!(parent instanceof THREE.Bone) || !shownSet.has(parent)) continue;
      const from = current.get(parent)!;
      const to = current.get(bone)!;
      if (from.distanceToSquared(to) < 1e-10) continue;
      const torso = /spine|chest/i.test(bone.name) && /hips|pelvis|spine|chest/i.test(parent.name);
      const thigh = /upleg|upperleg|thigh/i.test(parent.name);
      const width = height * scale * (torso ? (asset.kind === 'quadruped' ? 0.17 : 0.14) : thigh ? 0.085 : 0.058);
      segments.push({ key: bone.uuid, from, to, width, depth: (depth(from) + depth(to)) / 2 });
    }
    segments.sort((a, b) => a.depth - b.depth);
    const heads = shown.filter((bone) => HEAD_JOINT.test(bone.name)).map((bone) => ({ key: bone.uuid, ...project(current.get(bone)!) }));
    return { segments, heads, project, headRadius: height * scale * (asset.kind === 'quadruped' ? 0.070 : 0.076) };
  }, [asset, pose]);

  return <svg className="pose-sketch" viewBox="0 0 90 96" fill="none" aria-hidden="true">
    <ellipse cx="45" cy="88" rx="23" ry="2.7" fill="currentColor" opacity=".06" />
    {model && <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {model.segments.map((segment) => {
        const from = model.project(segment.from);
        const to = model.project(segment.to);
        return <line key={segment.key} x1={from.x} y1={from.y} x2={to.x} y2={to.y} strokeWidth={segment.width} />;
      })}
      {model.heads.map((head) => <circle key={head.key} cx={head.x} cy={head.y} r={model.headRadius} fill="currentColor" stroke="none" />)}
    </g>}
  </svg>;
}
