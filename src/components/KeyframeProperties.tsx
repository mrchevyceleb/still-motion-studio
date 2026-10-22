import { useEffect, useState } from 'react';
import { Copy, Move } from 'lucide-react';
import { propertyValues } from '../engine/poseProperties';
import type { PoseProperty, PoseReference, PropertyAxes } from '../engine/poseProperties';
import type { CharacterAsset, Pose, Vec3 } from '../types';
import './KeyframeProperties.css';

interface Props {
  asset: CharacterAsset; pose: Pose; selectedBone: number | null; reference: PoseReference | null;
  selectedCount: number; disabled: boolean; selectionMode: boolean;
  onPosition: (position: Vec3) => void; onCopy: () => void; onSelect: () => void;
  onPause: () => void;
  onApply: (property: PoseProperty, axes: PropertyAxes, mode: 'offset' | 'match') => void;
  onOffset: (delta: Vec3) => boolean;
}
const axisNames = ['X · left / right', 'Y · height', 'Z · forward / back'];
const rounded = (value: number) => Number(value.toFixed(4));

function PositionField({ value, label, onChange }: { value: number; label: string; onChange: (value: number) => void }) {
  const shown = String(rounded(value));
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  return <input type="number" step="0.01" aria-label={label} value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => {
    if (draft.trim() === '' || !Number.isFinite(Number(draft))) { setDraft(shown); return; }
    if (draft !== shown) onChange(Number(draft));
  }} onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') { event.preventDefault(); setDraft(shown); }
  }}/>;
}

export default function KeyframeProperties(props: Props) {
  const [property, setProperty] = useState<PoseProperty>('position');
  const [axes, setAxes] = useState<PropertyAxes>([true, true, true]);
  const [mode, setMode] = useState<'offset' | 'match'>('offset');
  const [offset, setOffset] = useState(['0', '0', '0']);
  let position: Vec3, source: Vec3 | null = null, before: Vec3 | null = null;
  try {
    position = propertyValues(props.asset, props.pose, 'position', null);
    if (props.reference && (property === 'position' || props.reference.bone !== null)) {
      source = propertyValues(props.asset, props.reference.after, property, props.reference.bone);
      before = propertyValues(props.asset, props.reference.before, property, props.reference.bone);
    }
  } catch (error) {
    return <details className="keyframe-properties"><summary><Move size={14}/>Position &amp; property tools</summary><p className="property-error" role="status">{error instanceof Error ? error.message : 'This rig cannot use property tools. Reimport it with valid transforms.'}</p></details>;
  }
  const hasCorrection = source && before && axes.some((enabled, axis) => enabled && Math.abs(source[axis] - before[axis]) > 1e-7);
  const validOffset = offset.every(value => value.trim() !== '' && Number.isFinite(Number(value))) && offset.some(value => Number(value) !== 0);

  return <details className="keyframe-properties">
    <summary><Move size={14}/>Position &amp; property tools<span>Correct once. Apply to many.</span></summary>
    <fieldset disabled={props.disabled} onFocus={props.onPause}>
      <div className="property-current">
        <div><strong>Current pose position</strong><p>Move the whole model at the playhead. Values are in meters.</p></div>
        <div className="property-numbers">{axisNames.map((name, axis) => <label key={name}><span>{name}</span><PositionField label={`${name} model position`} value={position[axis]} onChange={value => {
          const next = [...position] as Vec3; next[axis] = value; props.onPosition(next);
        }}/></label>)}</div>
      </div>
      <div className="property-controls">
        <label>Property<select aria-label="Property to apply" value={property} onChange={event => setProperty(event.target.value as PoseProperty)}><option value="position">Whole model position</option><option value="rotation">Joint rotation</option></select></label>
        <label>Apply as<select aria-label="Property apply mode" value={mode} onChange={event => setMode(event.target.value as 'offset' | 'match')}><option value="offset">Same correction</option><option value="match">Exact value</option></select></label>
        <div className="property-axes" role="group" aria-label="Property axes">{['X', 'Y', 'Z'].map((axis, index) => <label key={axis}><input type="checkbox" aria-label={`Apply ${axis} axis`} checked={axes[index]} onChange={event => setAxes(previous => previous.map((value, i) => i === index ? event.target.checked : value) as PropertyAxes)}/>{axis}{property === 'position' && index === 1 ? ' · height' : ''}</label>)}</div>
        <button className="button" disabled={property === 'rotation' && props.selectedBone === null} onClick={() => { props.onCopy(); setMode('match'); }}><Copy size={13}/>Copy current values</button>
      </div>
      <div className="property-reference" role="status">{source && props.reference ? <>
        <strong>Source: {props.reference.time.toFixed(2)}s{property === 'rotation' ? ` · ${props.asset.bones[props.reference.bone!].name}` : ''}</strong>
        <span>{source.map((value, axis) => `${['X', 'Y', 'Z'][axis]} ${rounded(value)}${property === 'position' ? 'm' : '°'}`).join(' · ')}</span>
        {mode === 'offset' && before && <span>Correction: {source.map((value, axis) => `${['X', 'Y', 'Z'][axis]} ${rounded(property === 'rotation' ? ((value - before[axis] + 540) % 360) - 180 : value - before[axis])}${property === 'position' ? 'm' : '°'}`).join(' · ')}</span>}
      </> : <span>{property === 'rotation' ? 'Select a joint, then edit it or copy its current values.' : 'Move one pose here or in the viewport to capture a correction, or copy its current values.'}</span>}</div>
      <div className="property-apply">
        <p>{mode === 'offset' ? 'Adds the same adjustment to every selected pose, preserving its movement.' : 'Sets only the checked axes to the source values.'} The source pose stays as corrected.</p>
        {!props.selectionMode && <button className="button" onClick={props.onSelect}>Select keyframes</button>}
        <button className="button primary" disabled={!props.selectedCount || !source || !axes.some(Boolean) || mode === 'offset' && !hasCorrection} onClick={() => props.onApply(property, axes, mode)}>Apply to {props.selectedCount || ''} selected</button>
      </div>
      <div className="property-clip">
        <div><strong>Move entire animation</strong><p>Offsets every pose and generated frame. One Undo restores the take.</p></div>
        <div className="property-numbers">{axisNames.map((name, axis) => <label key={name}><span>{name} · m</span><input type="number" step="0.01" aria-label={`${name} animation offset`} value={offset[axis]} onChange={event => setOffset(previous => previous.map((value, index) => index === axis ? event.target.value : value))}/></label>)}</div>
        <button className="button" disabled={!validOffset} onClick={() => { if (props.onOffset(offset.map(Number) as Vec3)) setOffset(['0', '0', '0']); }}>Move entire animation</button>
      </div>
    </fieldset>
  </details>;
}
