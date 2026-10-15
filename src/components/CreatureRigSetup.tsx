import { useMemo, useState } from 'react';
import { Bone, RotateCcw } from 'lucide-react';
import { Vector3 } from 'three';
import Viewport from './Viewport';
import { applyPose } from '../engine/character';
import type { AnatomicalFit } from '../engine/anatomicalRig';
import type { CharacterAsset, Pose, Vec3 } from '../types';
import type { Theme } from '../theme';
import './HandRigSetup.css';

export default function CreatureRigSetup(props: { preview: CharacterAsset; fit: AnatomicalFit; initial: AnatomicalFit; theme: Theme; disabled: boolean; onChange: (fit: AnatomicalFit) => void; onBind: () => void; onBack: () => void }) {
  const [selected, setSelected] = useState(0);
  const pose: Pose = useMemo(() => {
    const joints = new Map(props.fit.joints.map(j => [j.name, j]));
    return props.preview.bones.map(b => {
      const j = joints.get(b.name)!, parent = j.parent ? joints.get(j.parent) : undefined;
      return { position: j.position.map((v, axis) => v - (parent?.position[axis] ?? 0)) as Vec3, quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
    });
  }, [props.fit.joints, props.preview]);
  const selectedName = props.preview.bones[selected]?.name;
  const joint = props.fit.joints.find(j => j.name === selectedName);
  const place = (next: Pose) => {
    applyPose(props.preview, next);
    const positions = new Map(props.preview.bones.map(b => [b.name, props.preview.root.worldToLocal(b.getWorldPosition(new Vector3())).toArray() as Vec3]));
    props.onChange({ ...props.fit, joints: props.fit.joints.map(j => ({ ...j, position: positions.get(j.name)! })) });
  };
  return <section className="hand-rig-setup">
    <div className="eyebrow">CHAINS, HEADS &amp; TENTACLES</div><h2>A rig for your creature.</h2>
    <p>Place each joint inside its matching part. These are geometric starting points; no legs are required. Drag joints to fit bent necks, then place each jaw hinge where it opens.</p>
    <fieldset disabled={props.disabled}>
      <div className="hand-fit-note estimated">Check front and side views by orbiting the model. Binding adds automatic skin weights after you confirm the placement.</div>
      <div className="hand-rig-viewport"><Viewport asset={props.preview} pose={pose} theme={props.theme} selectedBone={selected} onSelectBone={index => { if (index !== null) setSelected(index); }} onPoseChange={place} showRig showGhosts={false} ghostPoses={[]} cameraView="perspective" tool="move" playing={false} editable={!props.disabled} jointPlacement/></div>
      <div className="hand-rig-toolbar"><label>Joint<select aria-label="Creature joint" value={selected} onChange={e => setSelected(Number(e.target.value))}>{props.preview.bones.map((b, i) => <option key={b.name} value={i}>{b.name}</option>)}</select></label>
        {joint && <div className="hand-rig-coordinates">{['X', 'Y', 'Z'].map((axis, i) => <label key={`${joint.name}:${axis}:${joint.position[i]}`}>{axis}<input aria-label={`${axis} creature joint`} type="number" step="0.01" defaultValue={Number(joint.position[i].toFixed(5))} onBlur={e => {
          const value = Number(e.target.value);
          if (!e.target.value.trim() || !Number.isFinite(value)) { e.target.value = String(joint.position[i]); return; }
          props.onChange({ ...props.fit, joints: props.fit.joints.map(j => j.name === joint.name ? { ...j, position: j.position.map((v, a) => a === i ? value : v) as Vec3 } : j) });
        }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/></label>)}</div>}
      </div>
      <p>Each chain has its own weight group. Overlapping surfaces may still need weight cleanup in Blender. After binding, use Rotate to test one head or tentacle at a time.</p>
      <div className="hand-rig-actions"><button className="button secondary" onClick={() => props.onChange(structuredClone(props.initial))}><RotateCcw size={14}/>Reset placement</button><button className="button secondary" onClick={props.onBack}>Back</button><button className="button primary" onClick={props.onBind}><Bone size={14}/>Bind creature</button></div>
    </fieldset>
  </section>;
}
