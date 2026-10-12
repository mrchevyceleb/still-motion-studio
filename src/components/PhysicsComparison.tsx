import type { MotionGeneration } from '../types';
import './PhysicsComparison.css';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const format = (value: number | undefined, unit: string) => value === undefined ? 'Not reported' : `${value > 0 && value < .01 ? '<0.01' : value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;

interface Props {
  generation: MotionGeneration;
  onSaveReport: () => void;
}

export default function PhysicsComparison({ generation, onSaveReport }: Props) {
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
  return <section className="physics-comparison" aria-label="Physics comparison">
    <div className="physics-comparison-heading"><div><h2>Did physics help?</h2><p>{generation.name} · {review ? 'Applied · review needed' : 'Applied'}</p></div></div>
    <p className="physics-compare-hint">{comparison ? 'Use Side by side above the character to watch Before and After together, or view either on its own. Playing, scrubbing and camera moves stay in sync. Before is a preview; edits and exports use After.' : 'This older pass has no saved before preview. Run physics again to save both versions.'}</p>
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
    {(review || notes.length > 0) && <details className="physics-review-details" open={review}><summary>{review ? 'Why this still needs review' : 'Model limitations'}</summary><ul>{notes.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}
  </section>;
}
