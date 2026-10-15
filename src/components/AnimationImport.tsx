import { useEffect, useRef, useState } from 'react';
import { Activity, Check, Upload } from 'lucide-react';
import { disposeCharacter, importCharacter } from '../engine/character';
import { importAnimationOnRig } from '../engine/animationImport';
import type { CharacterAsset, PoseKey } from '../types';
import './AnimationImport.css';

export default function AnimationImport({ target, duration, fps, initialMode, onBusy, onApply }: {
  target: CharacterAsset; duration: number; fps: number; initialMode: 'apply' | 'append';
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
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const busyRef = useRef(false);
  const onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  useEffect(() => () => { ++request.current; if (busyRef.current) onBusyRef.current(false); }, []);
  useEffect(() => () => { if (source) disposeCharacter(source); }, [source]);
  const clip = source?.clips[clipIndex];
  const validBlend = mode === 'apply' || blend.trim() !== '' && Number.isFinite(Number(blend)) && Number(blend) >= 0 && Number(blend) <= Math.min(duration, clip?.duration ?? 0) / 2;

  async function load(file: File) {
    const ticket = ++request.current;
    setError(null); setLoading(true); busyRef.current = true; onBusy(true);
    let next: CharacterAsset | undefined;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error('Choose an animation file smaller than 200 MB.');
      next = await importCharacter(file);
      if (ticket !== request.current) { disposeCharacter(next); return; }
      if (!next.clips.length) throw new Error('This file contains no animation. In Mixamo, select a motion before downloading its FBX.');
      setSource(next); setFilename(file.name); setClipIndex(0);
      setBlend(String(Math.min(.15, duration / 2, next.clips[0].duration / 2)));
    } catch (cause) {
      if (next) disposeCharacter(next);
      if (ticket === request.current) setError(cause instanceof Error ? cause.message : 'The animation could not be opened.');
    } finally {
      if (ticket === request.current) { setLoading(false); busyRef.current = false; onBusy(false); }
    }
  }

  function apply() {
    if (!source || !clip || !validBlend || loading) return;
    setError(null);
    try {
      const keys = importAnimationOnRig(target, source, clip);
      onApply(keys, Math.max(clip.duration, 1 / fps), mode, Number(blend), filename);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This animation could not be applied.'); }
  }

  return <div className="animation-import">
    <span className="modal-icon"><Activity size={25}/></span>
    <div className="eyebrow">YOUR CHARACTER. ANOTHER MOVE.</div>
    <h2>Import an animation.</h2>
    <p>Put a Mixamo animation on <strong>{target.name}</strong>, or add it after the current motion.</p>
    <div className="animation-import-target"><Check size={16}/><span>Character loaded · {target.name}<small>{target.bones.length} joints · its mesh and rig stay in this scene</small></span></div>
    <p>In Mixamo, select a motion for <strong>this same character</strong> and download its FBX. <strong>Without Skin</strong> is enough; With Skin also works. A different skeleton needs retargeting first.</p>
    <input ref={input} type="file" accept=".fbx,.glb,.gltf" aria-label="Animation file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void load(file); }}/>
    <button className="button secondary full-width" disabled={loading} onClick={() => input.current?.click()}><Upload size={16}/>{filename ? 'Choose a different animation file' : 'Choose animation FBX or GLB'}</button>
    {source && clip && <>
      <p className="animation-import-file">{filename} · {clip.duration.toFixed(2)} seconds</p>
      {source.clips.length > 1 && <label>Animation in this file<select aria-label="Imported animation clip" value={clipIndex} onChange={event => { setClipIndex(Number(event.target.value)); setError(null); }}>{source.clips.map((item, index) => <option key={index} value={index}>{item.name || `Animation ${index + 1}`}</option>)}</select></label>}
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
