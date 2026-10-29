import { useEffect, useRef, useState } from 'react';
import { Activity, Check, Upload } from 'lucide-react';
import { disposeCharacter, importCharacter } from '../engine/character';
import { importAnimationOnRig } from '../engine/animationImport';
import { retargetAnimation, suggestBoneMapping } from '../engine/retarget';
import { libraryAlignment, mappingReady, suggestLibraryMapping } from '../engine/libraryRetarget';
import { readMotionMapping } from '../engine/motionLibrary';
import AnimationSources from './AnimationSources';
import type { CharacterAsset, PoseKey } from '../types';
import './AnimationImport.css';

export default function AnimationImport({ target, duration, fps, initialMode, initialFile, initialClipIndex = 0, initialFitError, onMappingSaved, onBusy, onApply }: {
  target: CharacterAsset; duration: number; fps: number; initialMode: 'apply' | 'append';
  initialFile?: File | null;
  initialClipIndex?: number;
  initialFitError?: string | null;
  onMappingSaved?: (source: CharacterAsset, mapping: number[]) => void;
  onBusy: (busy: boolean) => void;
  onApply: (keys: PoseKey[], duration: number, mode: 'apply' | 'append', blend: number, name: string) => void;
}) {
  const [source, setSource] = useState<CharacterAsset | null>(null);
  const [filename, setFilename] = useState('');
  const [clipIndex, setClipIndex] = useState(0);
  const [mode, setMode] = useState(initialMode);
  const [blend, setBlend] = useState('0.15');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<'matching' | 'retarget'>('matching');
  const [mapping, setMapping] = useState<number[]>([]);
  const [mappingExpanded, setMappingExpanded] = useState(false);
  const [librarySource, setLibrarySource] = useState(false);
  const [rootMotion, setRootMotion] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const busyRef = useRef(false);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => () => { ++request.current; if (busyRef.current) onBusyRef.current(false); }, []);
  useEffect(() => () => { if (source) disposeCharacter(source); }, [source]);
  const clip = source?.clips[clipIndex];
  const skippedMorphs = Object.keys(source?.restMorphs ?? {}).filter(name => !(name in (target.restMorphs ?? {})));
  const validBlend = mode === 'apply' || blend.trim() !== '' && Number.isFinite(Number(blend)) && Number(blend) >= 0 && Number(blend) <= Math.min(duration, clip?.duration ?? 0) / 2;

  async function load(file: File) {
    const ticket = ++request.current;
    setError(null); setLoading(true); busyRef.current = true; onBusy(true);
    let next: CharacterAsset | undefined;
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error('Choose an animation file smaller than 150 MB.');
      next = await importCharacter(file);
      if (ticket !== request.current) { disposeCharacter(next); return; }
      if (!next.clips.length) throw new Error('This file contains no animation. Export the animation clips along with the skeleton.');
      const saved = file === initialFile ? await readMotionMapping(next, target).catch(() => undefined) : undefined;
      if (ticket !== request.current) { disposeCharacter(next); return; }
      const selectedIndex = file === initialFile && Number.isInteger(initialClipIndex) && initialClipIndex >= 0 && initialClipIndex < next.clips.length ? initialClipIndex : 0;
      setSource(next); setFilename(file.name); setClipIndex(selectedIndex);
      setLibrarySource(file === initialFile);
      const initialMapping = file === initialFile ? saved ?? suggestLibraryMapping(target, next) : suggestBoneMapping(target, next);
      setMapping(initialMapping);
      setMappingExpanded(file !== initialFile || !!initialFitError || !mappingReady(target, initialMapping));
      if (file === initialFile && initialFitError) setError(initialFitError);
      setTransfer(file === initialFile || file.name.toLowerCase().endsWith('.bvh') ? 'retarget' : 'matching');
      setBlend(String(Math.min(.15, duration / 2, next.clips[selectedIndex].duration / 2)));
    } catch (cause) {
      if (next) disposeCharacter(next);
      if (ticket === request.current) setError(cause instanceof Error ? cause.message : 'The animation could not be opened.');
    } finally {
      if (ticket === request.current) { setLoading(false); busyRef.current = false; onBusy(false); }
    }
  }

  useEffect(() => { if (initialFile) void load(initialFile); }, [initialFile]);

  function apply() {
    if (!source || !clip || !validBlend || loading) return;
    setError(null);
    try {
      const keys = transfer === 'retarget' ? retargetAnimation(target, source, clip, mapping, rootMotion, librarySource ? libraryAlignment(target, mapping) : undefined) : importAnimationOnRig(target, source, clip);
      if (transfer === 'retarget') onMappingSaved?.(source, mapping);
      onApply(keys, Math.max(clip.duration, 1 / fps), mode, Number(blend), librarySource && clip.name ? clip.name.replace(/_/g, ' ') : filename);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This animation could not be applied.'); }
  }

  return <div className="animation-import">
    <span className="modal-icon"><Activity size={25}/></span>
    <div className="eyebrow">YOUR CHARACTER. ANOTHER MOVE.</div>
    <h2>{librarySource ? 'Fit this move.' : 'Import an animation.'}</h2>
    <p>{librarySource ? <>Adjust how this move fits <strong>{target.name}</strong>, or close this window to try another move.</> : <>Put motion from an animation library on <strong>{target.name}</strong>, or add it after the current motion.</>}</p>
    <div className="animation-import-target"><Check size={16}/><span>Character loaded · {target.name}<small>{target.bones.length} joints · its mesh and rig stay in this scene</small></span></div>
    {!librarySource && <><p>FBX, GLB and BVH work across libraries. Use matching-rig transfer for this character’s own clips, or map joints to adapt a different rig. Animation-only files work too.</p><AnimationSources/></>}
    <input ref={input} type="file" accept=".fbx,.glb,.gltf,.bvh" aria-label="Animation file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void load(file); }}/>
    <button className="button secondary full-width" disabled={loading} onClick={() => input.current?.click()}><Upload size={16}/>{filename ? 'Choose a different animation file' : 'Choose animation FBX, GLB or BVH'}</button>
    {source && clip && <>
      <p className="animation-import-file">{filename} · {clip.duration.toFixed(2)} seconds</p>
      {source.clips.length > 1 && <label>Animation in this file<select aria-label="Imported animation clip" value={clipIndex} onChange={event => { setClipIndex(Number(event.target.value)); setError(null); }}>{source.clips.map((item, index) => <option key={index} value={index}>{item.name || `Animation ${index + 1}`}</option>)}</select></label>}
      <label>{librarySource ? 'How should this move fit?' : 'Rig compatibility'}<select aria-label="Animation transfer method" value={transfer} onChange={e => { setTransfer(e.target.value as typeof transfer); setError(null); }}><option value="matching">{librarySource ? 'Use the same character' : 'Matching rig · preserve all bone channels'}</option><option value="retarget">{librarySource ? 'Match body parts' : 'Retarget with joint mapping · rotations & root travel'}</option></select></label>
      {transfer === 'retarget' && <>
        <p>{librarySource && libraryAlignment(target, mapping) ? 'The app will try to fit this move using the matched body parts.' : librarySource ? 'For the best result, both characters should face the same way.' : 'Both models must face the same direction in their rest pose.'} Review the matches below. Unmatched joints follow their parents.</p>
        {mapping.some(index => index < 0) && <p role="status">Choose a matching joint below for any body part you want to move. Extra joints can stay skipped.</p>}
        <details className="animation-mapping" open={mappingExpanded} onToggle={event => setMappingExpanded(event.currentTarget.open)}><summary>{librarySource ? 'Adjust body part matches' : `${mapping.filter(i => i >= 0).length} / ${source.bones.length} source joints mapped`}</summary><div className="animation-mapping-list">{source.bones.map((bone, index) => <label key={bone.uuid}><span>{bone.name}</span><select aria-label={`Map ${bone.name}`} value={mapping[index] ?? -1} onChange={e => { setMapping(current => current.map((v, i) => i === index ? Number(e.target.value) : v)); setError(null); }}><option value={-1}>{librarySource ? 'Follow parent' : 'Skip this joint'}</option>{target.bones.map((other, i) => <option key={other.uuid} value={i} disabled={mapping.some((value, j) => j !== index && value === i)}>{other.name}</option>)}</select></label>)}</div>{librarySource && <button className="text-button" onClick={() => { setMapping(suggestLibraryMapping(target, source)); setError(null); }}>Restore suggested matches</button>}</details>
        <label className="rig-finger-option"><input type="checkbox" checked={rootMotion} onChange={e => setRootMotion(e.target.checked)}/>Transfer root &amp; hip travel, scaled to this rig</label>
        {skippedMorphs.length > 0 && <p role="status">{skippedMorphs.length} face shapes are missing from this character and will be skipped. Matching face shapes and body motion will transfer.</p>}
        <small>{librarySource ? 'Play the result to check it. Undo brings back your previous motion.' : 'This is a starting retarget, without contact correction. Review the result with playback; Undo restores your take. Animated scale and translations outside the root / hips require matching-rig transfer.'}</small>
      </>}
      <fieldset className="animation-import-modes"><legend>Where should this motion go?</legend>
        <label><input type="radio" name="animation-import-mode" value="apply" checked={mode === 'apply'} onChange={() => { setMode('apply'); setError(null); }}/><span><strong>Apply to character</strong><small>Replace the current motion. Undo restores it.</small></span></label>
        <label><input type="radio" name="animation-import-mode" value="append" checked={mode === 'append'} onChange={() => { setMode('append'); setError(null); }}/><span><strong>Append after current motion</strong><small>Keep the current take and blend into this one.</small></span></label>
      </fieldset>
      {mode === 'append' && <label>Transition · seconds<input aria-label="Animation transition seconds" type="number" min="0" max={Math.min(duration, clip.duration) / 2} step="0.05" value={blend} onChange={event => setBlend(event.target.value)}/><small>0 makes a direct cut. Maximum {(Math.min(duration, clip.duration) / 2).toFixed(2)} seconds.</small></label>}
    </>}
    {error && <p className="animation-import-error" role="alert">{error}</p>}
    <button className="button primary full-width" disabled={!clip || !validBlend || loading} onClick={apply}><Activity size={16}/>{mode === 'append' ? 'Append animation' : 'Apply animation to character'}</button>
    <p className="animation-import-footnote">Animation imports save with this scene and export with its character. Review the transition and foot contacts after appending.</p>
  </div>;
}
