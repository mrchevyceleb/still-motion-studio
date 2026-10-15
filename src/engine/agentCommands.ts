import { applyPose, autoRigCharacter, createDemoCharacter, disposeCharacter, exportCharacterGLB, importCharacter, swapCharacterLook } from './character';
import { morphKeyData } from './morphs';
import { applyPhysics, buildAnimationClip, createDemoKeys, sampleClip, samplePose, simplifyKeys } from './motion';
import { generateMotion, getEngineStatus, makeMotionRequest, restoreEngineFrames } from './assistance';
import { exportUnrealPackage } from './unrealExport';
import { downloadAgentFile, uploadAgentFile } from './agentBridge';
import { editLocalPose, inspectSkeleton, moveJoint, resolveBone, validateAgentPose } from './agentPose';
import { listArchives, readArchive } from './project';
import { DEFAULT_SETTINGS } from '../types';
import type { CharacterAsset, InterpolationMode, MotionGeneration, MotionSettings, Pose, PoseKey, ProjectDocument, RigKind } from '../types';

export interface AgentStudio {
  title: string; keys: PoseKey[]; generated?: PoseKey[]; generation?: MotionGeneration;
  duration: number; settings: MotionSettings; sourceClip?: number | null; rigKind?: RigKind;
}
export interface AgentView {
  cameraView: 'perspective' | 'front' | 'side'; showRig: boolean; showGhosts: boolean;
  tool: 'move' | 'rotate'; selectedBone: number | null;
}
export interface AgentEditor {
  asset: CharacterAsset; studio: AgentStudio; time: number; fps: number; pose: Pose;
  snapshot(): Record<string, unknown>;
  document(): ProjectDocument;
  archive(): Promise<void>;
  save(): Promise<void>;
  restore(document: unknown, signal: AbortSignal): Promise<void>;
  replace(asset: CharacterAsset, studio: AgentStudio, time?: number): void;
  commit(studio: AgentStudio): void;
  timeline(time: number, fps?: number): void;
  play(playing: boolean): void;
  view(patch: Partial<AgentView>): void;
  viewport: { capture(): Promise<string>; getCamera(): unknown; setCamera(patch: { position?: [number, number, number]; target?: [number, number, number]; fov?: number }): unknown } | null;
  undo(): void; redo(): void;
  progress(message: string, progress: number): void;
}

export const READ_COMMANDS = new Set(['scene.inspect', 'scene.project', 'scene.archives', 'skeleton.inspect', 'pose.get', 'keys.list', 'clips.list']);
const copy = <T,>(value: T): T => structuredClone(value);
const generationReport = (generation: MotionGeneration | undefined) => {
  if (!generation) return null;
  const { comparison: _comparison, ...report } = generation;
  return report;
};
const uid = () => crypto.randomUUID();
const number = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
};
const kindOf = (value: unknown): RigKind => {
  if (value !== 'humanoid' && value !== 'quadruped' && value !== 'creature') throw new Error('Choose humanoid, quadruped or creature.');
  return value;
};
const nameOf = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Use a nonempty name up to 200 characters.');
  return value.trim();
};

/** Called only through the serialized browser bridge; the editor owns rendering/history. */
export async function executeAgentCommand(editor: AgentEditor, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const { asset, studio } = editor;
  const sequence = studio.generated ?? studio.keys;
  const mode: InterpolationMode = studio.generated ? 'linear' : studio.settings.interpolation;
  const atTime = () => number(params.time ?? editor.time, 'Time', 0, studio.duration);
  const poseAt = (time: number) => samplePose(sequence, time, mode);
  const requireRig = () => { if (!asset.rigged || !asset.bones.length) throw new Error('Add a rig before editing poses or exporting animation.'); };
  const fullPose = (value: unknown): Pose => {
    if (!Array.isArray(value) || value.length !== asset.bones.length) throw new Error(`Pose must contain exactly ${asset.bones.length} bone transforms, in skeleton index order.`);
    return validateAgentPose(asset, value);
  };
  const commit = (next: AgentStudio) => { signal.throwIfAborted(); editor.commit(next); };
  const put = (time: number, pose: Pose, label?: string) => {
    const old = studio.keys.find(key => Math.abs(key.time - time) < 1e-7);
    const key = { id: old?.id ?? uid(), time: old?.time ?? time, pose, label: label ?? old?.label ?? 'Agent pose', ...morphKeyData(sequence, time, mode, asset.restMorphs) };
    commit({ ...studio, sourceClip: null, keys: [...studio.keys.filter(item => item.id !== old?.id), key].sort((a, b) => a.time - b.time) });
    editor.timeline(key.time);
    return { key: copy(key) };
  };
  const artifact = async (blob: Blob, name: string) => ({ ...await uploadAgentFile(blob, name, signal) });

  switch (method) {
    case 'scene.inspect': return { ...editor.snapshot(), keys: studio.keys.map(({ id, time, label }) => ({ id, time, label })), warnings: asset.warnings, hasReferenceFbx: !!asset.referenceFbx?.byteLength, generation: generationReport(studio.generation) };
    case 'scene.project': return { document: editor.document() };
    case 'scene.archives': return { archives: await listArchives() };
    case 'scene.save': {
      const document = editor.document();
      await editor.save(); signal.throwIfAborted();
      return artifact(new Blob([JSON.stringify(document)], { type: 'application/json' }), `${studio.title || 'Untitled'}.still`);
    }
    case 'scene.rename': commit({ ...studio, title: nameOf(params.name, studio.title) }); return editor.snapshot();
    case 'scene.restore':
    case 'scene.restoreArchive': {
      const document = method === 'scene.restoreArchive' ? await readArchive(String(params.id)) : params.document;
      await editor.archive(); signal.throwIfAborted();
      await editor.restore(document, signal);
      return editor.snapshot();
    }
    case 'scene.new': {
      const kind = kindOf(params.kind), title = nameOf(params.name, params.blank ? 'My next move' : kind === 'humanoid' ? 'A little hello' : 'Four little steps');
      await editor.archive(); signal.throwIfAborted();
      const next = createDemoCharacter(kind);
      const keys = params.blank ? [{ id: uid(), time: 0, pose: copy(next.restPose) }, { id: uid(), time: 4, pose: copy(next.restPose) }] : createDemoKeys(next);
      editor.replace(next, { title, keys, duration: 4, settings: { ...DEFAULT_SETTINGS } }, params.blank ? 0 : .8);
      return editor.snapshot();
    }
    case 'scene.import': {
      const file = await downloadAgentFile(String(params.fileId), signal);
      if (/\.(still|json)$/i.test(file.name)) {
        const document = JSON.parse(await file.text());
        await editor.archive(); signal.throwIfAborted();
        await editor.restore(document, signal);
        return editor.snapshot();
      }
      const next = await importCharacter(file);
      let adopted = false;
      try {
        signal.throwIfAborted();
        let keys: PoseKey[], duration = 4, sourceClip: number | null = null;
        if (next.clips.length) {
          try { keys = sampleClip(next, next.clips[0]); duration = Math.max(next.clips[0].duration, 1 / editor.fps); sourceClip = 0; }
          catch (error) { next.warnings.push(`Animation was not imported: ${error instanceof Error ? error.message : String(error)}`); keys = [{ id: uid(), time: 0, pose: copy(next.restPose) }, { id: uid(), time: duration, pose: copy(next.restPose) }]; }
        } else keys = [{ id: uid(), time: 0, pose: copy(next.restPose) }, { id: uid(), time: duration, pose: copy(next.restPose) }];
        if (duration > 600) throw new Error('Use an animation up to ten minutes long.');
        await editor.archive(); signal.throwIfAborted();
        editor.replace(next, { title: file.name.replace(/\.[^.]+$/, ''), keys, duration, sourceClip, settings: { ...DEFAULT_SETTINGS, interpolation: sourceClip === null ? 'smooth' : 'linear' } });
        adopted = true;
        return { ...editor.snapshot(), warnings: next.warnings };
      } finally { if (!adopted) disposeCharacter(next); }
    }
    case 'character.swapLook': {
      requireRig();
      const file = await downloadAgentFile(String(params.fileId), signal);
      const source = await importCharacter(file);
      let next: CharacterAsset | undefined, adopted = false;
      try {
        signal.throwIfAborted();
        next = swapCharacterLook(asset, source);
        // The dressed take is a new scene; the original stays in the library untouched.
        await editor.archive(); signal.throwIfAborted();
        editor.replace(next, { ...studio, title: nameOf(params.name, studio.title) }, editor.time);
        adopted = true;
        return { ...editor.snapshot(), warnings: next.warnings };
      } finally { disposeCharacter(source); if (next && !adopted) disposeCharacter(next); }
    }
    case 'skeleton.inspect': return { ...inspectSkeleton(asset, poseAt(editor.time)) };
    case 'skeleton.kind': commit({ ...studio, rigKind: kindOf(params.kind), generated: undefined, generation: undefined }); return editor.snapshot();
    case 'skeleton.rig': {
      if (asset.rigged || asset.bones.length) throw new Error('This character already has a rig. Use skeleton.kind to change its motion category without replacing its bones.');
      const kind = kindOf(params.kind);
      await editor.archive(); signal.throwIfAborted();
      const next = autoRigCharacter(asset, kind);
      editor.replace(next, { ...studio, keys: [{ id: uid(), time: 0, pose: copy(next.restPose) }, { id: uid(), time: studio.duration, pose: copy(next.restPose) }], generated: undefined, generation: undefined, sourceClip: null });
      return { ...editor.snapshot(), warning: 'Template rig fitted; unusual anatomy may need manual cleanup.' };
    }
    case 'pose.get': { const time = atTime(); return { time, pose: poseAt(time) }; }
    case 'pose.reset': requireRig(); return put(atTime(), copy(asset.restPose));
    case 'pose.set':
    case 'keys.put': {
      requireRig(); const time = atTime();
      const pose = params.pose !== undefined ? fullPose(params.pose) : params.bones !== undefined ? editLocalPose(asset, poseAt(time), params.bones as Parameters<typeof editLocalPose>[2]) : poseAt(time);
      return put(time, pose, params.label as string | undefined);
    }
    case 'pose.move': {
      requireRig(); const time = atTime();
      const result = moveJoint(asset, poseAt(time), params.bone as number | string, params.target as [number, number, number]);
      return { ...put(time, result.pose), boneIndex: result.boneIndex, target: result.target, achieved: result.achieved, error: result.error };
    }
    case 'keys.list': return { keys: params.includePoses ? copy(studio.keys) : studio.keys.map(({ id, time, label }) => ({ id, time, label })) };
    case 'keys.replace': {
      requireRig();
      if (!Array.isArray(params.keys) || params.keys.length < 2 || params.keys.length > 72001) throw new Error('Provide between 2 and 72001 complete pose keys.');
      const times = new Set<number>();
      const keys = params.keys.map(key => {
        const time = number(key.time, 'Key time', 0, studio.duration);
        if (times.has(time)) throw new Error('Two keys cannot share the same time.');
        times.add(time);
        return { id: uid(), time, pose: fullPose(key.pose), label: key.label as string | undefined };
      }).sort((a, b) => a.time - b.time);
      commit({ ...studio, keys, sourceClip: null });
      return { keys: keys.map(({ id, time, label }) => ({ id, time, label })) };
    }
    case 'keys.delete': {
      if (studio.keys.length <= 2) throw new Error('Keep at least two pose keys.');
      if (!studio.keys.some(key => key.id === params.id)) throw new Error('That pose key does not exist.');
      commit({ ...studio, sourceClip: null, keys: studio.keys.filter(key => key.id !== params.id) }); return editor.snapshot();
    }
    case 'keys.move': {
      const time = atTime();
      if (!studio.keys.some(key => key.id === params.id)) throw new Error('That pose key does not exist.');
      if (studio.keys.some(key => key.id !== params.id && Math.abs(key.time - time) < 1e-7)) throw new Error('There is already a pose at that time.');
      commit({ ...studio, sourceClip: null, keys: studio.keys.map(key => key.id === params.id ? { ...key, time } : key).sort((a, b) => a.time - b.time) });
      editor.timeline(time); return editor.snapshot();
    }
    case 'keys.simplify': {
      const count = number(params.count ?? 6, 'Pose count', 2, 120);
      if (!Number.isInteger(count)) throw new Error('Pose count must be an integer.');
      commit({ ...studio, keys: simplifyKeys(studio.keys, count, asset.restMorphs), sourceClip: null, settings: { ...studio.settings, interpolation: 'smooth' } });
      return editor.snapshot();
    }
    case 'clips.list': return { clips: asset.clips.map((clip, index) => ({ index, name: clip.name, duration: clip.duration })), selected: studio.sourceClip ?? null };
    case 'clips.select': {
      const index = number(params.index, 'Clip index', 0, asset.clips.length - 1);
      if (!Number.isInteger(index)) throw new Error('Clip index must be an integer.');
      const clip = asset.clips[index], keys = sampleClip(asset, clip);
      commit({ ...studio, keys, duration: Math.max(clip.duration, 1 / editor.fps), sourceClip: index, settings: { ...studio.settings, interpolation: 'linear' } });
      editor.timeline(0); return editor.snapshot();
    }
    case 'timeline.set': {
      const duration = number(params.duration ?? studio.duration, 'Duration', .1, 600);
      const fps = number(params.fps ?? editor.fps, 'Frame rate', 1, 120);
      if (!Number.isInteger(fps)) throw new Error('Frame rate must be an integer.');
      const retime = params.retime !== false;
      const time = number(params.time ?? Math.min(duration, editor.time * (retime ? duration / studio.duration : 1)), 'Time', 0, duration);
      if (duration !== studio.duration) {
        if (!retime && studio.keys.some(key => key.time > duration)) throw new Error('Some keys exceed the new duration. Move/delete them first or use retime:true.');
        const keys = studio.keys.map(key => ({ ...key, time: retime ? key.time * duration / studio.duration : key.time }));
        commit({ ...studio, duration, keys, sourceClip: null });
      }
      editor.timeline(time, fps); return editor.snapshot();
    }
    case 'playback.set': editor.play(params.playing === true); return editor.snapshot();
    case 'settings.set': {
      const patch = params as Partial<MotionSettings>;
      commit({ ...studio, ...(patch.interpolation ? { generated: undefined, generation: undefined } : {}), settings: { ...studio.settings, ...patch } });
      return editor.snapshot();
    }
    case 'view.set': {
      if (params.camera && params.cameraView) throw new Error('Choose a camera preset or a custom camera, not both.');
      const { camera, selectedBone, ...patch } = params;
      const index = selectedBone === undefined ? undefined : selectedBone === null ? null : resolveBone(asset, selectedBone as number | string);
      // Validate and set the imperative camera before changing React state.
      const cameraResult = camera ? editor.viewport?.setCamera(camera as Parameters<NonNullable<AgentEditor['viewport']>['setCamera']>[0]) : undefined;
      if (camera && !editor.viewport) throw new Error('The viewport is not ready.');
      editor.view({ ...patch, ...(index !== undefined ? { selectedBone: index } : {}) } as Partial<AgentView>);
      return { ...editor.snapshot(), camera: cameraResult ?? editor.viewport?.getCamera() ?? null };
    }
    case 'history.undo': editor.undo(); return editor.snapshot();
    case 'history.redo': editor.redo(); return editor.snapshot();
    case 'motion.clear': commit({ ...studio, generated: undefined, generation: undefined }); return editor.snapshot();
    case 'motion.quickGround': {
      requireRig();
      try { commit({ ...studio, keys: applyPhysics(asset, studio.keys, studio.settings), sourceClip: null }); }
      finally { applyPose(asset, editor.pose); }
      return editor.snapshot();
    }
    case 'motion.run': {
      requireRig();
      const engine = await getEngineStatus(); signal.throwIfAborted();
      const provider = engine?.providers.find(provider => provider.id === params.provider);
      if (!provider) throw new Error('That motion provider is not installed or is currently unavailable.');
      if (provider.limits?.humanoidOnly && asset.kind !== 'humanoid' || provider.limits?.quadrupedOnly && asset.kind !== 'quadruped') throw new Error('This provider does not support the current rig category.');
      if (provider.limits?.maxDuration && studio.duration > provider.limits.maxDuration) throw new Error(`This provider supports up to ${provider.limits.maxDuration} seconds.`);
      const count = params.simplifyCount ?? (studio.keys.length > 24 ? 6 : undefined);
      const anchors = count === undefined ? studio.keys : simplifyKeys(studio.keys, number(count, 'Pose count', 2, 120), asset.restMorphs);
      const settings = { ...studio.settings, interpolation: mode, ...(provider.limits?.earthGravityOnly ? { gravity: 9.81 } : {}), ...(provider.limits?.requiresFloorContact ? { floorContact: true } : {}) };
      const request = makeMotionRequest(asset, sequence, anchors, studio.duration, settings, provider.id, number(params.seed ?? 42, 'Seed', 0, 2147483647));
      try {
        const result = await generateMotion(request, editor.progress, signal); signal.throwIfAborted();
        const generated = restoreEngineFrames(asset, sequence, anchors, result, mode, studio.duration, provider.learned);
        const keys = provider.learned ? anchors : studio.keys.map(key => ({ ...key, pose: samplePose(generated, key.time, 'linear') }));
        const generation: MotionGeneration = { name: result.provider?.name ?? provider.name, kind: request.kind, metrics: { ...result.metrics, requestedSettings: settings }, warnings: result.warnings ?? [], ...(!provider.learned ? { comparison: { before: copy(sequence), interpolation: mode } } : {}) };
        commit({ ...studio, keys, generated, generation, sourceClip: null });
        return { ...editor.snapshot(), generation: generationReport(generation), generatedFrames: generated.length };
      } finally { applyPose(asset, editor.pose); }
    }
    case 'export': {
      const format = params.format;
      const name = nameOf(params.name, studio.title || 'Animation').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      if (format === 'still') return artifact(new Blob([JSON.stringify(editor.document())], { type: 'application/json' }), `${name}.still`);
      if (format === 'png') {
        if (!editor.viewport) throw new Error('The viewport is not ready.');
        const data = await editor.viewport.capture();
        return artifact(await (await fetch(data)).blob(), `${name}.png`);
      }
      requireRig();
      if (format !== 'glb' && format !== 'unreal') throw new Error('Export format must be glb, still, unreal, or png.');
      const fps = params.fps ?? editor.fps;
      if (format === 'unreal' && ![24, 30, 60].includes(fps as number)) throw new Error('Unreal export needs 24, 30, or 60 fps. Set fps explicitly for this export.');
      if (format === 'unreal' && params.retarget === 'skeleton' && !asset.referenceFbx?.byteLength) throw new Error('Import the original character FBX with scene.import or still_import_file before exporting onto an existing Unreal Skeleton. Saved Still projects do not retain that FBX.');
      try {
        const clip = buildAnimationClip(asset, sequence, studio.duration, { ...studio.settings, interpolation: mode });
        const binary = await exportCharacterGLB(asset, clip); signal.throwIfAborted();
        if (format === 'glb') return { ...await artifact(new Blob([binary], { type: 'model/gltf-binary' }), `${name}.glb`), warnings: asset.warnings, generation: studio.generation ?? null };
        const result = await exportUnrealPackage(binary, { name, fps: fps as number, rootMotion: params.rootMotion as 'preserve' | 'extract' | 'in-place' | undefined, retarget: params.retarget as 'none' | 'manny' | 'metahuman' | 'skeleton' | undefined, targetMesh: params.targetMesh as string | undefined, targetSkeleton: params.targetSkeleton as string | undefined, ...(params.retarget === 'skeleton' ? { referenceFbx: asset.referenceFbx } : {}) }, editor.progress, signal);
        if (!result.package) throw new Error('The Unreal package could not be downloaded.');
        return { ...await artifact(result.package, `${name}-Unreal.zip`), warnings: result.warnings, generation: studio.generation ?? null };
      } finally { applyPose(asset, editor.pose); }
    }
    default: throw new Error(`Unknown scripting command: ${method}`);
  }
}
