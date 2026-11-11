import { ArrowRight, Bone, Sparkles } from 'lucide-react';
import './SameCharacterCard.css';

/** The first choice in "new scene": keep the character you already have and give it an empty timeline. */
export function SameCharacterCard({ name, peek, disabled, onStart }: { name: string; peek?: string; disabled?: boolean; onStart: () => void }) {
  return (
    <button className="same-character" disabled={disabled} onClick={onStart}>
      <span className="same-character-peek" aria-hidden="true">
        {peek ? <img src={peek} alt=""/> : <Bone size={30}/>}
        <Sparkles className="same-character-spark" size={15}/>
      </span>
      <span className="same-character-copy">
        <small>Keep your character</small>
        <strong>New animation with {name}</strong>
        <em>Same rig, fresh timeline. This scene stays safe in your library.</em>
      </span>
      <ArrowRight className="same-character-arrow" size={18}/>
    </button>
  );
}
