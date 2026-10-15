import { useState, type MouseEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import './AnimationImport.css';

const sources = [
  { name: 'Mesh2Motion', url: 'https://mesh2motion.org/', text: 'Animal, bird and dragon templates, rig fitting and animations. Export GLB with its rig, then import the character here.', tag: 'Creature rigs · CC0 assets' },
  { name: 'Quaternius', url: 'https://quaternius.com/', text: 'Animated monsters, animals and character packs. Import the rigged model with its included clips.', tag: 'Characters & motions · check pack license' },
  { name: 'ActorCore', url: 'https://actorcore.reallusion.com/', text: 'Human mocap in FBX / BVH. Use the matching character rig, or review a joint map in Retarget mode.', tag: 'Human motions · vendor license' },
  { name: 'Fab', url: 'https://www.fab.com/', text: 'Creature and boss packs. Choose assets with downloadable FBX or GLB and animations; engine-only packages need conversion.', tag: 'Marketplace · license varies' },
  { name: 'Mixamo', url: 'https://www.mixamo.com/', text: 'Human motions. Download an FBX for the same character for matching-rig transfer.', tag: 'Human motions · Adobe terms' },
];

export default function AnimationSources() {
  const [error, setError] = useState<string | null>(null);
  const open = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    if (!window.stillDesktop) return;
    event.preventDefault();
    setError(null);
    void window.stillDesktop.openExternal(url).catch(() => setError('This source could not be opened in your browser.'));
  };
  return <details className="animation-sources"><summary>Find characters, rigs &amp; animations</summary>
    <p>Download from the library, then choose the file here. A creature pack’s own rig and motions are the most reliable pairing.</p>
    <div>{sources.map(source => <a href={source.url} key={source.name} target="_blank" rel="noreferrer" onClick={event => open(event, source.url)}><strong>{source.name}<ExternalLink size={12}/></strong><small>{source.tag}</small><span>{source.text}</span></a>)}</div>
    <p>For unusual AI rigging, <a href="https://github.com/VAST-AI-Research/UniRig" target="_blank" rel="noreferrer" onClick={event => open(event, 'https://github.com/VAST-AI-Research/UniRig')}>UniRig</a> is an external research option. Import its rigged FBX here. It is not installed or bundled with Still. Local creature chain fitting is available under Add a rig.</p>
    {error && <p role="alert" className="animation-import-error">{error}</p>}
  </details>;
}
