import * as THREE from 'three';
import type { CharacterAsset, Vec3 } from '../types';
import { applyPose, capturePose } from './character';

/** Character-space nudge at the rest pose: move in cm (x left, y up, z forward), turn in degrees, size in percent. */
export interface PartFit { move: Vec3; turn: Vec3; size: number }
export const NO_FIT: PartFit = { move: [0, 0, 0], turn: [0, 0, 0], size: 100 };
export interface CharacterPart { id: string; label: string; mesh: THREE.Mesh }

/** Every mesh in the look, named the way a person knows it: by its material. */
export function characterParts(asset: CharacterAsset): CharacterPart[] {
  const meshes: THREE.Mesh[] = [];
  asset.root.traverse(node => { if (node instanceof THREE.Mesh && node.geometry.getAttribute('position')) meshes.push(node); });
  const names = meshes.map(mesh => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => material.name).filter(Boolean).join(' + ') || mesh.name || 'Part');
  return meshes.map((mesh, index) => {
    const twins = names.filter(name => name === names[index]).length;
    return { id: mesh.uuid, label: twins > 1 ? `${names[index]} ${names.slice(0, index + 1).filter(name => name === names[index]).length}` : names[index], mesh };
  });
}

export const isFitted = (mesh: THREE.Mesh) => Array.isArray(mesh.userData.stillFit) && mesh.userData.stillFit.length === 16;

const fitMatrix = (fit: PartFit, centre: THREE.Vector3) => new THREE.Matrix4()
  .makeTranslation(centre.x + fit.move[0] / 100, centre.y + fit.move[1] / 100, centre.z + fit.move[2] / 100)
  .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...fit.turn.map(THREE.MathUtils.degToRad) as Vec3, 'XYZ')))
  .multiply(new THREE.Matrix4().makeScale(fit.size / 100, fit.size / 100, fit.size / 100))
  .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));

/**
 * Move, turn or resize one mesh of the look as it stands in the rest pose.
 * The change is baked into the mesh through its own skin binding, so the part
 * keeps riding its bones in every pose, the saved scene and every export.
 */
export function partFitter(asset: CharacterAsset, mesh: THREE.Mesh) {
  // A geometry shared with another mesh gets its own copy, so only this part moves.
  let shared = false;
  asset.root.traverse(node => { if (node !== mesh && node instanceof THREE.Mesh && node.geometry === mesh.geometry) shared = true; });
  if (shared) mesh.geometry = mesh.geometry.clone();
  const geometry = mesh.geometry;
  const count = geometry.getAttribute('position').count;
  // Positions move as points; normals by the inverse transpose; tangents and relative morphs as directions.
  type Kind = 'point' | 'normal' | 'vector' | 'normalDelta';
  const channels: { attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; kind: Kind; saved: Float64Array }[] = [];
  const track = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, kind: Kind) => {
    if (!attribute || attribute.count !== count || attribute.itemSize < 3) return;
    const saved = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) { saved[i * 3] = attribute.getX(i); saved[i * 3 + 1] = attribute.getY(i); saved[i * 3 + 2] = attribute.getZ(i); }
    channels.push({ attribute, kind, saved });
  };
  track(geometry.getAttribute('position'), 'point');
  track(geometry.getAttribute('normal'), 'normal');
  track(geometry.getAttribute('tangent'), 'vector');
  for (const attribute of geometry.morphAttributes.position ?? []) track(attribute, geometry.morphTargetsRelative ? 'vector' : 'point');
  for (const attribute of geometry.morphAttributes.normal ?? []) track(attribute, geometry.morphTargetsRelative ? 'normalDelta' : 'normal');
  const baseNormals = channels.find(channel => channel.attribute === geometry.getAttribute('normal'))?.saved;

  // Per vertex: geometry space -> character space in the rest pose, exactly as the skinning shader does it.
  const toRest = new Float64Array(count * 16);
  const pose = capturePose(asset);
  applyPose(asset, asset.restPose);
  try {
    const toRoot = asset.root.matrixWorld.clone().invert();
    if (mesh instanceof THREE.SkinnedMesh) {
      const { bones, boneInverses } = mesh.skeleton;
      const skinToRoot = toRoot.clone().multiply(mesh.matrixWorld).multiply(mesh.bindMatrixInverse);
      const boneMatrices = bones.map((bone, index) => skinToRoot.clone().multiply(bone.matrixWorld).multiply(boneInverses[index]).multiply(mesh.bindMatrix).elements);
      const indices = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
      for (let v = 0; v < count; v++) {
        for (let k = 0; k < 4; k++) {
          const weight = weights.getComponent(v, k);
          if (!weight) continue;
          const matrix = boneMatrices[indices.getComponent(v, k)];
          for (let e = 0; e < 16; e++) toRest[v * 16 + e] += weight * matrix[e];
        }
      }
    } else {
      const matrix = toRoot.multiply(mesh.matrixWorld).elements;
      for (let v = 0; v < count; v++) toRest.set(matrix, v * 16);
    }
  } finally { applyPose(asset, pose); }

  const positions = channels[0].saved;
  const point = new THREE.Vector3(), base = new THREE.Vector3(), forward = new THREE.Matrix4(), inverse = new THREE.Matrix4(), local = new THREE.Matrix4(), linear = new THREE.Matrix3(), normals = new THREE.Matrix3();
  const bounds = new THREE.Box3();
  // A vertex with no skin weights renders nowhere; it neither sets the centre nor moves.
  const bound = new Uint8Array(count);
  for (let v = 0; v < count; v++) {
    if (!forward.fromArray(toRest, v * 16).determinant()) continue;
    bound[v] = 1; bounds.expandByPoint(point.fromArray(positions, v * 3).applyMatrix4(forward));
  }
  const centre = bounds.getCenter(new THREE.Vector3());

  const write = (change: THREE.Matrix4 | null) => {
    for (let v = 0; v < count; v++) {
      const moved = !!change && !!bound[v];
      if (moved) {
        forward.fromArray(toRest, v * 16);
        local.multiplyMatrices(inverse.copy(forward).invert(), change!).multiply(forward);
        linear.setFromMatrix4(local); normals.getNormalMatrix(local);
      }
      for (const { attribute, kind, saved } of channels) {
        point.fromArray(saved, v * 3);
        if (moved) {
          if (kind === 'point') point.applyMatrix4(local);
          else if (kind === 'vector') point.applyMatrix3(linear);
          else if (kind === 'normal') point.applyMatrix3(normals).normalize();
          // A relative normal target is a delta: turn the morphed normal, then subtract the turned base.
          else if (!baseNormals) point.applyMatrix3(normals);
          else { base.fromArray(baseNormals, v * 3); point.add(base).applyMatrix3(normals).normalize().sub(base.applyMatrix3(normals).normalize()); }
        }
        attribute.setXYZ(v, point.x, point.y, point.z);
      }
    }
    for (const { attribute } of channels) attribute.needsUpdate = true;
    geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    if (mesh instanceof THREE.SkinnedMesh) { mesh.computeBoundingBox(); mesh.computeBoundingSphere(); }
  };
  const keep = (change: THREE.Matrix4) => {
    write(change);
    for (const channel of channels) for (let v = 0; v < count; v++) {
      channel.saved[v * 3] = channel.attribute.getX(v); channel.saved[v * 3 + 1] = channel.attribute.getY(v); channel.saved[v * 3 + 2] = channel.attribute.getZ(v);
    }
  };

  return {
    /** Show a fit without keeping it. */
    preview: (fit: PartFit) => write(fitMatrix(fit, centre)),
    /** Put back whatever the mesh looked like when this fitter was made (or last applied). */
    restore: () => write(null),
    /** Keep a fit. The running total is stored on the mesh so it can be undone later. */
    apply: (fit: PartFit) => {
      const change = fitMatrix(fit, centre);
      keep(change);
      const total = isFitted(mesh) ? change.clone().multiply(new THREE.Matrix4().fromArray(mesh.userData.stillFit)) : change;
      mesh.userData.stillFit = total.toArray();
    },
    /** Undo every fit this mesh has had. */
    reset: () => {
      if (!isFitted(mesh)) return;
      keep(new THREE.Matrix4().fromArray(mesh.userData.stillFit).invert());
      delete mesh.userData.stillFit;
    },
  };
}
