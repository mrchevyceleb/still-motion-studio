import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyPose, capturePose } from '../engine/character';
import { solveIK } from '../engine/motion';
import { isFingerBone } from '../engine/handRig';
import type { CharacterAsset, Pose, Vec3 } from '../types';
import type { Theme } from '../theme';
import './Viewport.css';

export interface CameraSnapshot { position: Vec3; target: Vec3; fov: number; width: number; height: number; limits: { coordinates: number; fov: [number, number]; distance: [number, number] } }
export type SheetView = 'front' | 'side' | 'back' | 'perspective';
export interface SheetOptions { poses: Pose[]; labels: string[]; views: SheetView[]; cellWidth: number; columns: number; facing: Vec3; title?: string }
export interface ViewportAPI {
  capture: () => Promise<string>;
  /** Render several poses from fixed body-relative cameras into one labelled PNG. */
  captureSheet: (options: SheetOptions) => Promise<string>;
  getCamera: () => CameraSnapshot;
  setCamera: (view: { position?: Vec3; target?: Vec3; fov?: number }) => CameraSnapshot;
}

export interface GhostPose { pose: Pose; side: 'before' | 'after' }
export const GHOST_COLORS = { before: '#3984c8', after: '#d3843e' };

export interface ViewportProps {
  theme: Theme;
  asset: CharacterAsset;
  pose: Pose;
  comparisonPose?: Pose;
  selectedBone: number | null;
  onSelectBone: (index: number | null) => void;
  onPoseChange: (pose: Pose) => void;
  showRig: boolean;
  showGhosts: boolean;
  ghostPoses: GhostPose[];
  cameraView: 'perspective' | 'front' | 'side';
  tool: 'move' | 'rotate';
  playing: boolean;
  editable?: boolean;
  jointPlacement?: boolean;
  showFingerJoints?: boolean;
  jointFilter?: readonly string[];
  apiRef?: MutableRefObject<ViewportAPI | null>;
}

type Runtime = ViewportAPI & {
  setTheme: (theme: Theme) => void;
  frame: (view: ViewportProps['cameraView']) => void;
  ghosts: (poses: GhostPose[], visible: boolean) => void;
  refresh: () => void;
};

function jointTexture(selected: boolean): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.beginPath();
  context.arc(48, 48, selected ? 35 : 30, 0, Math.PI * 2);
  context.shadowBlur = selected ? 15 : 8;
  context.shadowColor = selected ? '#dc9b4770' : '#203b3020';
  context.fillStyle = selected ? '#eab466' : '#f2f6df';
  context.fill();
  context.shadowBlur = 0;
  context.lineWidth = selected ? 5 : 4;
  context.strokeStyle = selected ? '#77562e' : '#61754e';
  context.stroke();
  if (selected) {
    context.beginPath();
    context.arc(48, 48, 9, 0, Math.PI * 2);
    context.fillStyle = '#77562e';
    context.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

function clearGroup(group: THREE.Group) {
  for (const object of [...group.children]) {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    }
    group.remove(object);
  }
}

export default function Viewport(props: ViewportProps) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const runtime = useRef<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  latest.current = props;

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    setError(null);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      setError('The 3D canvas needs WebGL. Try opening this project in a browser with hardware acceleration enabled.');
      return;
    }

    const { asset } = props;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9ece5');
    scene.fog = new THREE.Fog('#e9ece5', 14, 38);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const canvas = renderer.domElement;
    canvas.className = 'motion-viewport-canvas';
    canvas.setAttribute('aria-label', 'Interactive character pose editor. Drag a joint to pose it, or drag the background to orbit.');
    canvas.setAttribute('data-testid', 'pose-canvas');
    canvas.tabIndex = 0;
    host.prepend(canvas);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.02, 120);
    const orbit = new OrbitControls(camera, canvas);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;
    orbit.minDistance = props.jointPlacement ? .06 : 1.2;
    orbit.maxDistance = 15;
    orbit.maxPolarAngle = Math.PI / 2 + 0.1;
    orbit.screenSpacePanning = true;
    orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    const hemisphere = new THREE.HemisphereLight('#ffffff', '#a5ae9b', 2.7);
    scene.add(hemisphere);
    const keyLight = new THREE.DirectionalLight('#fff5df', 3.6);
    keyLight.position.set(-3, 7, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.left = -5;
    keyLight.shadow.camera.right = 5;
    keyLight.shadow.camera.top = 5;
    keyLight.shadow.camera.bottom = -5;
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.normalBias = 0.018;
    keyLight.shadow.bias = -0.0001;
    keyLight.shadow.radius = 5;
    scene.add(keyLight);
    const rim = new THREE.DirectionalLight('#f9fff0', 1.7);
    rim.position.set(3, 4, -4);
    scene.add(rim);

    const floorGeometry = new THREE.PlaneGeometry(100, 100);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: '#e9ece4', roughness: 1, metalness: 0 });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.025;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(40, 80, '#cbd1c3', '#d4dacd');
    grid.position.y = -0.019;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.58;
    scene.add(grid);

    scene.add(asset.root);
    asset.root.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    applyPose(asset, latest.current.pose);
    asset.root.updateMatrixWorld(true);

    const boneIndices = new Map(asset.bones.map((bone, index) => [bone, index]));
    const connections = asset.bones.flatMap((bone, index) => {
      const parent = boneIndices.get(bone.parent as THREE.Bone);
      return parent === undefined ? [] : [[parent, index] as const];
    });
    const linePositions = new Float32Array(connections.length * 6);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: '#4d6947', transparent: true, opacity: 0.25, depthTest: false });
    const gridColors = grid.geometry.getAttribute('color') as THREE.BufferAttribute;
    const lightGridColors = new Float32Array(gridColors.array);
    const darkGridColor = new THREE.Color('#597663');
    function setTheme(theme: Theme) {
      const dark = theme === 'dark';
      (scene.background as THREE.Color).set(dark ? '#202c26' : '#e9ece5');
      (scene.fog as THREE.Fog).color.set(dark ? '#202c26' : '#e9ece5');
      floorMaterial.color.set(dark ? '#25362b' : '#e9ece4');
      for (let i = 0; i < gridColors.count; i++) {
        if (dark) gridColors.setXYZ(i, darkGridColor.r, darkGridColor.g, darkGridColor.b);
        else gridColors.setXYZ(i, lightGridColors[i * 3], lightGridColors[i * 3 + 1], lightGridColors[i * 3 + 2]);
      }
      gridColors.needsUpdate = true;
      hemisphere.groundColor.set(dark ? '#25362d' : '#a5ae9b');
      hemisphere.intensity = dark ? 1.8 : 2.7;
      keyLight.intensity = dark ? 3.0 : 3.6;
      rim.intensity = dark ? 1.5 : 1.7;
      lineMaterial.color.set(dark ? '#b1cc94' : '#4d6947');
      lineMaterial.opacity = dark ? 0.5 : 0.25;
    }
    setTheme(latest.current.theme);
    const rigLines = new THREE.LineSegments(lineGeometry, lineMaterial);
    rigLines.renderOrder = 10;
    rigLines.frustumCulled = false;
    scene.add(rigLines);

    const regularTexture = jointTexture(false);
    const selectedTexture = jointTexture(true);
    const regularMaterial = new THREE.SpriteMaterial({ map: regularTexture, depthTest: false, depthWrite: false, transparent: true });
    const selectedMaterial = new THREE.SpriteMaterial({ map: selectedTexture, depthTest: false, depthWrite: false, transparent: true });
    const handles = asset.bones.map((_, index) => {
      const sprite = new THREE.Sprite(regularMaterial);
      sprite.userData.boneIndex = index;
      sprite.scale.setScalar(0.078);
      sprite.renderOrder = 20;
      scene.add(sprite);
      return sprite;
    });
    // Preserve arbitrary skeleton controls, but keep common imported finger,
    // helper, and terminal bones out of the beginner's main posing surface.
    const detailedJoints = asset.bones.map(bone => /finger|thumb|hand(?:index|middle|ring|pinky|little)|pinky|toe[\s_.-]?end|end$|twist/i.test(bone.name));

    const ghosts = new THREE.Group();
    scene.add(ghosts);
    const positions = asset.bones.map(() => new THREE.Vector3());
    const temporary = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const plane = new THREE.Plane();
    const intersection = new THREE.Vector3();
    let drag: { index: number; original: Pose; offset: THREE.Vector3; startX: number; startY: number; moved: boolean; pointerId: number; tool: ViewportProps['tool'] } | null = null;

    function frame(view: ViewportProps['cameraView']) {
      asset.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(asset.root);
      const center = box.isEmpty() ? new THREE.Vector3(0, 1.2, 0) : box.getCenter(new THREE.Vector3());
      const size = box.isEmpty() ? new THREE.Vector3(1, 2.4, 1) : box.getSize(new THREE.Vector3());
      // A crouched frame must leave room for the character to stand while playing.
      const height = Math.max(size.y, asset.height, 1.7);
      if (!box.isEmpty() && asset.kind === 'humanoid') center.y = box.min.y + Math.max(size.y, asset.height) / 2;
      const halfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const distance = Math.max(height / (2 * halfFov), Math.max(size.x, size.z) / (2 * halfFov * Math.max(camera.aspect, .45))) * 1.18 + Math.max(size.x, size.z) / 2;
      orbit.target.copy(center);
      if (view === 'front') camera.position.copy(center).add(new THREE.Vector3(0, 0.08, distance));
      else if (view === 'side') camera.position.copy(center).add(new THREE.Vector3(distance, 0.08, 0));
      else camera.position.copy(center).add(new THREE.Vector3(distance * 0.64, distance * 0.26, distance * 0.92));
      camera.lookAt(center);
      orbit.update();
    }

    function updateGhosts(poses: GhostPose[], visible: boolean) {
      clearGroup(ghosts);
      ghosts.visible = visible;
      if (!visible || poses.length === 0) return;
      const original = capturePose(asset);
      for (const { pose: ghostPose, side } of poses.slice(0, 8)) {
        if (ghostPose.length !== asset.bones.length) continue;
        applyPose(asset, ghostPose);
        asset.root.updateMatrixWorld(true);
        const joints = asset.bones.map(bone => bone.getWorldPosition(new THREE.Vector3()));
        const vertices = connections.flatMap(([parent, child]) => [...joints[parent].toArray(), ...joints[child].toArray()]);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        const material = new THREE.LineBasicMaterial({ color: GHOST_COLORS[side], transparent: true, opacity: 0.55, depthWrite: false });
        const lines = new THREE.LineSegments(geometry, material);
        ghosts.add(lines);
        const pointsGeometry = new THREE.BufferGeometry().setFromPoints(joints);
        const pointsMaterial = new THREE.PointsMaterial({ color: GHOST_COLORS[side], transparent: true, opacity: 0.55, size: 0.025, depthWrite: false });
        ghosts.add(new THREE.Points(pointsGeometry, pointsMaterial));
      }
      applyPose(asset, original);
      asset.root.updateMatrixWorld(true);
    }

    function setPointer(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const paneWidth = latest.current.comparisonPose ? rect.width / 2 : rect.width;
      const offset = latest.current.comparisonPose ? paneWidth : 0;
      pointer.set(((event.clientX - rect.left - offset) / paneWidth) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return true;
    }

    function isBeforePane(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      return !!latest.current.comparisonPose && event.clientX < rect.left + rect.width / 2;
    }

    function pointerDown(event: PointerEvent) {
      if (event.button !== 0 || isBeforePane(event) || latest.current.editable === false || !latest.current.showRig || !setPointer(event)) return;
      const hit = raycaster.intersectObjects(handles.filter(handle => handle.visible), false)[0];
      if (!hit) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      const index = hit.object.userData.boneIndex as number;
      latest.current.onSelectBone(index);
      canvas.focus({ preventScroll: true });
      if (latest.current.playing) return;
      orbit.enabled = false;
      canvas.setPointerCapture(event.pointerId);
      const joint = asset.bones[index].getWorldPosition(new THREE.Vector3());
      plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), joint);
      raycaster.ray.intersectPlane(plane, intersection);
      drag = { index, original: capturePose(asset), offset: joint.clone().sub(intersection), startX: event.clientX, startY: event.clientY, moved: false, pointerId: event.pointerId, tool: latest.current.tool };
      canvas.style.cursor = 'grabbing';
    }

    function pointerMove(event: PointerEvent) {
      if (!setPointer(event)) return;
      if (!drag) {
        canvas.style.cursor = !isBeforePane(event) && latest.current.editable !== false && latest.current.showRig && raycaster.intersectObjects(handles.filter(handle => handle.visible), false).length ? 'grab' : 'default';
        return;
      }
      event.stopImmediatePropagation();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) < 2 && !drag.moved) return;
      drag.moved = true;
      applyPose(asset, drag.original);
      asset.root.updateMatrixWorld(true);
      if (drag.tool === 'move') {
        if (raycaster.ray.intersectPlane(plane, intersection)) {
          const target = intersection.add(drag.offset);
          if (latest.current.jointPlacement) {
            const bone = asset.bones[drag.index];
            const children = bone.children.filter((child): child is THREE.Bone => child instanceof THREE.Bone).map(child => ({ child, position: child.getWorldPosition(new THREE.Vector3()) }));
            bone.position.copy(bone.parent ? bone.parent.worldToLocal(target.clone()) : target);
            asset.root.updateMatrixWorld(true);
            // Placement moves one landmark; neighboring markers stay on the mesh.
            for (const { child, position } of children) child.position.copy(bone.worldToLocal(position));
            asset.root.updateMatrixWorld(true);
          } else solveIK(asset, drag.index, target);
        }
      } else {
        const bone = asset.bones[drag.index];
        const parentRotation = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
        const inverseParent = parentRotation.invert();
        const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseParent);
        const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).applyQuaternion(inverseParent);
        const rotation = new THREE.Quaternion().setFromAxisAngle(cameraUp, dx * 0.012);
        rotation.multiply(new THREE.Quaternion().setFromAxisAngle(cameraRight, dy * 0.012));
        bone.quaternion.premultiply(rotation).normalize();
      }
      asset.root.updateMatrixWorld(true);
    }

    function endDrag(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.stopImmediatePropagation();
      const completed = drag;
      drag = null;
      orbit.enabled = true;
      canvas.style.cursor = 'grab';
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (event.type === 'pointercancel') {
        applyPose(asset, completed.original);
      } else if (completed.moved) {
        latest.current.onPoseChange(capturePose(asset));
      }
    }

    canvas.addEventListener('pointerdown', pointerDown, true);
    canvas.addEventListener('pointermove', pointerMove, true);
    canvas.addEventListener('pointerup', endDrag, true);
    canvas.addEventListener('pointercancel', endDrag, true);
    let width = 0;
    let height = 0;
    let initialFrame = false;
    let coordinatesDirty = true;
    orbit.addEventListener('change', () => { coordinatesDirty = true; });
    function resize() {
      width = host!.clientWidth;
      height = host!.clientHeight;
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = (latest.current.comparisonPose ? width / 2 : width) / height;
      camera.updateProjectionMatrix();
      if (!initialFrame) {
        frame(latest.current.cameraView);
        initialFrame = true;
      }
      coordinatesDirty = true;
      runtime.current?.refresh();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    updateGhosts(latest.current.ghostPoses, latest.current.showGhosts);
    let raf = 0;
    let lastCoordinates = 0;
    let lastPose: Pose | undefined;
    let lastComparisonPose: Pose | undefined;
    let disposed = false;
    function renderPose(pose: Pose, before: boolean, paneWidth: number, offset: number, updateCoordinates: boolean) {
      applyPose(asset, pose);
      asset.root.updateMatrixWorld(true);
      const current = latest.current;
      ghosts.visible = current.showGhosts && !before;
      rigLines.visible = current.showRig;
      for (let i = 0; i < asset.bones.length; i++) {
        asset.bones[i].getWorldPosition(positions[i]);
        handles[i].position.copy(positions[i]);
        const selected = !before && current.selectedBone === i;
        handles[i].material = selected ? selectedMaterial : regularMaterial;
        // Keep joint targets comfortable to click at every zoom level.
        const distance = camera.position.distanceTo(positions[i]);
        const worldPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / height;
        handles[i].scale.setScalar(worldPixel * (selected ? 25 : 18));
        handles[i].visible = current.showRig && (!current.jointFilter || current.jointFilter.includes(asset.bones[i].name)) && (!detailedJoints[i] || selected || !!current.jointPlacement || !!current.showFingerJoints && isFingerBone(asset.bones[i].name));
        handles[i].renderOrder = selected ? 30 : 20;
      }
      connections.forEach(([parent, child], i) => {
        positions[parent].toArray(linePositions, i * 6);
        positions[child].toArray(linePositions, i * 6 + 3);
      });
      lineGeometry.attributes.position.needsUpdate = true;
      renderer.render(scene, camera);
      if (updateCoordinates) {
        const coordinates = positions.map((position, index) => {
          temporary.copy(position).project(camera);
          return { index, name: asset.bones[index].name, x: Math.round(offset + (temporary.x + 1) * paneWidth / 2), y: Math.round((1 - temporary.y) * height / 2), visible: handles[index].visible && Math.abs(temporary.x) <= 1 && Math.abs(temporary.y) <= 1 && temporary.z > -1 && temporary.z < 1 };
        });
        if (before) canvas.dataset.beforeJoints = JSON.stringify(coordinates);
        else canvas.dataset.joints = JSON.stringify(coordinates);
      }
    }
    function renderScene(now: number, forceCoordinates = false) {
      // React can commit the next character before the previous renderer's
      // passive cleanup runs. Never apply that character's pose to this rig.
      if (latest.current.asset !== asset) return;
      orbit.update();
      const current = latest.current;
      // Draw both versions with one camera and playhead, then leave the live
      // skeleton in its editable After pose for picking, scripts and exports.
      const afterPose = drag ? capturePose(asset) : current.pose;
      const split = !!current.comparisonPose;
      const paneWidth = split ? width / 2 : width;
      if (camera.aspect !== paneWidth / height) {
        camera.aspect = paneWidth / height;
        camera.updateProjectionMatrix();
      }
      const updateCoordinates = forceCoordinates || coordinatesDirty || afterPose !== lastPose || current.comparisonPose !== lastComparisonPose || now - lastCoordinates > 180;
      renderer.setScissorTest(split);
      if (current.comparisonPose) {
        renderer.setViewport(0, 0, paneWidth, height);
        renderer.setScissor(0, 0, paneWidth, height);
        renderPose(current.comparisonPose, true, paneWidth, 0, updateCoordinates);
      } else {
        delete canvas.dataset.beforeJoints;
      }
      renderer.setViewport(split ? paneWidth : 0, 0, paneWidth, height);
      renderer.setScissor(split ? paneWidth : 0, 0, paneWidth, height);
      renderPose(afterPose, false, paneWidth, split ? paneWidth : 0, updateCoordinates);
      renderer.setScissorTest(false);
      if (updateCoordinates) {
        lastCoordinates = now; lastPose = afterPose; lastComparisonPose = current.comparisonPose; coordinatesDirty = false;
      }
    }
    const getCamera = (): CameraSnapshot => {
      if (disposed) throw new Error('This viewport is no longer active.');
      return { position: camera.position.toArray() as Vec3, target: orbit.target.toArray() as Vec3, fov: camera.fov, width, height, limits: { coordinates: 10000, fov: [10, 100], distance: [orbit.minDistance, orbit.maxDistance] } };
    };
    const api: Runtime = {
      frame, ghosts: updateGhosts, getCamera, setTheme,
      refresh: () => { if (width > 0 && height > 0) renderScene(performance.now(), true); },
      capture: async () => {
        if (disposed) throw new Error('This viewport is no longer active.');
        resize();
        if (width <= 0 || height <= 0) throw new Error('The viewport needs a visible, nonzero canvas size before capture.');
        if (renderer.getContext().isContextLost()) throw new Error('The viewport graphics context is unavailable.');
        // Explicit rendering and immediate readback also work when RAF is paused in a background tab.
        if (!drag) applyPose(asset, latest.current.pose);
        renderScene(performance.now());
        return canvas.toDataURL('image/png');
      },
      captureSheet: async ({ poses, labels, views, cellWidth, columns, facing, title }) => {
        if (disposed) throw new Error('This viewport is no longer active.');
        resize();
        if (width <= 0 || height <= 0) throw new Error('The viewport needs a visible, nonzero canvas size before capture.');
        if (renderer.getContext().isContextLost()) throw new Error('The viewport graphics context is unavailable.');
        if (drag) throw new Error('Finish dragging the joint before capturing a review sheet.');
        const forward = new THREE.Vector3(facing[0], 0, facing[2]);
        if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
        forward.normalize();
        const left = new THREE.Vector3(0, 1, 0).cross(forward).normalize();
        // One framing for every pose so spacing and travel read correctly across cells.
        const bounds = new THREE.Box3();
        for (const pose of poses) {
          applyPose(asset, pose); asset.root.updateMatrixWorld(true);
          for (const bone of asset.bones) bounds.expandByPoint(bone.getWorldPosition(temporary));
        }
        bounds.expandByScalar(Math.max(.05, asset.height * .12));
        bounds.min.y = Math.min(bounds.min.y, 0);
        const center = bounds.getCenter(new THREE.Vector3());
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(i => new THREE.Vector3(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z));
        const aspect = asset.kind === 'humanoid' ? .8 : 1.25;
        const cellCssW = Math.max(1, Math.floor(Math.min(width, height * aspect))), cellCssH = Math.max(1, Math.floor(cellCssW / aspect));
        const ratio = renderer.getPixelRatio();
        const outW = cellWidth, outH = Math.round(cellWidth / aspect), labelH = 20, viewH = 22, titleH = title ? 30 : 0;
        const cols = Math.min(columns, poses.length), rowsPerView = Math.ceil(poses.length / cols);
        const sheet = document.createElement('canvas');
        sheet.width = cols * outW;
        sheet.height = titleH + views.length * (viewH + rowsPerView * (outH + labelH));
        const context = sheet.getContext('2d');
        if (!context) throw new Error('The review sheet canvas is unavailable.');
        context.fillStyle = '#121519'; context.fillRect(0, 0, sheet.width, sheet.height);
        context.textBaseline = 'middle';
        if (title) { context.fillStyle = '#f2f6df'; context.font = '600 15px system-ui, sans-serif'; context.fillText(title, 10, titleH / 2); }
        const saved = { position: camera.position.clone(), target: orbit.target.clone(), aspect: camera.aspect, damping: orbit.enableDamping };
        orbit.enableDamping = false;
        try {
          let y = titleH;
          for (const view of views) {
            context.fillStyle = '#9fb08f'; context.font = '600 13px system-ui, sans-serif';
            context.fillText(`${view.toUpperCase()} VIEW`, 10, y + viewH / 2);
            y += viewH;
            const dir = view === 'front' ? forward.clone() : view === 'back' ? forward.clone().negate() : view === 'side' ? left.clone() : forward.clone().multiplyScalar(.92).addScaledVector(left, .64).add(new THREE.Vector3(0, .3, 0)).normalize();
            const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize(), up = dir.clone().cross(right).normalize();
            let halfW = 0, halfH = 0, near = 0;
            for (const corner of corners) {
              const offset = corner.clone().sub(center);
              halfW = Math.max(halfW, Math.abs(offset.dot(right))); halfH = Math.max(halfH, Math.abs(offset.dot(up))); near = Math.max(near, offset.dot(dir));
            }
            const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
            const distance = Math.max(halfH / tan, halfW / (tan * aspect)) * 1.04 + near;
            camera.aspect = aspect; camera.updateProjectionMatrix();
            camera.position.copy(center).addScaledVector(dir, distance); orbit.target.copy(center); camera.lookAt(center);
            renderer.setScissorTest(true);
            renderer.setViewport(0, 0, cellCssW, cellCssH); renderer.setScissor(0, 0, cellCssW, cellCssH);
            poses.forEach((pose, i) => {
              const x = (i % cols) * outW, top = y + Math.floor(i / cols) * (outH + labelH);
              renderPose(pose, true, cellCssW, 0, false);
              context.drawImage(canvas, 0, canvas.height - cellCssH * ratio, cellCssW * ratio, cellCssH * ratio, x, top, outW, outH);
              context.strokeStyle = '#2c333b'; context.strokeRect(x + .5, top + .5, outW - 1, outH + labelH - 1);
              context.fillStyle = '#1b2026'; context.fillRect(x, top + outH, outW, labelH);
              context.fillStyle = labels[i]?.includes('◆') ? '#eab466' : '#d6dccb'; context.font = '12px system-ui, sans-serif';
              context.fillText((labels[i] ?? '').slice(0, Math.floor(outW / 6.5)), x + 6, top + outH + labelH / 2);
            });
            y += rowsPerView * (outH + labelH);
          }
        } finally {
          renderer.setScissorTest(false);
          camera.position.copy(saved.position); orbit.target.copy(saved.target);
          camera.aspect = saved.aspect; camera.updateProjectionMatrix(); camera.lookAt(saved.target);
          orbit.update(); orbit.enableDamping = saved.damping;
          applyPose(asset, latest.current.pose);
          renderScene(performance.now(), true);
        }
        return sheet.toDataURL('image/png');
      },
      setCamera: view => {
        if (disposed) throw new Error('This viewport is no longer active.');
        if (!view || typeof view !== 'object') throw new Error('Provide camera position, target, or field of view.');
        const validVector = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000);
        if (view.position !== undefined && !validVector(view.position)) throw new Error('Camera position must contain three finite world coordinates.');
        if (view.target !== undefined && !validVector(view.target)) throw new Error('Camera target must contain three finite world coordinates.');
        if (view.fov !== undefined && (!Number.isFinite(view.fov) || view.fov < 10 || view.fov > 100)) throw new Error('Camera field of view must be between 10 and 100 degrees.');
        const position = view.position ? new THREE.Vector3().fromArray(view.position) : camera.position.clone();
        const target = view.target ? new THREE.Vector3().fromArray(view.target) : orbit.target.clone();
        const distance = position.distanceTo(target);
        if (distance < orbit.minDistance || distance > orbit.maxDistance) throw new Error(`Camera distance must be between ${orbit.minDistance} and ${orbit.maxDistance} world units.`);
        // Clear pending orbit damping before assigning an exact scripted camera view.
        const damping = orbit.enableDamping;
        orbit.enableDamping = false; orbit.update();
        camera.position.copy(position); orbit.target.copy(target);
        if (view.fov !== undefined) { camera.fov = view.fov; camera.updateProjectionMatrix(); }
        camera.lookAt(target); orbit.update(); orbit.enableDamping = damping;
        if (width > 0 && height > 0) renderScene(performance.now(), true);
        return getCamera();
      },
    };
    runtime.current = api;
    if (props.apiRef) props.apiRef.current = api;
    function render(now: number) {
      raf = requestAnimationFrame(render);
      if (width <= 0 || height <= 0 || document.hidden) return;
      renderScene(now);
    }
    raf = requestAnimationFrame(render);

    return () => {
      disposed = true;
      if (props.apiRef?.current === api) props.apiRef.current = null;
      runtime.current = null;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('pointermove', pointerMove, true);
      canvas.removeEventListener('pointerup', endDrag, true);
      canvas.removeEventListener('pointercancel', endDrag, true);
      orbit.dispose();
      scene.remove(asset.root);
      floorGeometry.dispose();
      floorMaterial.dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      regularTexture.dispose();
      selectedTexture.dispose();
      regularMaterial.dispose();
      selectedMaterial.dispose();
      clearGroup(ghosts);
      keyLight.shadow.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [props.asset]);

  useEffect(() => {
    const ref = props.apiRef;
    const api = runtime.current;
    if (ref) ref.current = api;
    return () => { if (ref?.current === api) ref.current = null; };
  }, [props.apiRef, props.asset]);

  useLayoutEffect(() => {
    applyPose(props.asset, props.pose);
    props.asset.root.updateMatrixWorld(true);
    runtime.current?.refresh();
  }, [props.asset, props.pose, props.comparisonPose]);

  useEffect(() => { runtime.current?.frame(props.cameraView); }, [props.cameraView]);
  useEffect(() => { runtime.current?.setTheme(props.theme); }, [props.theme, props.asset]);
  useEffect(() => { runtime.current?.ghosts(props.ghostPoses, props.showGhosts); }, [props.asset, props.ghostPoses, props.showGhosts]);
  useEffect(() => {
    const canvas = container.current?.querySelector('canvas');
    canvas?.setAttribute('aria-label', props.comparisonPose
      ? 'Side-by-side physics comparison. Before on the left, After on the right. Drag either background to orbit both views. Edit joints on the right.'
      : props.editable === false ? 'Before physics preview. Drag the background to orbit.'
      : 'Interactive character pose editor. Drag a joint to pose it, or drag the background to orbit.');
  }, [!!props.comparisonPose, props.editable, props.asset]);

  return <div ref={container} className="motion-viewport" data-testid="viewport">
    {props.comparisonPose && <div className="viewport-split-labels" aria-label="Side-by-side physics comparison"><span><span className="viewport-split-label"><strong>Before</strong>Original motion</span></span><span><span className="viewport-split-label"><strong>After</strong>Physics correction</span></span></div>}
    {error && <div className="motion-viewport-error"><strong>Unable to open the 3D view</strong><p>{error}</p></div>}
  </div>;
}
