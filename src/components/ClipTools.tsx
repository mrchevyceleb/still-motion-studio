import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Scissors } from 'lucide-react';
import type { ClipEdit } from '../engine/clipEditing';
import './ClipTools.css';

interface Props {
  duration: number; fps: number; clips: { name: string; duration: number }[]; disabled: boolean;
  onEdit: (edit: ClipEdit) => void; onAppend: (index: number, blend: number) => void;
  onAppendProject: (file: File, blend: number) => void; onPause: () => void;
}

export default function ClipTools(props: Props) {
  const [start, setStart] = useState('0'), [end, setEnd] = useState(String(props.duration));
  const [speed, setSpeed] = useState('1'), [count, setCount] = useState('2');
  const [blend, setBlend] = useState(String(Math.min(.15, props.duration / 2)));
  const [clip, setClip] = useState('0');
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setStart('0'); setEnd(String(props.duration)); setBlend(String(Math.min(.15, props.duration / 2))); }, [props.duration]);
  const finite = (value: string) => value.trim() !== '' && Number.isFinite(Number(value));
  const validRange = finite(start) && finite(end) && Number(start) >= 0 && Number(end) <= props.duration && Number(end) - Number(start) >= 1 / props.fps;
  const validSpeed = finite(speed) && Number(speed) >= .1 && Number(speed) <= 10 && props.duration / Number(speed) >= 1 / props.fps && props.duration / Number(speed) <= 600;
  const validBlend = finite(blend) && Number(blend) >= 1 / props.fps && Number(blend) <= props.duration / 2;
  const validRepeat = validBlend && finite(count) && Number.isInteger(Number(count)) && Number(count) >= 2 && Number(count) <= 20 && props.duration * Number(count) <= 600;
  const chosen = props.clips[Number(clip)];
  const appendBlend = finite(blend) && Number(blend) >= 0 && chosen && Number(blend) <= Math.min(props.duration, chosen.duration) / 2;

  return <details className="assist-section clip-tools" onToggle={event => { if (event.currentTarget.open) props.onPause(); }}>
    <summary><Scissors size={14}/>Clip tools<ChevronDown size={13}/></summary>
    <fieldset disabled={props.disabled} onFocus={props.onPause}>
      <p>Each edit has one Undo and saves with the scene. Export uses the edited motion.</p>
      <div className="clip-tool-fields">
        <label>Start · s<input aria-label="Trim start" type="number" min="0" max={props.duration} step={1 / props.fps} value={start} onChange={e => setStart(e.target.value)}/></label>
        <label>End · s<input aria-label="Trim end" type="number" min="0" max={props.duration} step={1 / props.fps} value={end} onChange={e => setEnd(e.target.value)}/></label>
      </div>
      <button className="button" disabled={!validRange || Number(start) === 0 && Number(end) === props.duration} onClick={() => props.onEdit({ kind: 'trim', start: Number(start), end: Number(end) })}>Trim to range</button>
      <div className="clip-tool-fields">
        <label>Speed · ×<input aria-label="Clip speed" type="number" min="0.1" max="10" step="0.1" value={speed} onChange={e => setSpeed(e.target.value)}/></label>
        <button className="button" disabled={!validSpeed || Number(speed) === 1} onClick={() => { props.onEdit({ kind: 'speed', factor: Number(speed) }); setSpeed('1'); }}>Apply speed</button>
      </div>
      <div className="clip-tool-actions"><button className="button" onClick={() => props.onEdit({ kind: 'reverse' })}>Reverse motion</button><button className="button" onClick={() => props.onEdit({ kind: 'in-place' })}>Make in place</button></div>
      <p>In place locks hip travel on X/Z. Height changes and turns remain.</p>
      <div className="clip-tool-fields">
        <label>Blend · s<input aria-label="Clip blend" type="number" min="0" max={props.duration / 2} step="0.05" value={blend} onChange={e => setBlend(e.target.value)}/></label>
        <label>Repeats<input aria-label="Clip repeats" type="number" min="2" max="20" step="1" value={count} onChange={e => setCount(e.target.value)}/></label>
      </div>
      <div className="clip-tool-actions"><button className="button" disabled={!validBlend} onClick={() => props.onEdit({ kind: 'loop', blend: Number(blend) })}>Close loop seam</button><button className="button" disabled={!validRepeat} onClick={() => props.onEdit({ kind: 'repeat', count: Number(count), blend: Number(blend) })}>Repeat motion</button></div>
      <p>Loop blend eases the end pose into the next cycle. Repeats keep travel and heading. Review foot contacts after blending.</p>
      <div className="clip-compose">
        <strong>Blend another take</strong>
        {props.clips.length > 0 && <><label>Character clip<select aria-label="Clip to append" value={clip} onChange={e => setClip(e.target.value)}>{props.clips.map((item, index) => <option key={index} value={index}>{item.name || `Animation ${index + 1}`}</option>)}</select></label><button className="button" disabled={!appendBlend} onClick={() => props.onAppend(Number(clip), Number(blend))}>Append selected clip</button></>}
        <input ref={fileInput} type="file" accept=".still" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) props.onAppendProject(file, Number(blend)); }}/>
        <button className="button" disabled={!finite(blend) || Number(blend) < 0 || Number(blend) > props.duration / 2} onClick={() => fileInput.current?.click()}>Append saved .still take</button>
        <p>Uses the motion saved from this character. Position and heading align at the blend; a different rig needs retargeting first.</p>
      </div>
    </fieldset>
  </details>;
}
