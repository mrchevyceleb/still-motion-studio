import { useState } from 'react';
import { Copy, Film, FolderOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { ArchiveEntry, SceneEntry } from '../engine/project';
import './SceneLibrary.css';

interface Props {
  scenes: SceneEntry[];
  archives: ArchiveEntry[];
  activeId: string;
  recovering: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onRecover: (id: string) => void;
}

export default function SceneLibrary({ scenes, archives, activeId, recovering, onOpen, onNew, onImport, onRename, onDuplicate, onDelete, onRecover }: Props) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const shown = scenes.filter(scene => scene.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="scene-library" aria-label="Scene library">
    <div className="eyebrow">ROOM FOR EVERY IDEA</div>
    <h2>Your scenes.</h2>
    <p>{recovering ? 'Choose a saved scene to recover your work. Your stored scenes stay untouched until you open one.' : 'Every scene autosaves here on this device. Switch whenever you like; your current work is saved first.'}</p>
    <div className="library-toolbar">
      <label className="library-search"><Search size={16}/><input autoFocus aria-label="Search scenes" placeholder="Find a scene…" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="button secondary" disabled={recovering} onClick={onImport}><FolderOpen size={15}/>Import</button>
      <button className="button primary" disabled={recovering} onClick={onNew}><Plus size={15}/>New scene</button>
    </div>
    <div className="library-count">{shown.length} {shown.length === 1 ? 'scene' : 'scenes'}{query.trim() ? ' found' : ' saved'}</div>
    {shown.length ? <div className="library-grid">{shown.map(scene => <article className={`library-card ${scene.id === activeId ? 'current' : ''}`} key={scene.id} aria-label={`Scene: ${scene.name}`}>
      <button className="library-open" aria-label={`Open ${scene.name}`} onClick={() => onOpen(scene.id)}>
        <div className="library-thumbnail">{scene.thumbnail ? <img src={scene.thumbnail} alt=""/> : <Film size={36}/>}<span className="library-duration">{scene.duration.toFixed(1)}s</span>{scene.id === activeId && <span className="library-current">Current</span>}</div>
        <div className="library-card-text"><h3 title={scene.name}>{scene.name}</h3><span>{scene.keyCount} poses · {scene.kind === 'quadruped' ? 'Quadruped' : 'Human'}</span><time dateTime={new Date(scene.updatedAt).toISOString()}>Saved {new Date(scene.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
      </button>
      {editing === scene.id ? <form className="library-rename" onSubmit={event => { event.preventDefault(); void onRename(scene.id, name).then(saved => { if (saved) setEditing(null); }); }}><input autoFocus aria-label={`Name for ${scene.name}`} maxLength={200} value={name} onChange={event => setName(event.target.value)}/><button className="text-button" disabled={!name.trim()}>Save</button><button type="button" className="text-button" onClick={() => setEditing(null)}>Cancel</button></form> : <div className="library-card-actions"><button aria-label={`Rename ${scene.name}`} disabled={recovering} onClick={() => { setName(scene.name); setEditing(scene.id); setDeleting(null); }}><Pencil size={13}/>Rename</button><button aria-label={`Duplicate ${scene.name}`} disabled={recovering} onClick={() => onDuplicate(scene.id)}><Copy size={13}/>Duplicate</button><button aria-label={`Delete ${scene.name}`} disabled={recovering || scene.id === activeId} title={scene.id === activeId ? 'Open another scene before deleting this one' : 'Delete this saved scene'} onClick={() => { setDeleting(scene.id); setEditing(null); }}><Trash2 size={13}/></button></div>}
      {deleting === scene.id && <div className="library-delete"><p>Delete “{scene.name}” from this device?</p><div><button className="text-button" onClick={() => setDeleting(null)}>Keep scene</button><button className="button" onClick={() => { onDelete(scene.id); setDeleting(null); }}>Delete scene</button></div></div>}
    </article>)}</div> : <div className="library-empty"><Film size={28}/><h3>{query.trim() ? 'No scenes with that name.' : 'Your next move belongs here.'}</h3><p>{query.trim() ? 'Try another name, or clear your search.' : recovering ? 'Open a recent backup below, or reopen Still to retry recovery.' : 'Create a scene or import a Still project to begin.'}</p></div>}
    {archives.length > 0 && <details className="library-backups"><summary>Recent scene backups</summary><p>Open a backup to keep it in your library.</p><div>{archives.map(entry => <button key={entry.id} onClick={() => onRecover(entry.id)}><FolderOpen size={14}/><span>{entry.name}</span><small>{new Date(entry.updatedAt).toLocaleDateString()}</small></button>)}</div></details>}
    <p className="library-footnote">Use Export → Editable Still project to take a copy with you.</p>
  </section>;
}
