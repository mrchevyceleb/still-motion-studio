import { useEffect, useState } from 'react';
import { Download, LoaderCircle, RotateCcw } from 'lucide-react';
import type { UpdateState } from '../desktop';
import '../updates.css';

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const api = window.stillDesktop?.updates;
    if (!api) return;
    let live = true;
    const unsubscribe = api.onState(value => { if (live) setState(value); });
    void api.state().then(value => { if (live) setState(value); }).catch(() => {});
    return () => { live = false; unsubscribe(); };
  }, []);
  return state;
}

export default function UpdatesDialog({ state, canInstall, onInstall }: { state: UpdateState | null; canInstall: boolean; onInstall: () => void }) {
  const [error, setError] = useState('');
  const waiting = !state || ['checking', 'downloading', 'installing'].includes(state.status);
  const check = () => {
    setError('');
    void window.stillDesktop?.updates.check().catch(() => setError('The update service is unavailable. Reopen Still and try again.'));
  };
  return <>
    <span className="modal-icon"><Download size={25}/></span>
    <div className="eyebrow">STILL, GETTING BETTER</div>
    <h2>Keep your<br/>studio up to date.</h2>
    <p>New releases download in the background. Restart when you’re ready; your scene is saved first.</p>
    <div className="update-status" role="status" aria-live="polite">
      <strong>{state?.status === 'ready' ? `Version ${state.version} is ready` : `Installed version ${state?.currentVersion ?? '…'}`}</strong>
      <p>{error || state?.message || 'Connecting to the update service…'}</p>
      {state?.status === 'downloading' && <><progress aria-label="Update download" max="100" value={state.progress ?? 0}/><span>{state.progress ?? 0}%</span></>}
    </div>
    <div className="update-actions">
      {state?.status === 'ready' ? <button className="button primary" disabled={!canInstall} onClick={onInstall}><RotateCcw size={16}/>Restart and update</button> : <button className="button primary" disabled={waiting} onClick={check}>{waiting ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>}Check for updates</button>}
    </div>
    {state?.status === 'ready' && !canInstall && <p>Finish active work and resolve native cleanup before restarting.</p>}
    <p className="update-note">Updates come from the public Still GitHub releases. No account or sign-in is needed.</p>
  </>;
}
