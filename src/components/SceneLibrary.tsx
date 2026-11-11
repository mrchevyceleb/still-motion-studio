import { useState } from 'react';
import { ArrowLeft, ArrowRight, Bone, Copy, Download, Film, FolderOpen, LockKeyhole, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import type { ArchiveEntry, SceneEntry } from '../engine/project';
import type { CharacterEntry } from '../engine/characterLibrary';
import './SceneLibrary.css';

interface Props {
  characters: CharacterEntry[]; scenes: SceneEntry[]; archives: ArchiveEntry[];
  activeId: string; initialCharacterId?: string; recovering: boolean;
  onOpen: (id: string) => void; onNew: (characterId: string) => void; onAddCharacter: () => void;
  onRenameCharacter: (id: string, name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDuplicate: (id: string) => void; onExport: (id: string, format: 'glb' | 'unreal' | 'still') => void;
  onDelete: (id: string) => Promise<boolean>; onRecover: (id: string) => void;
}

export default function SceneLibrary({ characters, scenes, archives, activeId, initialCharacterId, recovering, onOpen, onNew, onAddCharacter, onRenameCharacter, onRename, onDuplicate, onExport, onDelete, onRecover }: Props) {
  const [selectedId, setSelectedId] = useState(initialCharacterId);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const character = characters.find(entry => entry.id === selectedId);
  const matching = (name: string) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  // The saved file name is the animation's name with spaces as underscores, so typing either finds the scene.
  const shown = scenes.filter(scene => scene.characterId === character?.id && (matching(scene.name) || matching(scene.name.replace(/\s+/g, '_'))));
  const recent = scenes.filter(scene => scene.characterId).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const shownCharacters = characters.filter(entry => matching(entry.name) || scenes.some(scene => scene.characterId === entry.id && (matching(scene.name) || matching(scene.name.replace(/\s+/g, '_')))));
  const activeCharacterId = scenes.find(scene => scene.id === activeId)?.characterId;
  const drafts = scenes.filter(scene => !scene.characterId);
  const goBack = () => { setSelectedId(undefined); setQuery(''); setEditing(null); setDeleting(null); };
  const renameForm = (id: string, label: string, save: (id: string, name: string) => Promise<boolean>) =>
    <form className="library-rename" onSubmit={event => { event.preventDefault(); void save(id, name).then(saved => { if (saved) setEditing(null); }); }}>
      <input autoFocus aria-label={`Name for ${label}`} maxLength={200} value={name} onChange={event => setName(event.target.value)}/>
      <button className="text-button" disabled={!name.trim()}>Save</button><button type="button" className="text-button" onClick={() => setEditing(null)}>Cancel</button>
    </form>;
  return <section className="scene-library" aria-label="Character library">
    {character ? <>
      <button className="text-button library-back" onClick={goBack}><ArrowLeft size={15}/>All characters</button>
      <div className="eyebrow">YOUR CHARACTER · YOUR SCENES</div>
      <div className="library-title"><h2>{character.name}</h2><span className="locked-character"><LockKeyhole size={13}/>Rig locked · {character.boneCount} joints</span></div>
      <p>Every scene uses this saved model and rig. Start a fresh animation, or duplicate a scene to try a variation.</p>
    </> : <>
      <div className="eyebrow">ONE CHARACTER. ENDLESS SCENES.</div><h2>Your characters.</h2>
      <p>{recovering ? 'Choose a saved character and scene to recover your work.' : 'Save a character once. Open it to find all its scenes and create your next animation.'}</p>
    </>}
    <div className="library-toolbar">
      <label className="library-search"><Search size={16}/><input autoFocus aria-label={character ? 'Search scenes' : 'Search characters'} placeholder={character ? 'Find a scene…' : 'Find a character or scene…'} value={query} onChange={event => setQuery(event.target.value)}/></label>
      {character ? <button className="button primary" disabled={recovering} onClick={() => onNew(character.id)}><Plus size={15}/>New scene</button> : <button className="button primary" disabled={recovering} onClick={onAddCharacter}><Plus size={15}/>Add character</button>}
    </div>
    <div className="library-count">{character ? `${shown.length} ${shown.length === 1 ? 'scene' : 'scenes'}` : `${shownCharacters.length} ${shownCharacters.length === 1 ? 'character' : 'characters'}`}{query.trim() ? ' found' : ' saved'}</div>
    {!character && !query.trim() && recent.length > 0 && <div className="library-recent"><h3>Recent animations</h3><p>Pick up where you left off. Duplicate makes an editable copy; export sends GLB, Unreal or .still straight from here.</p><div>{recent.map(scene => <article className="library-recent-card" key={scene.id}>
      <button className="library-recent-main" aria-label={`Open animation ${scene.name}`} onClick={() => onOpen(scene.id)}><Film size={17}/><span><strong title={scene.name}>{scene.name}</strong><small>{scene.keyCount} poses · {scene.duration.toFixed(1)} seconds · {new Date(scene.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>{scene.id === activeId && <span className="library-recent-current">Current</span>}</button>
      <div className="library-recent-actions"><button aria-label={`Duplicate animation ${scene.name}`} disabled={recovering} onClick={() => onDuplicate(scene.id)}><Copy size={13}/>Duplicate</button><button aria-label={`Export ${scene.name} as GLB`} disabled={recovering} onClick={() => onExport(scene.id, 'glb')}><Download size={13}/>GLB</button><button aria-label={`Export ${scene.name} for Unreal`} disabled={recovering} onClick={() => onExport(scene.id, 'unreal')}><Download size={13}/>Unreal</button><button aria-label={`Export ${scene.name} as a Still scene file`} disabled={recovering} onClick={() => onExport(scene.id, 'still')}><Download size={13}/>.still</button></div>
    </article>)}</div></div>}
    {!character && (shownCharacters.length ? <div className="library-grid">{shownCharacters.map(entry => {
      const children = scenes.filter(scene => scene.characterId === entry.id);
      const recent = [...children].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return <article className={`library-card character-library-card ${entry.id === activeCharacterId ? 'current' : ''}`} key={entry.id} aria-label={`Character: ${entry.name}`}>
        <button className="library-open" aria-label={`Open character ${entry.name}`} onClick={() => { setSelectedId(entry.id); setQuery(''); setEditing(null); setDeleting(null); }}>
          <div className="library-thumbnail">{entry.thumbnail || recent?.thumbnail ? <img src={entry.thumbnail || recent?.thumbnail} alt=""/> : <Users size={36}/>}<span className="library-duration"><LockKeyhole size={10}/>Rig locked</span>{entry.id === activeCharacterId && <span className="library-current">Current character</span>}</div>
          <div className="library-card-text"><h3 title={entry.name}>{entry.name}</h3><span>{entry.kind === 'quadruped' ? 'Quadruped' : 'Human'} · {entry.boneCount} joints</span><strong className="character-scene-count">{children.length} {children.length === 1 ? 'scene' : 'scenes'}<ArrowRight size={13}/></strong></div>
        </button>
        {editing === entry.id ? renameForm(entry.id, entry.name, onRenameCharacter) : <div className="library-card-actions"><button aria-label={`Rename character ${entry.name}`} disabled={recovering} onClick={() => { setName(entry.name); setEditing(entry.id); }}><Pencil size={13}/>Rename character</button><button aria-label={`New scene for ${entry.name}`} disabled={recovering} onClick={() => onNew(entry.id)}><Plus size={13}/>New scene</button></div>}
      </article>;
    })}</div> : <div className="library-empty"><Users size={28}/><h3>{query.trim() ? 'No characters found.' : 'Give your ideas a character.'}</h3><p>{query.trim() ? 'Try a character or scene name.' : 'Add a rigged model, or start with a practice character.'}</p></div>)}
    {character && (shown.length ? <div className="library-grid">{shown.map(scene => <article className={`library-card ${scene.id === activeId ? 'current' : ''}`} key={scene.id} aria-label={`Scene: ${scene.name}`}>
      <button className="library-open" aria-label={`Open scene ${scene.name}`} onClick={() => onOpen(scene.id)}>
        <div className="library-thumbnail">{scene.thumbnail ? <img src={scene.thumbnail} alt=""/> : <Film size={36}/>}<span className="library-duration">{scene.duration.toFixed(1)}s</span>{scene.id === activeId && <span className="library-current">Current scene</span>}</div>
        <div className="library-card-text"><h3 title={scene.name}>{scene.name}</h3><span>{scene.keyCount} poses · {scene.duration.toFixed(1)} seconds</span><time dateTime={new Date(scene.updatedAt).toISOString()}>Saved {new Date(scene.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></div>
      </button>
      {editing === scene.id ? renameForm(scene.id, scene.name, onRename) : <div className="library-card-actions"><button aria-label={`Rename scene ${scene.name}`} disabled={recovering} onClick={() => { setName(scene.name); setEditing(scene.id); setDeleting(null); }}><Pencil size={13}/>Rename</button><button aria-label={`Duplicate scene ${scene.name}`} disabled={recovering} onClick={() => onDuplicate(scene.id)}><Copy size={13}/>Duplicate</button><button aria-label={`Export scene ${scene.name} as GLB`} disabled={recovering} onClick={() => onExport(scene.id, 'glb')}><Download size={13}/>GLB</button><button aria-label={`Export scene ${scene.name} for Unreal`} disabled={recovering} onClick={() => onExport(scene.id, 'unreal')}><Download size={13}/>Unreal</button><button aria-label={`Export scene ${scene.name} as a Still scene file`} disabled={recovering} onClick={() => onExport(scene.id, 'still')}><Download size={13}/>.still</button><button aria-label={`Delete scene ${scene.name}`} disabled={recovering} onClick={() => { setDeleting(scene.id); setEditing(null); }}><Trash2 size={13}/></button></div>}
      {deleting === scene.id && <div className="library-delete"><p>Delete “{scene.name}”? Your character and other scenes stay saved.</p><div><button className="text-button" onClick={() => setDeleting(null)}>Keep scene</button><button className="button" onClick={() => { void onDelete(scene.id).then(deleted => { if (deleted) setDeleting(null); }); }}>Delete scene</button></div></div>}
    </article>)}</div> : <div className="library-empty"><Film size={28}/><h3>{query.trim() ? 'No scenes with that name.' : 'Ready for a new scene.'}</h3><p>{query.trim() ? 'Try another name, or clear your search.' : 'Your model and rig are saved. Create a scene to start animating.'}</p></div>)}
    {!character && drafts.length > 0 && <details className="library-backups"><summary>Models waiting for a rig ({drafts.length})</summary><p>Open a model and add its rig to save it as a character.</p>{drafts.map(scene => <button key={scene.id} onClick={() => onOpen(scene.id)}><Bone size={14}/><span>{scene.name}</span></button>)}</details>}
    {!character && archives.length > 0 && <details className="library-backups"><summary>Recent scene backups</summary><p>Open a backup to restore it to its character.</p>{archives.map(entry => <button key={entry.id} onClick={() => onRecover(entry.id)}><FolderOpen size={14}/><span>{entry.name}</span><small>{new Date(entry.updatedAt).toLocaleDateString()}</small></button>)}</details>}
    <p className="library-footnote">Characters and scenes autosave on this device. Export a .still scene for a portable backup with its character included.</p>
  </section>;
}
