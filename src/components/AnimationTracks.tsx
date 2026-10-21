import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Layers2, Plus, Trash2, Volume2, VolumeX } from 'lucide-react';
import type { AnimationTrack, PoseKey } from '../types';
import './AnimationTracks.css';

interface Props {
  tracks: AnimationTrack[]; baseName: string; baseMuted: boolean; baseKeys: PoseKey[];
  activeId: string | null; duration: number; time: number; fps: number; disabled: boolean;
  coveredBy: string[];
  onAdd(): void; onSelect(id: string | null): void; onTime(time: number): void;
  onUpdate(id: string | null, patch: { name?: string; muted?: boolean }): void;
  onCopy(id: string | null): void; onDelete(id: string): void; onReorder(id: string, direction: number): void;
  onMove(id: string, offset: number): void;
  onMoveKey(id: string | null, keyId: string, time: number): void;
}
const colors = ['#a997dc', '#5cbdac', '#d9ac6d', '#cc8ba8', '#8faedb'];

export default function AnimationTracks(props: Props) {
  const drag = useRef<{ id: string | null; keyId?: string; x: number; width: number; time: number; pointerId: number; scrub?: boolean } | null>(null);
  const [preview, setPreview] = useState<{ id: string | null; keyId?: string; delta: number } | null>(null);
  const rows = [...props.tracks].reverse().map((track, i) => ({ ...track, color: colors[(props.tracks.length - i) % colors.length], empty: !track.channels.length && !track.morphs.length }));
  const all = [...rows, { id: null, name: props.baseName, keys: props.baseKeys, muted: props.baseMuted, color: colors[0], empty: false }];
  const selected = all.find(t => t.id === props.activeId) ?? all[all.length - 1];
  const index = props.tracks.findIndex(t => t.id === props.activeId);
  function deltaAt(clientX: number) {
    const d = drag.current!;
    const raw = Math.round((clientX - d.x) / d.width * props.duration * props.fps) / props.fps;
    const row = all.find(t => t.id === d.id)!;
    return d.keyId ? Math.max(-d.time, Math.min(props.duration - d.time, raw)) : Math.max(-Math.min(...row.keys.map(k => k.time)), Math.min(600 - Math.max(...row.keys.map(k => k.time)), raw));
  }
  return <section className="animation-tracks" aria-label="Animation tracks">
    <div className="tracks-heading"><div><Layers2 size={16}/><strong>Tracks</strong><span>Play together. Edit separately.</span></div><button className="button" disabled={props.disabled || props.tracks.length >= 31} onClick={props.onAdd}><Plus size={14}/>Add track</button></div>
    <div className="tracks-ruler"><span>Higher tracks play on top</span><div role="slider" aria-label="Tracks playhead" aria-valuemin={0} aria-valuemax={props.duration} aria-valuenow={props.time} aria-valuetext={`${props.time.toFixed(2)} seconds`} aria-disabled={props.disabled} tabIndex={props.disabled ? -1 : 0} title="Click or drag to scrub all tracks"
      onPointerDown={e => { if (props.disabled || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); props.onTime(Math.max(0, Math.min(props.duration, (e.clientX - rect.left) / rect.width * props.duration))); }}
      onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const rect = e.currentTarget.getBoundingClientRect(); props.onTime(Math.max(0, Math.min(props.duration, (e.clientX - rect.left) / rect.width * props.duration))); }}
      onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onKeyDown={e => { if (props.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); e.stopPropagation(); props.onTime(e.key === 'Home' ? 0 : e.key === 'End' ? props.duration : Math.max(0, Math.min(props.duration, props.time + (e.key === 'ArrowLeft' ? -1 : 1) / props.fps))); }}>
      {[0, 1, 2, 3, 4].map(i => <span key={i}>{(props.duration * i / 4).toFixed(1)}s</span>)}<i className="tracks-ruler-head" aria-hidden="true" style={{ left: `${props.time / props.duration * 100}%` }}/></div></div>
    <div className="tracks-rows">
      {all.map(row => <div key={row.id ?? 'base'} className={`animation-track-row ${props.activeId === row.id ? 'active' : ''} ${row.muted ? 'muted' : ''}`} style={{ '--track-color': row.color } as React.CSSProperties}>
        <div className="track-label">
          <button className="track-select" aria-label={`Edit ${row.name} track`} aria-pressed={props.activeId === row.id} disabled={props.disabled} onClick={() => props.onSelect(row.id)}><span/></button>
          <input key={row.name} aria-label={`Track name: ${row.name}`} defaultValue={row.name} maxLength={80} disabled={props.disabled} onFocus={() => props.onSelect(row.id)} onBlur={e => { const name = e.currentTarget.value.trim() || row.name; e.currentTarget.value = name; if (name !== row.name) props.onUpdate(row.id, { name }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = row.name; e.currentTarget.blur(); } }}/>
          <button className="icon-button" aria-label={`${row.muted ? 'Unmute' : 'Mute'} ${row.name} track`} title={row.muted ? 'Unmute track' : 'Mute track'} aria-pressed={row.muted} disabled={props.disabled} onClick={() => props.onUpdate(row.id, { muted: !row.muted })}>{row.muted ? <VolumeX size={14}/> : <Volume2 size={14}/>}</button>
        </div>
        <div className="track-lane" onPointerDown={e => {
          if (props.disabled || e.button !== 0 || (e.target as HTMLElement).closest('.track-dot')) return;
          props.onSelect(row.id);
          const rect = e.currentTarget.getBoundingClientRect();
          if (row.id !== null && !row.muted && row.keys.length && (e.target as HTMLElement).closest('.track-clip')) {
            drag.current = { id: row.id, x: e.clientX, width: rect.width, time: 0, pointerId: e.pointerId };
            e.currentTarget.setPointerCapture(e.pointerId);
          } else {
            drag.current = { id: row.id, x: e.clientX, width: rect.width, time: 0, pointerId: e.pointerId, scrub: true };
            e.currentTarget.setPointerCapture(e.pointerId);
            props.onTime(Math.max(0, Math.min(props.duration, (e.clientX - rect.left) / rect.width * props.duration)));
          }
        }} onPointerMove={e => {
          if (!drag.current || drag.current.pointerId !== e.pointerId) return;
          if (drag.current.scrub) { const rect = e.currentTarget.getBoundingClientRect(); props.onTime(Math.max(0, Math.min(props.duration, (e.clientX - rect.left) / rect.width * props.duration))); return; }
          setPreview({ id: drag.current.id, keyId: drag.current.keyId, delta: deltaAt(e.clientX) });
        }} onPointerUp={e => {
          const d = drag.current; if (!d || d.pointerId !== e.pointerId) return;
          const offset = d.scrub ? 0 : deltaAt(e.clientX); drag.current = null; setPreview(null);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          if (Math.abs(e.clientX - d.x) > 4 && offset) {
            if (d.keyId) props.onMoveKey(d.id, d.keyId, d.time + offset);
            else if (d.id) props.onMove(d.id, offset);
          } else if (d.keyId) props.onTime(d.time);
          else { const rect = e.currentTarget.getBoundingClientRect(); props.onTime(Math.max(0, Math.min(props.duration, (e.clientX - rect.left) / rect.width * props.duration))); }
        }} onLostPointerCapture={() => { drag.current = null; setPreview(null); }} onPointerCancel={() => { drag.current = null; setPreview(null); }}>
          {row.keys.length > 0 && <div className="track-clip" title={row.id ? 'Drag the strip to move this track in time' : 'Base animation'} style={{ left: `${(Math.min(...row.keys.map(k => k.time)) + (preview?.id === row.id && !preview.keyId ? preview.delta : 0)) / props.duration * 100}%`, width: `${(Math.max(...row.keys.map(k => k.time)) - Math.min(...row.keys.map(k => k.time))) / props.duration * 100}%` }}><span>{row.muted ? 'Muted' : row.empty ? 'Make a move to start' : row.name}</span></div>}
          {row.keys.map((key, i) => row.empty && key.label === 'Starting pose' ? null : <button className="track-dot" key={key.id} style={{ left: `${(key.time + (preview?.id === row.id && (preview.keyId === key.id || !preview.keyId) ? preview.delta : 0)) / props.duration * 100}%` }} aria-label={`${row.name} key ${i + 1} at ${key.time.toFixed(2)} seconds`} title={`${key.time.toFixed(2)}s · drag to move key`} disabled={props.disabled} onClick={e => { if (e.detail === 0) { props.onSelect(row.id); props.onTime(key.time); } }} onKeyDown={e => {
            if (!row.muted && e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); props.onMoveKey(row.id, key.id, Math.max(0, Math.min(props.duration, key.time + (e.key === 'ArrowLeft' ? -1 : 1) / props.fps))); }
          }} onPointerDown={e => {
            if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); props.onSelect(row.id); props.onTime(key.time);
            if (row.muted) return;
            const lane = e.currentTarget.parentElement!;
            drag.current = { id: row.id, keyId: key.id, x: e.clientX, width: lane.getBoundingClientRect().width, time: key.time, pointerId: e.pointerId }; lane.setPointerCapture(e.pointerId);
          }}><span/></button>)}
          <div className="track-playhead" style={{ left: `${props.time / props.duration * 100}%` }}/>
        </div>
      </div>)}
    </div>
    <div className="tracks-actions"><span>Editing <strong>{selected.name}</strong>{selected.muted && ' · unmute to make changes'}</span><div>
      <button className="icon-button" aria-label="Move track up" title="Move track up" disabled={props.disabled || index < 0 || index === props.tracks.length - 1} onClick={() => props.onReorder(props.activeId!, 1)}><ArrowUp size={14}/></button>
      <button className="icon-button" aria-label="Move track down" title="Move track down" disabled={props.disabled || index <= 0} onClick={() => props.onReorder(props.activeId!, -1)}><ArrowDown size={14}/></button>
      <button className="button" aria-label="Duplicate track" disabled={props.disabled || props.tracks.length >= 31} onClick={() => props.onCopy(props.activeId)}><Copy size={13}/><span>Duplicate track</span></button>
      <button className="icon-button" aria-label="Delete track" title="Delete track · Undo restores it" disabled={props.disabled || props.activeId === null} onClick={() => props.onDelete(props.activeId!)}><Trash2 size={14}/></button>
    </div></div>
    {props.coveredBy.length > 0 && <div className="track-overlap-note" role="status"><Layers2 size={14}/><span><strong>{props.coveredBy.join(', ')}</strong> plays above this track. Mute {props.coveredBy.length === 1 ? 'it' : 'those tracks'}{props.activeId ? ' or move this track up' : ''} to see changes to the same parts.</span></div>}
  </section>;
}
