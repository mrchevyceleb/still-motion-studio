import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { CharacterAsset, MorphValues, Pose, RigKind, Vec3 } from '../types';
import { applyMorphs, captureMorphs, restoreMorphNames, saveMorphNames } from './morphs';
import { fitAnatomicalRig, influenceFamily, type AnatomicalFit, type AutoRigDiagnostics } from './anatomicalRig';
import { fitHandRig, validateRigFit } from './handRig';

const DISPLAY_HEIGHT = 2.4;
const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const UP = new THREE.Vector3(0, 1, 0);

type JointSpec = { name: string; parent?: string; position: Vec3 };
type AssetMetadata = { version: number; restPose: Pose; restMorphs?: MorphValues; warnings: string[]; height: number };

export function capturePose(asset: CharacterAsset): Pose {
  return asset.bones.map((bone) => ({
    position: bone.position.toArray() as Vec3,
    quaternion: bone.quaternion.toArray() as [number, number, number, number],
    scale: bone.scale.toArray() as Vec3,
  }));
}

export function applyPose(asset: CharacterAsset, pose: Pose): void {
  if (pose.length !== asset.bones.length) throw new Error('This pose belongs to a different skeleton.');
  pose.forEach((transform, index) => {
    const bone = asset.bones[index];
    bone.position.fromArray(transform.position);
    bone.quaternion.fromArray(transform.quaternion).normalize();
    bone.scale.fromArray(transform.scale);
  });
  asset.root.updateMatrixWorld(true);
  updateSkeletons(asset.root);
}

function updateSkeletons(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) object.skeleton.update();
  });
}

function makeAsset(root: THREE.Group, kind: RigKind, name: string, source: CharacterAsset['source'], clips: THREE.AnimationClip[], warnings: string[] = []): CharacterAsset {
  const bones: THREE.Bone[] = [];
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (object instanceof THREE.Bone) bones.push(object);
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
      // Animated limbs can leave the bind-pose bounds. Do not let stale bounds hide them.
      if (object instanceof THREE.SkinnedMesh) object.frustumCulled = false;
    }
  });
  root.animations = clips;
  updateSkeletons(root);
  const box = new THREE.Box3().setFromObject(root);
  const height = box.isEmpty() ? DISPLAY_HEIGHT : box.max.y - box.min.y;
  const asset: CharacterAsset = { root, bones, clips, kind, name, source, warnings, height, restPose: [], rigged: bones.length > 0 };
  asset.restPose = capturePose(asset);
  const morphs = captureMorphs(asset);
  if (Object.keys(morphs).length) asset.restMorphs = morphs;
  saveMetadata(asset);
  return asset;
}

function saveMetadata(asset: CharacterAsset): void {
  saveMorphNames(asset);
  asset.root.userData.stillAsset = {
    version: 1,
    restPose: structuredClone(asset.restPose),
    ...(asset.restMorphs ? { restMorphs: { ...asset.restMorphs } } : {}),
    warnings: [...asset.warnings],
    height: asset.height,
  } satisfies AssetMetadata;
}

function humanoidJoints(): JointSpec[] {
  const joints: JointSpec[] = [
    { name: 'Hips', position: [0, 1.16, 0] },
    { name: 'Spine', parent: 'Hips', position: [0, 1.40, 0] },
    { name: 'Spine1', parent: 'Spine', position: [0, 1.68, 0] },
    { name: 'Neck', parent: 'Spine1', position: [0, 1.98, 0] },
    { name: 'Head', parent: 'Neck', position: [0, 2.13, 0] },
  ];
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    joints.push(
      { name: `${side}Shoulder`, parent: 'Spine1', position: [sign * 0.27, 1.84, 0] },
      { name: `${side}Arm`, parent: `${side}Shoulder`, position: [sign * 0.39, 1.82, 0] },
      { name: `${side}ForeArm`, parent: `${side}Arm`, position: [sign * 0.62, 1.47, 0.025] },
      { name: `${side}Hand`, parent: `${side}ForeArm`, position: [sign * 0.76, 1.14, 0.08] },
      { name: `${side}UpLeg`, parent: 'Hips', position: [sign * 0.18, 1.12, 0] },
      { name: `${side}Leg`, parent: `${side}UpLeg`, position: [sign * 0.19, 0.62, 0.04] },
      { name: `${side}Foot`, parent: `${side}Leg`, position: [sign * 0.19, 0.13, 0] },
      { name: `${side}ToeBase`, parent: `${side}Foot`, position: [sign * 0.19, 0.08, 0.23] },
    );
  }
  return joints;
}

function quadrupedJoints(): JointSpec[] {
  const joints: JointSpec[] = [
    { name: 'Hips', position: [0, 1.28, -0.61] },
    { name: 'Spine', parent: 'Hips', position: [0, 1.36, 0.55] },
    { name: 'Neck', parent: 'Spine', position: [0, 1.95, 0.88] },
    { name: 'Head', parent: 'Neck', position: [0, 2.12, 1.11] },
    { name: 'Tail', parent: 'Hips', position: [0, 1.37, -1.01] },
    { name: 'TailTip', parent: 'Tail', position: [0, 0.78, -1.29] },
  ];
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    for (const [pair, z, parent] of [['Front', 0.55, 'Spine'], ['Hind', -0.62, 'Hips']] as const) {
      const limb = `${pair}${side}`;
      joints.push(
        { name: `${limb}UpperLeg`, parent, position: [sign * 0.28, 1.24, z] },
        { name: `${limb}LowerLeg`, parent: `${limb}UpperLeg`, position: [sign * 0.30, 0.67, z + (pair === 'Front' ? 0.04 : -0.15)] },
        { name: `${limb}Foot`, parent: `${limb}LowerLeg`, position: [sign * 0.30, 0.13, z + 0.08] },
      );
    }
  }
  return joints;
}

function createSkeleton(root: THREE.Group, specs: JointSpec[]): Map<string, THREE.Bone> {
  const bones = new Map<string, THREE.Bone>();
  const positions = new Map(specs.map((spec) => [spec.name, new THREE.Vector3(...spec.position)]));
  for (const spec of specs) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.copy(positions.get(spec.name)!);
    if (spec.parent) {
      bone.position.sub(positions.get(spec.parent)!);
      bones.get(spec.parent)!.add(bone);
    } else root.add(bone);
    bones.set(spec.name, bone);
  }
  root.updateMatrixWorld(true);
  return bones;
}

function ellipsoid(bone: THREE.Bone, material: THREE.Material, scale: Vec3, offset: Vec3 = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
  mesh.name = `${bone.name}_surface`;
  mesh.scale.set(...scale);
  mesh.position.set(...offset);
  bone.add(mesh);
  return mesh;
}

function capsule(bone: THREE.Bone, destination: THREE.Vector3, radius: number, material: THREE.Material, taper = 1): THREE.Mesh {
  const length = destination.length();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(0.005, length - radius * 2), 8, 18), material);
  mesh.name = `${bone.name}_limb`;
  mesh.position.copy(destination).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, destination.clone().normalize());
  mesh.scale.z = taper;
  bone.add(mesh);
  return mesh;
}

export function createDemoCharacter(kind: RigKind): CharacterAsset {
  const root = new THREE.Group();
  root.name = 'Still_character';
  const bones = createSkeleton(root, kind === 'humanoid' ? humanoidJoints() : quadrupedJoints());
  const cream = new THREE.MeshStandardMaterial({ color: '#e6dfce', roughness: 0.66, metalness: 0.03 });
  const accent = new THREE.MeshStandardMaterial({ color: '#b97154', roughness: 0.73 });
  const joint = new THREE.MeshStandardMaterial({ color: '#827562', roughness: 0.8 });
  const bone = (name: string) => bones.get(name)!;

  if (kind === 'humanoid') {
    ellipsoid(bone('Hips'), accent, [0.28, 0.20, 0.18], [0, 0.01, 0]);
    ellipsoid(bone('Spine'), cream, [0.235, 0.20, 0.15], [0, 0.01, 0]);
    ellipsoid(bone('Spine1'), cream, [0.33, 0.26, 0.18], [0, 0.025, 0]);
    capsule(bone('Neck'), bone('Head').position, 0.079, joint);
    ellipsoid(bone('Head'), cream, [0.175, 0.235, 0.16], [0, 0.034, 0]);
    // A subtle face marker makes the character's forward direction readable.
    ellipsoid(bone('Head'), accent, [0.088, 0.014, 0.013], [0, 0.055, 0.158]);
    for (const side of ['Left', 'Right']) {
      capsule(bone(`${side}Shoulder`), bone(`${side}Arm`).position, 0.095, cream);
      capsule(bone(`${side}Arm`), bone(`${side}ForeArm`).position, 0.093, cream);
      capsule(bone(`${side}ForeArm`), bone(`${side}Hand`).position, 0.072, cream);
      ellipsoid(bone(`${side}Arm`), joint, [0.095, 0.095, 0.095]);
      ellipsoid(bone(`${side}ForeArm`), accent, [0.076, 0.076, 0.076]);
      ellipsoid(bone(`${side}Hand`), accent, [0.074, 0.11, 0.045], [0, -0.055, 0]);
      capsule(bone(`${side}UpLeg`), bone(`${side}Leg`).position, 0.125, cream);
      capsule(bone(`${side}Leg`), bone(`${side}Foot`).position, 0.091, cream);
      ellipsoid(bone(`${side}Leg`), accent, [0.099, 0.099, 0.099]);
      ellipsoid(bone(`${side}Foot`), joint, [0.082, 0.082, 0.082]);
      ellipsoid(bone(`${side}Foot`), cream, [0.095, 0.077, 0.19], [0, -0.052, 0.09]);
    }
  } else {
    capsule(bone('Hips'), bone('Spine').position, 0.34, cream, 1);
    ellipsoid(bone('Hips'), accent, [0.37, 0.35, 0.33]);
    ellipsoid(bone('Spine'), cream, [0.36, 0.40, 0.33]);
    capsule(bone('Spine'), bone('Neck').position, 0.20, cream);
    capsule(bone('Neck'), bone('Head').position, 0.17, cream);
    ellipsoid(bone('Head'), cream, [0.20, 0.24, 0.28]);
    ellipsoid(bone('Head'), accent, [0.19, 0.13, 0.18], [0, -0.07, 0.24]);
    ellipsoid(bone('Head'), cream, [0.07, 0.16, 0.07], [0.13, 0.20, -0.08]);
    ellipsoid(bone('Head'), cream, [0.07, 0.16, 0.07], [-0.13, 0.20, -0.08]);
    capsule(bone('Tail'), bone('TailTip').position, 0.07, accent);
    for (const side of ['Left', 'Right']) for (const pair of ['Front', 'Hind']) {
      const prefix = `${pair}${side}`;
      capsule(bone(`${prefix}UpperLeg`), bone(`${prefix}LowerLeg`).position, 0.11, cream);
      capsule(bone(`${prefix}LowerLeg`), bone(`${prefix}Foot`).position, 0.075, cream);
      ellipsoid(bone(`${prefix}LowerLeg`), accent, [0.084, 0.084, 0.084]);
      ellipsoid(bone(`${prefix}Foot`), joint, [0.105, 0.11, 0.135], [0, -0.02, 0.01]);
    }
  }
  return makeAsset(root, kind, kind === 'humanoid' ? 'The everyday mover' : 'The four-legged friend', 'demo', []);
}

function normalizeImported(object: THREE.Object3D): THREE.Group {
  const root = new THREE.Group();
  root.name = 'Still_character';
  const normalization = new THREE.Group();
  normalization.name = 'Still_display_scale';
  normalization.add(object);
  root.add(normalization);
  root.updateMatrixWorld(true);
  updateSkeletons(root);
  let box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    const point = new THREE.Vector3();
    root.traverse((node) => { if (node instanceof THREE.Bone) box.expandByPoint(node.getWorldPosition(point)); });
  }
  if (!box.isEmpty()) {
    const height = box.max.y - box.min.y;
    if (height > 0.000001 && Number.isFinite(height)) {
      const center = box.getCenter(new THREE.Vector3());
      const scale = DISPLAY_HEIGHT / height;
      normalization.scale.setScalar(scale);
      normalization.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    }
  }
  root.updateMatrixWorld(true);
  return root;
}

function rejectExternalGLTFResources(json: unknown): void {
  const document = json as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  for (const resource of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    if (resource.uri && !resource.uri.startsWith('data:')) {
      throw new Error('This file references separate textures or buffers. Export a single .glb with embedded resources, then import it here.');
    }
  }
}

function checkGLBResources(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 20) throw new Error('This GLB file is incomplete.');
  const data = new DataView(buffer);
  if (data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2) throw new Error('Use a glTF 2.0 binary (.glb) file.');
  const length = data.getUint32(12, true);
  if (length > buffer.byteLength - 20) throw new Error('This GLB file is incomplete.');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  rejectExternalGLTFResources(json);
}

function restoreExportedJointTypes(root: THREE.Object3D): void {
  // glTF identifies joints through skin membership. Unweighted end joints (and
  // rigid mannequin joints) otherwise come back as generic transform nodes.
  const nodes: THREE.Object3D[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Bone) && node.userData.stillJoint === true) nodes.push(node);
  });
  for (const node of nodes) {
    if (!node.parent) continue;
    const bone = new THREE.Bone().copy(node, false);
    bone.uuid = node.uuid;
    const parent = node.parent;
    const index = parent.children.indexOf(node);
    for (const child of [...node.children]) bone.add(child);
    parent.remove(node);
    parent.add(bone);
    parent.children.splice(parent.children.indexOf(bone), 1);
    parent.children.splice(index, 0, bone);
  }
}

export async function importCharacter(file: File): Promise<CharacterAsset> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['fbx', 'glb', 'gltf'].includes(extension ?? '')) throw new Error('Choose an FBX or GLB character. Self-contained glTF files also work.');
  if (file.size > 150 * 1024 * 1024) throw new Error('This file is over 150 MB. Export a lighter character to keep editing responsive.');
  const warnings: string[] = [];
  const manager = new THREE.LoadingManager();
  let loading = false;
  let finishLoading: () => void = () => {};
  const imagesLoaded = new Promise<void>((resolve) => { finishLoading = resolve; });
  manager.onStart = () => { loading = true; };
  manager.onLoad = () => finishLoading();
  manager.onError = () => { warnings.push('A texture could not be loaded. The character’s rig and animation are still available.'); };
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    if (!warnings.some((warning) => warning.startsWith('External textures'))) warnings.push('External textures are not included in this FBX. Export embedded textures or use GLB to keep its appearance.');
    return WHITE_PIXEL;
  });

  let object: THREE.Object3D;
  let clips: THREE.AnimationClip[];
  const bytes = await file.arrayBuffer();
  if (extension === 'fbx') {
    object = new FBXLoader(manager).parse(bytes, '');
    clips = object.animations;
    if (loading) await imagesLoaded;
  } else {
    const loader = new GLTFLoader(manager);
    let input: string | ArrayBuffer = bytes;
    if (extension === 'gltf') {
      input = new TextDecoder().decode(bytes);
      rejectExternalGLTFResources(JSON.parse(input));
    } else checkGLBResources(bytes);
    const gltf = await loader.parseAsync(input, '');
    object = gltf.scene;
    clips = gltf.animations;
    restoreExportedJointTypes(object);
  }
  let meshes = 0;
  let boneCount = 0;
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) meshes += 1;
    if (node instanceof THREE.Bone) boneCount += 1;
  });
  if (!meshes && !boneCount) throw new Error('This file has no character mesh or skeleton.');
  if (!meshes) warnings.push('This is an animation-only skeleton. Export from Mixamo with “With Skin” to include the character.');
  if (!boneCount) warnings.push('No rig found. Choose a body type and add a starter rig.');
  const boneNames: string[] = [];
  object.traverse(node => { if (node instanceof THREE.Bone) boneNames.push(node.name.toLowerCase().replace(/[^a-z]/g, '')); });
  const kind: RigKind = boneNames.some(name => /front.*(leg|foot)/.test(name)) && boneNames.some(name => /(hind|back).*(leg|foot)/.test(name)) ? 'quadruped' : 'humanoid';
  const asset = makeAsset(normalizeImported(object), kind, file.name.replace(/\.[^.]+$/, ''), 'import', clips, [...new Set(warnings)]);
  return asset;
}

function cloneMaterials(root: THREE.Object3D): void {
  const materials = new Map<THREE.Material, THREE.Material>();
  const textures = new Map<THREE.Texture, THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    // A generic buffer geometry serializes added skin attributes. Primitive
    // classes otherwise save only construction parameters and lose the weights.
    object.geometry = new THREE.BufferGeometry().copy(object.geometry);
    const cloneMaterial = (original: THREE.Material): THREE.Material => {
      const existing = materials.get(original);
      if (existing) return existing;
      const copied = original.clone();
      for (const [key, value] of Object.entries(copied)) {
        if (value instanceof THREE.Texture) {
          let texture = textures.get(value);
          if (!texture) { texture = value.clone(); textures.set(value, texture); }
          (copied as unknown as Record<string, unknown>)[key] = texture;
        }
      }
      materials.set(original, copied);
      return copied;
    };
    object.material = Array.isArray(object.material) ? object.material.map(cloneMaterial) : cloneMaterial(object.material);
  });
}

export function getAutoRigDiagnostics(asset: CharacterAsset): AutoRigDiagnostics | null {
  const value = asset.root.userData.stillAutoRig as AutoRigDiagnostics | undefined;
  return value?.version === 1 && value.method === 'geometry-sections' ? structuredClone(value) : null;
}

function smoothSkinWeights(geometry: THREE.BufferGeometry, bones: THREE.Bone[], indices: Uint16Array, weights: Float32Array): void {
  const vertices = geometry.getAttribute('position').count;
  // Bound scratch storage to ~25 MB. Large meshes still receive the same
  // anatomical weights; a lighter export enables the topology smoothing pass.
  if (vertices * bones.length > 6_250_000) return;
  const totals = new Float32Array(vertices * bones.length);
  const families = bones.map(bone => influenceFamily(bone.name));
  for (let v = 0; v < vertices; v++) for (let n = 0; n < 4; n++) totals[v * bones.length + indices[v * 4 + n]] += weights[v * 4 + n] * 4;
  const addNeighbor = (destination: number, source: number) => {
    const a = families[indices[destination * 4]], b = families[indices[source * 4]];
    if (a !== b && a !== 'Torso' && b !== 'Torso') return;
    for (let n = 0; n < 4; n++) totals[destination * bones.length + indices[source * 4 + n]] += weights[source * 4 + n];
  };
  const index = geometry.getIndex();
  const count = index?.count ?? vertices;
  for (let triangle = 0; triangle + 2 < count; triangle += 3) {
    const a = index ? index.getX(triangle) : triangle;
    const b = index ? index.getX(triangle + 1) : triangle + 1;
    const c = index ? index.getX(triangle + 2) : triangle + 2;
    if (a >= vertices || b >= vertices || c >= vertices || Math.min(a, b, c) < 0) throw new Error('The mesh contains an invalid triangle index. Re-export its geometry before adding a rig.');
    addNeighbor(a, b); addNeighbor(a, c); addNeighbor(b, a); addNeighbor(b, c); addNeighbor(c, a); addNeighbor(c, b);
  }
  for (let v = 0; v < vertices; v++) {
    const best = [0, 0, 0, 0], scores = [0, 0, 0, 0];
    for (let bone = 0; bone < bones.length; bone++) {
      const score = totals[v * bones.length + bone];
      for (let slot = 0; slot < 4; slot++) if (score > scores[slot]) {
        best.splice(slot, 0, bone); best.length = 4;
        scores.splice(slot, 0, score); scores.length = 4;
        break;
      }
    }
    const sum = scores.reduce((a, b) => a + b, 0);
    if (!(sum > 0) || !Number.isFinite(sum)) throw new Error('The mesh produced invalid skin weights. Re-export a clean neutral-pose mesh.');
    for (let slot = 0; slot < 4; slot++) { indices[v * 4 + slot] = best[slot]; weights[v * 4 + slot] = scores[slot] / sum; }
  }
}

function collectRigGeometry(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  let vertexCount = 0;
  let triangleCount = 0;
  root.traverse(object => {
    if (object instanceof THREE.Mesh) {
      const count = object.geometry.getAttribute('position')?.count ?? 0;
      vertexCount += count;
      triangleCount += Math.floor((object.geometry.getIndex()?.count ?? count) / 3);
    }
  });
  if (vertexCount > 2_000_000) throw new Error('This mesh has over two million vertices. Export a lighter character before adding an automatic rig.');
  const sampleStride = Math.max(1, Math.ceil(vertexCount / 30_000));
  const triangleStride = Math.max(1, Math.ceil(triangleCount / 30_000));
  const vertices: THREE.Vector3[] = [];
  let cursor = 0;
  let triangleCursor = 0;
  const trianglePoint = new THREE.Vector3();
  const triangleCorner = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    if (!position) return;
    meshes.push(object);
    const transform = rootInverse.clone().multiply(object.matrixWorld);
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index).applyMatrix4(transform);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('This mesh contains invalid vertex coordinates. Re-export a clean mesh before adding a rig.');
      bounds.expandByPoint(point);
      if (cursor++ % sampleStride === 0) vertices.push(point.clone());
    }
    // Face samples fill the gaps between sparse polygon rings. Without these,
    // a low-poly belly can look like two separate legs to a point-only fitter.
    const indices = object.geometry.getIndex();
    const count = indices?.count ?? position.count;
    for (let offset = 0; offset + 2 < count; offset += 3) {
      trianglePoint.set(0, 0, 0);
      for (let corner = 0; corner < 3; corner++) {
        const index = indices ? indices.getX(offset + corner) : offset + corner;
        if (!Number.isInteger(index) || index < 0 || index >= position.count) throw new Error('The mesh contains an invalid triangle index. Re-export its geometry before adding a rig.');
        trianglePoint.add(triangleCorner.fromBufferAttribute(position, index));
      }
      if (triangleCursor++ % triangleStride === 0) vertices.push(trianglePoint.clone().multiplyScalar(1 / 3).applyMatrix4(transform));
    }
  });
  if (meshes.length === 0 || bounds.isEmpty()) throw new Error('A mesh is needed to create a starter rig.');
  if (vertices.length < 32) throw new Error('There is not enough character geometry to identify its limbs. Import a complete character mesh.');
  return { meshes, bounds, vertices };
}

export function estimateAutoRig(asset: CharacterAsset, kind: RigKind, fingers = true): AnatomicalFit {
  if (asset.bones.length) throw new Error('This character already has a rig. Its existing bones are preserved.');
  const { vertices, bounds } = collectRigGeometry(asset.root);
  const fitted = fitAnatomicalRig(kind, vertices, bounds);
  return kind === 'humanoid' && fingers ? fitHandRig(fitted, vertices, bounds) : fitted;
}

export function createRigPreview(asset: CharacterAsset, fit: AnatomicalFit): CharacterAsset {
  const root = cloneSkeleton(asset.root) as THREE.Group;
  cloneMaterials(root);
  try {
    createSkeleton(root, fit.joints);
    return makeAsset(root, fit.diagnostics.bodyType, asset.name, 'import', [], []);
  } catch (error) { disposeCharacter({ ...asset, root }); throw error; }
}

export interface AutoRigOptions { fingers?: boolean; fit?: AnatomicalFit }

export function autoRigCharacter(asset: CharacterAsset, kind: RigKind, options: AutoRigOptions = {}): CharacterAsset {
  if (asset.bones.length) {
    // Replacing an imported skeleton is exactly what makes common Mixamo flows
    // fragile. Existing bindings are authoritative, even for unusual bone names.
    asset.kind = kind;
    return asset;
  }
  const root = cloneSkeleton(asset.root) as THREE.Group;
  cloneMaterials(root);
  try {
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const { meshes, bounds, vertices } = collectRigGeometry(root);
  const point = new THREE.Vector3();
  const body = options.fit ? structuredClone(options.fit) : fitAnatomicalRig(kind, vertices, bounds);
  const fitted = !options.fit && kind === 'humanoid' && options.fingers !== false ? fitHandRig(body, vertices, bounds) : body;
  validateRigFit(fitted, bounds, kind);
  createSkeleton(root, fitted.joints);
  const bones: THREE.Bone[] = [];
  root.traverse((object) => { if (object instanceof THREE.Bone) bones.push(object); });
  const skeleton = new THREE.Skeleton(bones);
  root.updateMatrixWorld(true);
  const segments = bones.map((bone) => {
    const start = bone.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInverse);
    const ends = bone.children.filter((child): child is THREE.Bone => child instanceof THREE.Bone)
      .map((child) => child.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInverse));
    return (ends.length ? ends : [start]).map((end) => new THREE.Line3(start, end));
  });
  const closest = new THREE.Vector3();
  const epsilon = Math.max(bounds.getSize(new THREE.Vector3()).y * 0.018, 0.001);
  const families = bones.map(bone => influenceFamily(bone.name));
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const indices = new Uint16Array(positions.count * 4);
    const weights = new Float32Array(positions.count * 4);
    const transform = rootInverse.clone().multiply(mesh.matrixWorld);
    for (let vertex = 0; vertex < positions.count; vertex++) {
      point.fromBufferAttribute(positions, vertex).applyMatrix4(transform);
      const candidates = segments.map((lines, index) => ({
        index,
        distance: Math.min(...lines.map(line => line.start.distanceToSquared(line.end) < 1e-16
          ? line.start.distanceToSquared(point)
          : line.closestPointToPoint(point, true, closest).distanceToSquared(point))),
      })).sort((a, b) => a.distance - b.distance);
      const family = families[candidates[0].index];
      const localEpsilon = /Hand/.test(bones[candidates[0].index].name) ? epsilon * .15 : epsilon;
      const scored = candidates.map(candidate => {
        const other = families[candidate.index];
        const attachment = family === 'Torso' || other === 'Torso' || (family.startsWith('LeftHand') && other === 'LeftArm') || (family.startsWith('RightHand') && other === 'RightArm') || (other.startsWith('LeftHand') && family === 'LeftArm') || (other.startsWith('RightHand') && family === 'RightArm');
        const factor = other === family ? 1 : attachment ? .2 : .002;
        return { ...candidate, score: factor / Math.pow(candidate.distance + localEpsilon * localEpsilon, 2) };
      }).sort((a, b) => b.score - a.score).slice(0, 4);
      const scores = scored.map(candidate => candidate.score);
      const total = scores.reduce((sum, score) => sum + score, 0);
      if (!(total > 0) || !Number.isFinite(total)) throw new Error('The mesh could not be bound safely. Re-export a clean neutral-pose character.');
      scored.forEach((candidate, influence) => {
        indices[vertex * 4 + influence] = candidate.index;
        weights[vertex * 4 + influence] = scores[influence] / total;
      });
    }
    smoothSkinWeights(mesh.geometry, bones, indices, weights);
    mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const skinned = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
    skinned.name = mesh.name;
    skinned.position.copy(mesh.position);
    skinned.quaternion.copy(mesh.quaternion);
    skinned.scale.copy(mesh.scale);
    skinned.matrix.copy(mesh.matrix);
    skinned.matrixAutoUpdate = mesh.matrixAutoUpdate;
    skinned.visible = mesh.visible;
    skinned.userData = { ...mesh.userData };
    if (mesh.morphTargetInfluences) skinned.morphTargetInfluences = [...mesh.morphTargetInfluences];
    if (mesh.morphTargetDictionary) skinned.morphTargetDictionary = { ...mesh.morphTargetDictionary };
    const parent = mesh.parent!;
    const index = parent.children.indexOf(mesh);
    // Preserve hierarchy and child transforms, including nested mesh groups.
    for (const child of [...mesh.children]) skinned.add(child);
    parent.remove(mesh);
    parent.add(skinned);
    parent.children.splice(parent.children.indexOf(skinned), 1);
    parent.children.splice(index, 0, skinned);
    root.updateMatrixWorld(true);
    skinned.bind(skeleton, skinned.matrixWorld);
    skinned.normalizeSkinWeights();
  }
  // All mesh bindings use the same rest-pose skeleton. Calculate inverses once
  // after the skeleton has its final parent transforms.
  skeleton.calculateInverses();
  skeleton.update();
  const height = bounds.getSize(new THREE.Vector3()).y;
  let maxBindError = 0;
  const skin = new THREE.Vector3();
  const original = new THREE.Vector3();
  const skinnedMeshes: THREE.SkinnedMesh[] = [];
  root.traverse(object => { if (object instanceof THREE.SkinnedMesh) skinnedMeshes.push(object); });
  for (const mesh of skinnedMeshes) {
    const positions = mesh.geometry.getAttribute('position');
    for (let vertex = 0; vertex < positions.count; vertex += Math.max(1, Math.floor(positions.count / 4096))) {
      original.fromBufferAttribute(positions, vertex);
      mesh.applyBoneTransform(vertex, skin.copy(original));
      const error = original.distanceTo(skin);
      if (!Number.isFinite(error)) throw new Error('The mesh produced an invalid bind pose. Its original mesh has been kept.');
      maxBindError = Math.max(maxBindError, error * mesh.getWorldScale(point).length() / Math.sqrt(3));
    }
  }
  if (maxBindError > height * 1e-4) throw new Error('The new rig would move the mesh in its rest pose. Apply its transforms and re-export before rigging.');
  const savedQuaternions = bones.map(bone => bone.quaternion.clone());
  bones.forEach(bone => {
    if (/Hand(?:Thumb|Index|Middle|Ring|Pinky)[123]$/.test(bone.name)) bone.rotateZ(.12);
    else if (/ForeArm$/.test(bone.name)) bone.rotateZ(.2);
    else if (/^(Left|Right)Leg$|LowerLeg$/.test(bone.name)) bone.rotateX(.2);
  });
  root.updateMatrixWorld(true);
  skeleton.update();
  let maxBendDisplacement = 0;
  for (const mesh of skinnedMeshes) {
    const positions = mesh.geometry.getAttribute('position');
    const localToRoot = rootInverse.clone().multiply(mesh.matrixWorld);
    for (let vertex = 0; vertex < positions.count; vertex += Math.max(1, Math.floor(positions.count / 1024))) {
      original.fromBufferAttribute(positions, vertex);
      mesh.applyBoneTransform(vertex, skin.copy(original));
      original.applyMatrix4(localToRoot); skin.applyMatrix4(localToRoot);
      const distance = original.distanceTo(skin);
      if (!Number.isFinite(distance)) throw new Error('The mesh produced invalid vertices during a bend check. Its original mesh has been kept.');
      maxBendDisplacement = Math.max(maxBendDisplacement, distance);
    }
  }
  bones.forEach((bone, index) => bone.quaternion.copy(savedQuaternions[index]));
  root.updateMatrixWorld(true);
  skeleton.update();
  if (maxBendDisplacement > height * .35) throw new Error('A small test bend stretched the character too far. Use a neutral A-pose or T-pose and apply mesh transforms before rigging.');
  fitted.diagnostics.maxBindError = maxBindError;
  fitted.diagnostics.maxBendDisplacement = maxBendDisplacement;
  root.userData.stillAutoRig = fitted.diagnostics;
  const warnings = asset.warnings.filter((warning) => !warning.startsWith('No rig found'));
  warnings.push(...fitted.diagnostics.warnings);
  warnings.push('Automatic rig passed rest-pose and small-bend checks. This is geometry fitting; inspect deformation before using extreme poses.');
  return makeAsset(root, kind, asset.name, 'import', [], warnings);
  } catch (error) {
    // All geometry/materials belong to the clone; never dispose the original
    // character when fitting or a validation check rejects the replacement.
    disposeCharacter({ ...asset, root });
    throw error;
  }
}

export async function exportCharacterGLB(asset: CharacterAsset, clip?: THREE.AnimationClip): Promise<ArrayBuffer> {
  const currentPose = capturePose(asset);
  const currentMorphs = captureMorphs(asset);
  // The asset's base transforms must represent its original rest pose, not
  // whichever animation frame happens to be under the playhead at export time.
  applyPose(asset, asset.restPose);
  applyMorphs(asset, asset.restMorphs ?? {});
  try {
  asset.root.updateMatrixWorld(true);
  updateSkeletons(asset.root);
  const exporter = new GLTFExporter();
  exporter.register(() => ({
    writeNode(object, node) {
      if (object instanceof THREE.Bone) node.extras = { ...(node.extras as Record<string, unknown> | undefined), stillJoint: true };
    },
  }));
  const exported = await exporter.parseAsync(asset.root, {
    binary: true,
    animations: clip ? [clip] : asset.clips,
    trs: true,
    onlyVisible: false,
    maxTextureSize: 4096,
  });
  if (!(exported instanceof ArrayBuffer)) throw new Error('The character could not be exported as GLB.');
  return exported;
  } finally { applyPose(asset, currentPose); applyMorphs(asset, currentMorphs); }
}

function validRestPose(value: unknown, boneCount: number): value is Pose {
  if (!Array.isArray(value) || value.length !== boneCount) return false;
  return value.every((pose) => pose && typeof pose === 'object' &&
    [['position', 3], ['quaternion', 4], ['scale', 3]].every(([key, length]) => {
      const component = (pose as Record<string, unknown>)[key];
      return Array.isArray(component) && component.length === length && component.every((number) => typeof number === 'number' && Number.isFinite(number));
    }));
}

export async function restoreCharacter(object: unknown, kind: RigKind, name: string): Promise<CharacterAsset> {
  if (!object || typeof object !== 'object' || !('object' in object)) throw new Error('The saved character data is incomplete.');
  const restored = await new THREE.ObjectLoader().parseAsync(object);
  const root = restored instanceof THREE.Group ? restored : new THREE.Group().add(restored);
  restoreMorphNames(root);
  const metadata = root.userData.stillAsset as Partial<AssetMetadata> | undefined;
  const warnings = Array.isArray(metadata?.warnings) ? metadata.warnings.filter((warning): warning is string => typeof warning === 'string') : [];
  const asset = makeAsset(root, kind, name, 'import', root.animations, warnings);
  if (validRestPose(metadata?.restPose, asset.bones.length)) asset.restPose = structuredClone(metadata.restPose);
  if (metadata?.restMorphs && Object.values(metadata.restMorphs).every(value => typeof value === 'number' && Number.isFinite(value))) asset.restMorphs = { ...metadata.restMorphs };
  saveMetadata(asset);
  return asset;
}

export function disposeCharacter(asset: CharacterAsset): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  asset.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
  skeletons.forEach((skeleton) => skeleton.dispose());
  asset.root.removeFromParent();
}
