import { useEffect, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { CharacterAsset, Vec3 } from '../types';
import { NO_FIT, characterParts, isFitted, partFitter, type PartFit as Fit } from '../engine/partFit';
import './PartFit.css';

interface Props { asset: CharacterAsset; disabled?: boolean; onApply: (message: string) => void; onClose: () => void }

function Field({ label, name, unit, value, step, disabled, onChange }: { label: string; name: string; unit: string; value: number; step: number; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  return <label title={name}><span>{label}</span><input type="number" aria-label={name} step={step} value={text} disabled={disabled} onChange={event => { setText(event.target.value); const number = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(number)) onChange(number); }}/><small>{unit}</small></label>;
}

/** Nudge one mesh of the look (a hat, a pot) on its bones. Previews live; Apply bakes it into the character. */
export default function PartFit({ asset, disabled, onApply, onClose }: Props) {
  const parts = useMemo(() => characterParts(asset), [asset]);
  const [partId, setPartId] = useState(parts[0]?.id);
  const [fit, setFit] = useState<Fit>(NO_FIT);
  const [revision, setRevision] = useState(0);
  const part = parts.find(item => item.id === partId) ?? parts[0];
  // A new fitter after each Apply (revision) measures the part where it now sits.
  const fitter = useMemo(() => part ? partFitter(asset, part.mesh) : null, [asset, part, revision]);
  useEffect(() => { if (fit === NO_FIT) fitter?.restore(); else fitter?.preview(fit); }, [fitter, fit]);
  // Closing, or picking another part, drops a preview that was never applied.
  useEffect(() => () => fitter?.restore(), [fitter]);
  if (!part || !fitter) return null;

  const fresh = () => { setFit(NO_FIT); setRevision(value => value + 1); };
  const set = (key: 'move' | 'turn', axis: number) => (value: number) => setFit(current => { const next = [...current[key]] as Vec3; next[axis] = value; return { ...current, [key]: next }; });
  const fields = `${part.id}:${revision}`;
  return <div className="joint-controls part-fit">
    <select aria-label="Part to fit" value={part.id} disabled={disabled} onChange={event => { setPartId(event.target.value); fresh(); }}>{parts.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
    <div className="part-fit-label">Move · cm</div>
    <div className="axis-fields" key={`move:${fields}`}>
      <Field label="Up" name="Move up (cm)" unit="" step={0.5} value={0} disabled={disabled} onChange={set('move', 1)}/>
      <Field label="Fwd" name="Move forward (cm)" unit="" step={0.5} value={0} disabled={disabled} onChange={set('move', 2)}/>
      <Field label="Left" name="Move left (cm)" unit="" step={0.5} value={0} disabled={disabled} onChange={set('move', 0)}/>
    </div>
    <div className="part-fit-label">Turn · degrees</div>
    <div className="axis-fields" key={`turn:${fields}`}>
      {['X', 'Y', 'Z'].map((axis, index) => <Field key={axis} label={axis} name={`Turn ${axis} (°)`} unit="°" step={1} value={0} disabled={disabled} onChange={set('turn', index)}/>)}
    </div>
    <div className="axis-fields part-fit-size" key={`size:${fields}`}><Field label="Size" name="Size (%)" unit="%" step={1} value={100} disabled={disabled} onChange={value => setFit(current => ({ ...current, size: Math.max(1, value) }))}/></div>
    <div className="part-fit-actions"><button className="button secondary" onClick={onClose}>Close</button><button className="button primary" disabled={disabled || fit === NO_FIT} onClick={() => { fitter.apply(fit); fresh(); onApply(`${part.label} fitted. Every pose, key and export follows.`); }}>Apply</button></div>
    {isFitted(part.mesh) && fit === NO_FIT && <button className="text-button" disabled={disabled} onClick={() => { fitter.reset(); fresh(); onApply(`${part.label} is back where it started.`); }}><RotateCcw size={13}/>Put this part back</button>}
    <p className="micro-copy">Measured on the rest pose, facing forward. The part keeps riding its bones in every pose.</p>
  </div>;
}
