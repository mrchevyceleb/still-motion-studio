import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { CharacterAsset, Pose, RigKind, Vec3 } from '../types';

const DISPLAY_HEIGHT = 2.4;
const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const UP = new THREE.Vector3(0, 1, 0);

type JointSpec = { name: string; parent?: string; position: Vec3 };
type AssetMetadata = { version: number; restPose: Pose; warnings: string[]; height: number };

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
  saveMetadata(asset);
  return asset;
}

function saveMetadata(asset: CharacterAsset): void {
  asset.root.userData.stillAsset = {
    version: 1,
    restPose: structuredClone(asset.restPose),
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

function fittedJoints(kind: RigKind, bounds: THREE.Box3): JointSpec[] {
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const specifications = kind === 'humanoid' ? humanoidJoints() : quadrupedJoints();
  return specifications.map((spec) => {
    let [x, y, z] = spec.position;
    if (kind === 'humanoid') {
      // The starter rig assumes an upright, centered T-pose. It is deliberately
      // conservative; arbitrary meshes need landmark fitting for production use.
      if (/Shoulder$/.test(spec.name)) { x = Math.sign(x) * 0.26; y = 1.84; }
      if (/^(Left|Right)Arm$/.test(spec.name)) { x = Math.sign(x) * 0.39; y = 1.84; }
      if (/ForeArm$/.test(spec.name)) { x = Math.sign(x) * 0.70; y = 1.84; }
      if (/Hand$/.test(spec.name)) { x = Math.sign(x) * 1.02; y = 1.84; }
      const widthScale = size.x / 2.22;
      x *= widthScale;
      z *= Math.min(size.y / 2.4, size.z / 0.45);
      y = y / 2.4 * size.y;
    } else {
      x = x / 0.80 * size.x;
      y = y / 2.48 * size.y;
      z = z / 2.75 * size.z;
    }
    return { ...spec, position: [center.x + x, bounds.min.y + y, center.z + z] };
  });
}

export function autoRigCharacter(asset: CharacterAsset, kind: RigKind): CharacterAsset {
  if (asset.bones.length) {
    // Replacing an imported skeleton is exactly what makes common Mixamo flows
    // fragile. Existing bindings are authoritative, even for unusual bone names.
    asset.kind = kind;
    return asset;
  }
  const root = cloneSkeleton(asset.root) as THREE.Group;
  cloneMaterials(root);
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry.getAttribute('position');
    if (!position) return;
    meshes.push(object);
    const transform = rootInverse.clone().multiply(object.matrixWorld);
    for (let index = 0; index < position.count; index++) bounds.expandByPoint(point.fromBufferAttribute(position, index).applyMatrix4(transform));
  });
  if (meshes.length === 0 || bounds.isEmpty()) throw new Error('A mesh is needed to create a starter rig.');
  createSkeleton(root, fittedJoints(kind, bounds));
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
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    const indices = new Uint16Array(positions.count * 4);
    const weights = new Float32Array(positions.count * 4);
    const transform = rootInverse.clone().multiply(mesh.matrixWorld);
    for (let vertex = 0; vertex < positions.count; vertex++) {
      point.fromBufferAttribute(positions, vertex).applyMatrix4(transform);
      const candidates = segments.map((lines, index) => ({
        index,
        distance: Math.min(...lines.map((line) => line.closestPointToPoint(point, true, closest).distanceToSquared(point))),
      })).sort((a, b) => a.distance - b.distance).slice(0, 4);
      const scores = candidates.map((candidate) => 1 / Math.pow(candidate.distance + epsilon * epsilon, 2));
      const total = scores.reduce((sum, score) => sum + score, 0);
      candidates.forEach((candidate, influence) => {
        indices[vertex * 4 + influence] = candidate.index;
        weights[vertex * 4 + influence] = scores[influence] / total;
      });
    }
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
  const warnings = asset.warnings.filter((warning) => !warning.startsWith('No rig found'));
  warnings.push(kind === 'humanoid'
    ? 'Starter rig: automatic distance-based weights for upright T-pose models. Joint placement and bends may need refinement; this is not a trained auto-rigging model.'
    : 'Starter rig: automatic distance-based weights for standing quadrupeds facing +Z. Proportions and bends may need refinement; this is not a trained auto-rigging model.');
  return makeAsset(root, kind, asset.name, 'import', [], warnings);
}

export async function exportCharacterGLB(asset: CharacterAsset, clip?: THREE.AnimationClip): Promise<ArrayBuffer> {
  const currentPose = capturePose(asset);
  // The asset's base transforms must represent its original rest pose, not
  // whichever animation frame happens to be under the playhead at export time.
  applyPose(asset, asset.restPose);
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
  } finally { applyPose(asset, currentPose); }
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
  const metadata = root.userData.stillAsset as Partial<AssetMetadata> | undefined;
  const warnings = Array.isArray(metadata?.warnings) ? metadata.warnings.filter((warning): warning is string => typeof warning === 'string') : [];
  const asset = makeAsset(root, kind, name, 'import', root.animations, warnings);
  if (validRestPose(metadata?.restPose, asset.bones.length)) asset.restPose = structuredClone(metadata.restPose);
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
