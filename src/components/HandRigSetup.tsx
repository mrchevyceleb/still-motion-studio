import { useEffect, useMemo, useRef, useState } from 'react';
import { Bone, Crosshair, RotateCcw } from 'lucide-react';
import { Box3, Vector3 } from 'three';
import Viewport from './Viewport';
import type { ViewportAPI } from './Viewport';
import { FINGERS } from '../engine/handRig';
import type { HandSide, LandmarkConfidence } from '../engine/handRig';
import type { AnatomicalFit } from '../engine/anatomicalRig';
import { applyPose } from '../engine/character';
import type { CharacterAsset, Pose, Vec3 } from '../types';
import type { Theme } from '../theme';
import './HandRigSetup.css';

interface Props { preview: CharacterAsset; fit: AnatomicalFit; initial: AnatomicalFit; theme: Theme; zoomToCursor?: boolean; disabled: boolean; onChange: (fit: AnatomicalFit) => void; onBind: () => void; onBack: () => void }

function LandmarkField({ value, label, onCommit }: { value: number; label: string; onCommit: (value: number) => void }) {
  const shown = String(Number(value.toFixed(5))), [draft, setDraft] = useState(shown);
  const cancelled = useRef(false);
  useEffect(() => { setDraft(shown); }, [shown]);
  return <input aria-label={label} type="number" step="0.005" value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => {
    if (cancelled.current) { cancelled.current = false; return; }
    if (draft.trim() === '' || !Number.isFinite(Number(draft))) { setDraft(shown); return; }
    if (Number(draft) !== value) onCommit(Number(draft));
  }} onKeyDown={e => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setDraft(shown); e.currentTarget.blur(); }
  }}/>;
}

export default function HandRigSetup(props: Props) {
  const [side, setSide] = useState<HandSide>('Left'), [finger, setFinger] = useState<string>('Index');
  const [landmark, setLandmark] = useState('1');
  const api = useRef<ViewportAPI | null>(null);
  const selectedName = landmark === 'wrist' ? `${side}Hand` : `${side}Hand${finger}${landmark}`;
  const selectedBone = props.preview.bones.findIndex(b => b.name === selectedName);
  const selected = props.fit.joints.find(j => j.name === selectedName);
  const pose: Pose = useMemo(() => {
    const joints = new Map(props.fit.joints.map(j => [j.name, j]));
    return props.preview.bones.map(b => {
      const j = joints.get(b.name)!, parent = j.parent ? joints.get(j.parent) : undefined;
      return { position: j.position.map((v, axis) => v - (parent?.position[axis] ?? 0)) as Vec3, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
    });
  }, [props.fit.joints, props.preview]);
  const filter = [`${side}Hand`, ...FINGERS.flatMap(digit => ['1', '2', '3', 'End'].map(segment => `${side}Hand${digit}${segment}`))];
  const focus = () => {
    if (!api.current) return;
    applyPose(props.preview, pose);
    const bounds = new Box3().setFromPoints(props.preview.bones.filter(b => b.name.startsWith(`${side}Hand`)).map(b => b.getWorldPosition(new Vector3())));
    const target = bounds.getCenter(new Vector3()), radius = Math.max(.06, bounds.getSize(new Vector3()).length() / 2);
    const camera = api.current.getCamera(), aspect = Math.min(1, camera.width / Math.max(1, camera.height));
    const distance = Math.max(.1, radius / Math.tan(Math.PI / 12) / Math.max(.4, aspect) * 1.25);
    api.current.setCamera({ target: target.toArray(), position: target.clone().add(new Vector3(0, .18, 1).normalize().multiplyScalar(Math.min(14, distance))).toArray(), fov: 30 });
  };
  useEffect(() => { focus(); }, [side, props.preview]);
  const applyPlacement = (joints: AnatomicalFit['joints']) => {
    const changed = new Set(joints.filter((j, i) => j.position.some((v, axis) => Math.abs(v - props.fit.joints[i].position[axis]) > 1e-8)).map(j => j.name));
    props.onChange({ ...props.fit, joints, diagnostics: { ...props.fit.diagnostics, hands: props.fit.diagnostics.hands?.map(hand => ({ ...hand, digits: hand.digits?.map(digit => ({ ...digit, landmarks: Object.fromEntries(Object.entries(digit.landmarks).map(([segment, confidence]) => [segment, changed.has(`${hand.side}Hand${digit.finger}${segment}`) ? 'manual' : confidence])) as typeof digit.landmarks })) })) } });
  };
  const replacePosition = (name: string, position: Vec3) => applyPlacement(props.fit.joints.map(j => j.name === name ? { ...j, position } : j));
  const updatePose = (next: Pose) => {
    applyPose(props.preview, next);
    props.preview.root.updateMatrixWorld(true);
    const positions = new Map(props.preview.bones.map(b => [b.name, props.preview.root.worldToLocal(b.getWorldPosition(new Vector3())).toArray() as Vec3]));
    applyPlacement(props.fit.joints.map(j => ({ ...j, position: positions.get(j.name)! })));
  };
  const info = props.fit.diagnostics.hands?.find(h => h.side === side);
  const selectedConfidence = landmark === 'wrist' ? 'estimated' : info?.digits?.find(d => d.finger === finger)?.landmarks[landmark as '1' | '2' | '3' | 'End'] ?? 'estimated';
  const confidenceLabel = (confidence: LandmarkConfidence) => confidence === 'detected' ? 'tip detected' : confidence === 'manual' ? 'manually placed' : 'estimated';
  return <section className="hand-rig-setup">
    <div className="eyebrow">PLACE THE JOINTS. KEEP YOUR MESH.</div><h2>Hands that move.</h2>
    <p>Check both hands before binding. Drag a joint or edit its coordinates. Use an open A-pose or T-pose with separated fingers for the best fit.</p>
    <fieldset disabled={props.disabled}>
      <div className="hand-rig-toolbar"><label>Hand<select aria-label="Hand to fit" value={side} onChange={e => { setSide(e.target.value as HandSide); setLandmark('1'); }}><option>Left</option><option>Right</option></select></label><label>Finger<select aria-label="Finger to fit" value={finger} onChange={e => { setFinger(e.target.value); setLandmark('1'); }}>{FINGERS.map(name => <option key={name} value={name}>{name} · {confidenceLabel(info?.digits?.find(d => d.finger === name)?.landmarks.End ?? 'estimated')}</option>)}</select></label><button className="button secondary" onClick={focus}><Crosshair size={14}/>Focus hand</button></div>
      <div className={`hand-fit-note ${info?.status === 'estimated' ? 'estimated' : ''}`} role="status">{info?.status === 'detected' ? '5 separated fingertips detected. Bend joints are estimated; check their placement and finger labels.' : `${info?.detectedTips ?? 0}/5 separated fingertips found. The finger selector marks estimates; correct their joints to match your mesh.`}</div>
      <div className="hand-rig-viewport"><Viewport zoomToCursor={props.zoomToCursor} asset={props.preview} pose={pose} theme={props.theme} apiRef={api} selectedBone={selectedBone} onSelectBone={index => {
        if (index === null) return;
        const name = props.preview.bones[index].name;
        if (name === `${side}Hand`) setLandmark('wrist');
        else { const match = name.match(/Hand(Thumb|Index|Middle|Ring|Pinky)(1|2|3|End)$/); if (match) { setFinger(match[1]); setLandmark(match[2]); } }
      }} onPoseChange={updatePose} showRig showGhosts={false} ghostPoses={[]} cameraView="perspective" tool="move" playing={false} editable={!props.disabled} jointPlacement jointFilter={filter}/></div>
      <div className="hand-rig-toolbar"><label>Joint<select aria-label="Hand landmark" value={landmark} onChange={e => setLandmark(e.target.value)}><option value="wrist">Wrist / palm</option><option value="1">Knuckle</option><option value="2">Middle joint</option><option value="3">Last joint</option><option value="End">Fingertip</option></select></label>{selected && <div className="hand-rig-coordinates">{['X', 'Y', 'Z'].map((axis, i) => <label key={`${selectedName}:${axis}`}>{axis}<LandmarkField label={`${axis} hand landmark`} value={selected.position[i]} onCommit={value => { const position = [...selected.position] as Vec3; position[i] = value; replacePosition(selectedName, position); }}/></label>)}</div>}</div>
      <p className="hand-landmark-confidence" role="status">{landmark === 'wrist' ? 'Wrist / palm' : `${finger} ${landmark === 'End' ? 'fingertip' : landmark === '1' ? 'knuckle' : `joint ${landmark}`}`}: {confidenceLabel(selectedConfidence)}. Check this point against your mesh.</p>
      <p>Three bend joints and a tip per finger. The mesh stays in its original rest pose while you place them. After binding, use Rotate to bend fingers; moving a fingertip affects only its finger chain.</p>
      <div className="hand-rig-actions"><button className="button secondary" onClick={() => props.onChange(structuredClone(props.initial))}><RotateCcw size={14}/>Reset placement</button><button className="button secondary" onClick={props.onBack}>Back</button><button className="button primary" onClick={props.onBind}><Bone size={14}/>Bind hands &amp; body</button></div>
    </fieldset>
  </section>;
}
