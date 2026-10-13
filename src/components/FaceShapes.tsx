import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { applyMorphs, captureMorphs, createMorphSampler } from '../engine/morphs';
import type { CharacterAsset, InterpolationMode, MorphValues, Pose, PoseKey } from '../types';
import './FaceShapes.css';

interface Props {
  asset: CharacterAsset; keys: PoseKey[]; moments: PoseKey[]; pose: Pose; time: number; duration: number; fps: number;
  interpolation: InterpolationMode; disabled: boolean;
  onPause: () => void; onCommit: (key: PoseKey) => void;
}

export default function FaceShapes(props: Props) {
  const names = useMemo(() => Object.keys(captureMorphs(props.asset)).sort(), [props.asset]);
  const sample = useMemo(() => createMorphSampler(props.keys, props.interpolation, props.asset.restMorphs), [props.keys, props.interpolation, props.asset]);
  const values = useMemo(() => sample(props.time), [sample, props.time]);
  const pending = useRef<MorphValues | null>(null);
  const [draft, setDraft] = useState<MorphValues | null>(null);
  useLayoutEffect(() => {
    pending.current = null; setDraft(null);
    if (names.length) applyMorphs(props.asset, values);
  }, [props.asset, values, names]);

  if (!names.length) return null;
  const finish = () => {
    const morphs = pending.current;
    if (!morphs || props.disabled) return;
    pending.current = null; setDraft(null);
    const snapped = Math.min(props.duration, Math.round(props.time * props.fps) / props.fps);
    const existing = props.moments.find(key => Math.abs(key.time - snapped) < .5 / props.fps);
    props.onCommit({ ...existing, id: existing?.id ?? crypto.randomUUID(), time: existing?.time ?? snapped, pose: structuredClone(props.pose), label: existing?.label ?? 'New pose', morphs });
  };
  return <details className="assist-section face-shapes" open>
    <summary>Face &amp; shapes<span>{names.length}</span></summary>
    <fieldset disabled={props.disabled} onFocus={props.onPause}>
      {names.map(name => <label key={name}>
        <span title={name}>{name}</span><output>{Math.round(((draft ?? values)[name] ?? 0) * 100)}%</output>
        <input type="range" min="0" max="1" step="0.01" aria-label={`${name} shape`} value={(draft ?? values)[name] ?? 0}
          onPointerDown={event => { props.onPause(); event.currentTarget.setPointerCapture(event.pointerId); }} onChange={event => {
            const next = { ...(pending.current ?? values), [name]: Number(event.target.value) };
            pending.current = next; setDraft(next); applyMorphs(props.asset, next);
          }} onPointerUp={finish} onKeyUp={finish} onBlur={finish} onPointerCancel={() => {
            pending.current = null; setDraft(null); applyMorphs(props.asset, values);
          }}/>
      </label>)}
    </fieldset>
  </details>;
}
