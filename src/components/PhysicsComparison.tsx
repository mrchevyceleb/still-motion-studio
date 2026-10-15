import type { MotionGeneration } from '../types';
import './PhysicsComparison.css';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const format = (value: number | undefined, unit: string) => value === undefined ? 'Not reported' : `${value > 0 && value < .01 ? '<0.01' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;

interface Props {
  generation: MotionGeneration;
  onSaveReport: () => void;
  onCompare: (time?: number) => void;
  onKeep: () => void;
  onRestoreOriginal: () => void;
}

export default function PhysicsComparison({ generation, onSaveReport, onCompare, onKeep, onRestoreOriginal }: Props) {
  const { metrics, comparison } = generation;
  const before = record(metrics.before), after = record(metrics.after), quality = record(metrics.quality);
  const nativeBefore = number(metrics.footJointPenetrationBeforeMeters), nativeAfter = number(metrics.footJointPenetrationAfterMeters);
  const native = nativeBefore !== undefined || nativeAfter !== undefined;
  const rows = [
    { label: native ? 'Foot-joint penetration' : 'Floor overlap', before: native ? nativeBefore : number(before.floorPenetrationMaxM), after: native ? nativeAfter : number(after.floorPenetrationMaxM), scale: 100, unit: 'cm', description: 'Worst estimated penetration below the floor.' },
    { label: 'Planted-foot sliding', before: number(before.contactSlidingMeanMps), after: number(after.contactSlidingMeanMps), scale: 100, unit: 'cm/s', description: 'Average foot movement during detected ground contact.' },
    { label: 'Unexplained force', before: number(before.rootForceResidualRmsN), after: number(after.rootForceResidualRmsN), scale: 1, unit: 'N', description: 'Force the body model still needs to explain the motion.' },
  ].filter(row => row.before !== undefined || row.after !== undefined);
  const shifts = Array.isArray(metrics.anchorDrift) ? metrics.anchorDrift.map(item => number(record(item).rootTranslationM)).filter((value): value is number => value !== undefined) : [];
  const maxShift = shifts.length ? Math.max(...shifts) : number(metrics.maxRootCorrectionMeters);
  const reasons = Array.isArray(quality.reasons) ? quality.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
  const notes = [...new Set([...reasons, ...generation.warnings])];
  const review = quality.requiresReview === true;
  const endTime = comparison?.before.at(-1)?.time ?? 0;
  const changedPoses = (comparison && Array.isArray(metrics.anchorDrift) ? metrics.anchorDrift : []).flatMap(item => {
    const drift = record(item), time = number(drift.time), shift = number(drift.rootTranslationM);
    return time !== undefined && time <= endTime && shift !== undefined && shift > .02 ? [{ time, shift }] : [];
  }).sort((a, b) => b.shift - a.shift).slice(0, 3);
  const dynamicsUncertain = notes.some(note => /force|torque|calibrat/i.test(note));
  return <section className="physics-comparison" aria-label="Physics comparison">
    <div className="physics-comparison-heading"><div><h2>Choose the motion that looks better.</h2><p>Correction is already applied{review ? ' · physical realism not verified' : ''}.</p></div></div>
    <p className="physics-compare-hint">{comparison ? 'Compare these checks, then keep the correction or return to the original. If you cannot see an improvement, use the original.' : 'This older pass has no saved original. Run physics again to enable comparison and restoration.'}</p>
    <div className="physics-review-checks">
      <div className="physics-review-check"><h3>Check the feet</h3><p>Watch both versions together. Look for less sliding or floor clipping, without new floating or sudden jumps.</p><button className="button secondary" disabled={!comparison} onClick={() => onCompare()}>Play comparison</button></div>
      {changedPoses.length > 0 && <div className="physics-review-check"><h3>Check the poses physics moved most</h3><p>Make sure the correction kept the pose you intended. These are body-position shifts at your saved poses.</p><div className="physics-pose-links">{changedPoses.map((pose, index) => <button className="button secondary" key={index} onClick={() => onCompare(pose.time)} aria-label={`Compare changed pose at ${pose.time.toFixed(2)} seconds`}><strong>{pose.time.toFixed(2)}s</strong><span>Moved {format(pose.shift * 100, 'cm')}</span></button>)}</div></div>}
      {review && <div className="physics-review-limit"><strong>{dynamicsUncertain ? 'This is a cleanup proposal, not a guarantee of realistic physics.' : 'Give the corrected motion a visual check.'}</strong><p>{dynamicsUncertain ? 'The body model still cannot explain all of this movement. You do not need to tune force or torque values to keep editing. Keep the correction only if the comparison looks better.' : 'The engine flagged changes that may affect your intended motion. Check the feet and changed poses before choosing a version.'}</p></div>}
    </div>
    <div className="physics-review-decision"><button className="button primary" onClick={onKeep}>Keep correction</button><button className="button secondary" disabled={!comparison} onClick={onRestoreOriginal}>Use original motion</button><p>{comparison ? 'Restoring the original keeps your timing. Undo brings this correction back.' : 'The current correction stays applied when you close this review.'}</p></div>
    <details className="physics-technical-details"><summary>Technical measurements and engine notes</summary>
    {rows.length > 0 ? <div className="physics-metrics-scroll"><table><caption>Motion measurements · lower is better</caption><thead><tr><th scope="col">Measurement</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Change</th></tr></thead><tbody>
      {rows.map(row => {
        const difference = row.before !== undefined && row.after !== undefined ? row.after - row.before : undefined;
        const changed = difference !== undefined && Math.abs(difference) > Math.max(1e-8, (row.before ?? 0) * .001);
        const better = changed && difference! < 0;
        const percent = changed && row.before ? Math.abs(difference!) / row.before * 100 : undefined;
        const percentage = percent !== undefined && percent > 99 && percent < 100 ? '>99%' : `${percent?.toFixed(0)}%`;
        return <tr key={row.label}><th scope="row">{row.label}<small>{row.description}</small></th><td>{format(row.before === undefined ? undefined : row.before * row.scale, row.unit)}</td><td>{format(row.after === undefined ? undefined : row.after * row.scale, row.unit)}</td><td className={changed ? better ? 'metric-better' : 'metric-worse' : ''}>{difference === undefined ? 'Not reported' : changed ? `${better ? '↓' : '↑'} ${percent === undefined ? 'Increased' : `${percentage} ${better ? 'less' : 'more'}`}` : 'No change'}</td></tr>;
      })}
    </tbody></table></div> : <p className="physics-compare-hint">This engine did not report before/after measurements. Use the motion preview to compare.</p>}
    <div className="physics-compare-footer"><p>{maxShift === undefined ? '' : `Largest checked pose shift: ${format(maxShift * 100, 'cm')}. `}{native ? 'Measurements describe foot joints, not the visible mesh.' : 'Measurements use an approximate body and foot model, not the visible mesh.'}</p><button className="text-button" onClick={onSaveReport}>Save report</button></div>
    {notes.length > 0 && <ul className="physics-engine-notes">{notes.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    </details>
  </section>;
}
