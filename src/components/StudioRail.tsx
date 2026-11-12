import { Activity, CircleHelp, Hand, Keyboard, PersonStanding, Sparkles } from 'lucide-react';

export type StudioPanel = 'character' | 'motions' | 'pose' | 'assist';

/** The four things you can be doing. One opens at a time, so the stage keeps the room.
 *  On screens where the panel covers the stage it starts closed. */
export const STUDIO_PANELS = [
  { id: 'character', label: 'Character', hint: 'Your character, its look and its scenes', Icon: PersonStanding },
  { id: 'motions', label: 'Motions', hint: 'Ready-made moves, your own clips and motion capture', Icon: Activity },
  { id: 'pose', label: 'Pose', hint: 'The joint you grabbed, fingers and face', Icon: Hand },
  { id: 'assist', label: 'Assist', hint: 'Fill the gaps, add physics and tidy the clip', Icon: Sparkles },
] as const;

const KEY = 'still.panel';

const coversStage = () => window.matchMedia('(max-width: 1000px)').matches;

export function readStudioPanel(): StudioPanel | null {
  const covers = coversStage();
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'none') return null;
    if (STUDIO_PANELS.some(panel => panel.id === saved)) return covers ? null : saved as StudioPanel;
  } catch { /* Fall through to the default when storage is unavailable. */ }
  return covers ? null : 'character';
}

/** Keeps the panel you chose. Closing one that covers the stage is only putting it away, so that is not kept. */
export function rememberStudioPanel(panel: StudioPanel | null) {
  if (!panel && coversStage()) return;
  try { localStorage.setItem(KEY, panel ?? 'none'); } catch { /* Keep the choice for this session. */ }
}

interface Props { active: StudioPanel | null; onSelect(panel: StudioPanel): void; onHelp(): void; onShortcuts(): void; }

export default function StudioRail({ active, onSelect, onHelp, onShortcuts }: Props) {
  return <nav className="studio-rail" aria-label="Studio panels">
    {STUDIO_PANELS.map(({ id, label, hint, Icon }) => <button key={id} className="rail-tab" aria-label={`${label} panel`} aria-expanded={active === id} aria-controls={`panel-${id}`} title={active === id ? `Hide ${label}` : hint} onClick={() => onSelect(id)}><span className="rail-icon"><Icon size={19}/></span><span className="rail-label">{label}</span></button>)}
    <span className="rail-gap"/>
    <button className="rail-tab rail-quiet" aria-label="A quick tour" title="A quick tour" onClick={onHelp}><span className="rail-icon"><CircleHelp size={17}/></span><span className="rail-label">Tour</span></button>
    <button className="rail-tab rail-quiet" aria-label="Keyboard shortcuts" title="Keyboard shortcuts · ? or F1" aria-keyshortcuts="? F1" onClick={onShortcuts}><span className="rail-icon"><Keyboard size={17}/></span><span className="rail-label">Keys</span></button>
  </nav>;
}
