import { useEffect, useRef, useState } from 'react';
import { Camera, FlipHorizontal2, Footprints, LoaderCircle, PersonStanding, Play, Square, Video, X } from 'lucide-react';
import { analyzeVideo, detectLiveFrame, loadPoseLandmarker, retargetMocap, SKELETON_LINES, type MocapFrame, type MocapTake } from '../engine/mocap';
import type { CharacterAsset, PoseKey } from '../types';
import './MotionCapture.css';

const MAX_CLIP_SECONDS = 120;

function drawSkeleton(canvas: HTMLCanvasElement, video: HTMLVideoElement | null, frame: MocapFrame | null, mirrored: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  ctx.clearRect(0, 0, width, height);
  if (!frame?.image) return;
  // Landmarks are normalized to the video frame, which is letterboxed (object-fit: contain) inside the stage.
  const vw = video?.videoWidth || width, vh = video?.videoHeight || height;
  const scale = Math.min(width / vw, height / vh);
  const offsetX = (width - vw * scale) / 2, offsetY = (height - vh * scale) / 2;
  const at = (index: number) => { const p = frame.image![index]; return { x: offsetX + (mirrored ? 1 - p.x : p.x) * vw * scale, y: offsetY + p.y * vh * scale }; };
  ctx.lineCap = 'round';
  for (const [lineWidth, style] of [[5, 'rgba(24,38,22,0.75)'], [2.5, '#dcecae']] as const) {
    ctx.strokeStyle = style; ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (const [a, b] of SKELETON_LINES) { const from = at(a), to = at(b); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); }
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (const index of new Set(SKELETON_LINES.flat())) { const p = at(index); ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
}

/** Camera recordings (WebM) often report an infinite duration until a far seek fills it in. */
function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('seeked', onDuration);
      resolve(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);
    };
    const onDuration = () => { if (Number.isFinite(video.duration) && video.duration > 0) { try { video.currentTime = 0; } catch { /* not seekable yet */ } finish(); } };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) { finish(); return; }
      try { video.currentTime = 1e7; } catch { finish(); }
    };
    const timer = setTimeout(finish, 6000);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('seeked', onDuration);
    if (video.readyState >= 1) onMeta();
  });
}

interface MocapResult { keys: PoseKey[]; duration: number; name: string; warnings: string[] }

export default function MotionCapture({ target, disabled, previewing, previewBlocked, onOpenChange, onPreview, onClear, onApply }: {
  target: CharacterAsset; disabled: boolean; previewing: boolean; previewBlocked: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (keys: PoseKey[], duration: number, name: string) => void;
  onClear: () => void;
  onApply: (keys: PoseKey[], duration: number, mode: 'apply' | 'append', blend: number, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'video' | 'camera'>('video');
  const [stage, setStage] = useState<'empty' | 'live' | 'clip'>('empty');
  const [clipName, setClipName] = useState('');
  const [durationSec, setDurationSec] = useState(0);
  const [trimStart, setTrimStart] = useState('0');
  const [trimEnd, setTrimEnd] = useState('0');
  const [sampleFps, setSampleFps] = useState('15');
  const [mirror, setMirror] = useState(false);
  const [travel, setTravel] = useState(true);
  const [smoothing, setSmoothing] = useState(50);
  const [analyzing, setAnalyzing] = useState<number | null>(null); // -1 while the tracker loads
  const [posing, setPosing] = useState(false);
  const [recording, setRecording] = useState<number | null>(null); // elapsed seconds while recording
  const [take, setTake] = useState<MocapTake | null>(null);
  const [result, setResult] = useState<MocapResult | null>(null);
  const [blend, setBlend] = useState('0.15');
  const [error, setError] = useState<string | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clipUrlRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef(0);
  const liveStartRef = useRef(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartedRef = useRef(0);
  const fallbackDurationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const recordingGenRef = useRef(0);

  const humanoid = target.kind === 'humanoid';
  const busy = disabled || analyzing !== null || posing;

  const stopCamera = (discardRecording = false) => {
    requestRef.current++;
    if (discardRecording) recordingGenRef.current++;
    cancelAnimationFrame(rafRef.current);
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    if (recorderRef.current?.state === 'recording') try { recorderRef.current.stop(); } catch { /* already stopped */ }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setRecording(null);
  };

  const clearTake = () => {
    recordingGenRef.current++;
    setTake(null); setResult(null);
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    clipUrlRef.current = null;
    setClipName(''); setDurationSec(0); setStage('empty');
  };

  // A new character invalidates any tracked take preview, like the Motion Library.
  useEffect(() => {
    requestRef.current++;
    abortRef.current?.abort();
    stopCamera(true);
    clearTake();
    setAnalyzing(null); setPosing(false);
    setOpen(false); setError(null);
    onClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.root]);

  useEffect(() => () => {
    requestRef.current++;
    abortRef.current?.abort();
    stopCamera(true);
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  // Restore the clip into the freshly mounted video element when the dialog reopens.
  useEffect(() => {
    if (!open || stage !== 'clip' || !clipUrlRef.current) return;
    const video = videoRef.current;
    if (video && video.src !== clipUrlRef.current) {
      video.src = clipUrlRef.current;
      void resolveDuration(video).then(seconds => { const usable = seconds > 0 ? seconds : fallbackDurationRef.current; if (usable > 0) { setDurationSec(usable); setTrimEnd(current => current === '0' ? String(Number(Math.min(usable, MAX_CLIP_SECONDS).toFixed(2))) : current); } });
    }
  }, [open, stage]);

  // Start the camera when the Record dialog opens on an empty stage.
  useEffect(() => {
    if (open && source === 'camera' && stage === 'empty') void startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, stage]);

  function closeDialog() {
    if (analyzing !== null || recording !== null) return;
    stopCamera(true);
    if (stage === 'live') setStage('empty');
    setOpen(false);
  }

  function openDialog(next: 'video' | 'camera') {
    if (disabled || !humanoid) return;
    setSource(next); setError(null); setLiveNote(null); setOpen(true);
  }

  async function startCamera() {
    if (streamRef.current) return;
    const ticket = ++requestRef.current;
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is unavailable here. Use the installed app, or open Still at its local address, then try again. Or use a video instead.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
      if (ticket !== requestRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) { stopCamera(true); return; }
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (ticket !== requestRef.current || streamRef.current !== stream) {
        stream.getTracks().forEach(track => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
      setStage('live');
      liveStartRef.current = performance.now();
      void loadPoseLandmarker().then(() => {
        if (ticket !== requestRef.current || streamRef.current !== stream) return;
        let detecting = false;
        const loop = () => {
          if (!streamRef.current || ticket !== requestRef.current) return;
          rafRef.current = requestAnimationFrame(loop);
          const current = videoRef.current, canvas = canvasRef.current;
          if (!current || !canvas || current.readyState < 2 || detecting) return;
          detecting = true;
          void detectLiveFrame(current, (performance.now() - liveStartRef.current) / 1000)
            .then(frame => { if (canvasRef.current === canvas) drawSkeleton(canvas, current, frame, true); })
            .catch(() => undefined)
            .finally(() => { detecting = false; });
        };
        loop();
      }).catch((cause: unknown) => { if (ticket === requestRef.current) setLiveNote(cause instanceof Error ? cause.message : 'The live skeleton is unavailable. You can still record and analyze.'); });
    } catch (cause) {
      if (ticket === requestRef.current) setError(cause instanceof DOMException && cause.name === 'NotAllowedError'
        ? 'Camera access was not allowed. Allow camera access for Still, then try again. Or use a video instead.'
        : cause instanceof Error ? cause.message : 'The camera could not be opened. Or use a video instead.');
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || recording !== null) return;
    const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    if (!mime) { setError('Recording is not supported in this browser. Record a video another way and use “Use a video”.'); return; }
    chunksRef.current = [];
    const generation = ++recordingGenRef.current;
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = event => { if (recordingGenRef.current === generation && event.data.size) chunksRef.current.push(event.data); };
    recorder.onstop = () => {
      if (recordingGenRef.current !== generation) return;
      const blob = new Blob(chunksRef.current, { type: mime });
      const recordedSeconds = (performance.now() - recordStartedRef.current) / 1000;
      stopCamera();
      if (!blob.size) { setStage('empty'); return; }
      adoptClip(URL.createObjectURL(blob), 'Camera take', true, recordedSeconds);
    };
    recorderRef.current = recorder;
    recorder.start(250);
    const started = performance.now();
    recordStartedRef.current = started;
    setRecording(0);
    recordTimerRef.current = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      setRecording(elapsed);
      if (elapsed >= MAX_CLIP_SECONDS) stopRecording();
    }, 250);
  }

  function stopRecording() {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  function applyDuration(seconds: number) {
    const usable = seconds > 0 ? seconds : fallbackDurationRef.current;
    if (usable > 0) { setDurationSec(usable); setTrimEnd(String(Number(Math.min(usable, MAX_CLIP_SECONDS).toFixed(2)))); }
  }

  function adoptClip(url: string, name: string, fromCamera: boolean, fallbackSeconds = 0) {
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    clipUrlRef.current = url;
    fallbackDurationRef.current = fallbackSeconds;
    setTake(null); setResult(null); onClear();
    setClipName(name); setStage('clip'); setTrimStart('0'); setTrimEnd('0'); setDurationSec(0);
    if (fromCamera) setMirror(true); // Match the mirrored preview you acted into.
    requestAnimationFrame(() => {
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = null;
      video.src = url;
      void resolveDuration(video).then(applyDuration);
    });
  }

  function chooseFile(file: File) {
    setError(null);
    if (file.size > 500 * 1024 * 1024) { setError('That video is over 500 MB. Trim it or export a smaller copy.'); return; }
    setMirror(false);
    adoptClip(URL.createObjectURL(file), file.name.replace(/\.[^.]+$/, ''), false);
  }

  async function analyze() {
    const video = videoRef.current;
    if (!video || stage !== 'clip' || busy) return;
    const start = Number(trimStart), end = Number(trimEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) { setError('Choose a start time before the end time.'); return; }
    if (end - start > MAX_CLIP_SECONDS) { setError(`Analyze up to ${MAX_CLIP_SECONDS} seconds at a time. Trim the clip first.`); return; }
    const ticket = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null); setAnalyzing(-1);
    try {
      await loadPoseLandmarker();
      const tracked = await analyzeVideo(video, { fps: Number(sampleFps) || 15, start, end, name: clipName || 'Motion capture' }, (fraction, frame) => {
        if (ticket !== requestRef.current) return;
        setAnalyzing(fraction);
        if (canvasRef.current) drawSkeleton(canvasRef.current, video, frame, false);
      }, controller.signal);
      if (ticket !== requestRef.current) return;
      setTake(tracked);
      setAnalyzing(null);
      preview(tracked);
    } catch (cause) {
      if (ticket === requestRef.current) {
        setAnalyzing(null);
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'This video could not be analyzed.');
      }
    }
  }

  function preview(withTake: MocapTake = take!) {
    if (!withTake || posing) return;
    const ticket = requestRef.current;
    const forTarget = target;
    onClear();
    setError(null); setPosing(true);
    // Let the posing label paint before the synchronous retarget runs.
    setTimeout(() => {
      if (ticket !== requestRef.current) { setPosing(false); return; }
      try {
        const posed = retargetMocap(forTarget, withTake, { mirror, travel, smoothing: smoothing / 100 });
        if (ticket !== requestRef.current) return;
        const next = { keys: posed.keys, duration: Math.max(posed.duration, 1 / 30), name: withTake.name, warnings: posed.warnings };
        setResult(next);
        setBlend(String(Math.min(0.15, next.duration / 2)));
        setOpen(false);
        onPreview(next.keys, next.duration, next.name);
      } catch (cause) {
        if (ticket === requestRef.current) setError(cause instanceof Error ? cause.message : 'Your character could not copy this motion.');
      } finally { setPosing(false); }
    }, 30);
  }

  function apply(mode: 'apply' | 'append') {
    if (!result || disabled || previewBlocked) { if (previewBlocked) setError('Replay this take before applying it.'); return; }
    const seconds = Math.min(Number(blend), result.duration / 2);
    if (mode === 'append' && (!Number.isFinite(seconds) || seconds < 0)) { setError('Enter a valid transition duration.'); return; }
    try {
      onApply(result.keys, result.duration, mode, mode === 'append' ? seconds : 0, result.name);
      clearTake();
      onClear();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This motion could not be applied.'); }
  }

  function discard() {
    clearTake();
    setError(null);
    onClear();
  }

  const analyzingLabel = analyzing === -1 ? 'Loading the tracker…' : analyzing !== null ? `Watching your video… ${Math.round(analyzing * 100)}%` : posing ? 'Posing your character…' : null;

  return <section className="sidebar-section motion-capture" aria-label="Motion Capture">
    <div className="section-heading"><h2>Motion Capture</h2><span className="tiny-badge">NEW</span></div>
    <p className="mocap-caption">Act it out on video. Your character copies you. It all runs on this device, nothing is uploaded.</p>
    {humanoid ? <div className="mocap-open-row">
      <button className="mocap-open" disabled={disabled} onClick={() => openDialog('video')}><Video size={14}/><span>Use a video</span></button>
      <button className="mocap-open" disabled={disabled} onClick={() => openDialog('camera')}><Camera size={14}/><span>Record myself</span></button>
    </div> : <p className="mocap-note">Motion capture copies a person, so it needs a two-legged character.</p>}
    {result && <div className="motion-actions mocap-result">
      <div className="motion-actions-heading"><strong>{result.name}</strong><button aria-label="Discard motion capture take" onClick={discard}><X size={13}/></button></div>
      <p>{result.duration.toFixed(1)}s · {result.keys.length} poses · {previewing ? 'previewing now' : previewBlocked ? 'another preview is playing' : 'preview ready'}</p>
      {result.warnings.map(warning => <p key={warning}>{warning}</p>)}
      {previewBlocked && <p>Replay this take before applying it.</p>}
      <button className="motion-replay" onClick={() => onPreview(result.keys, result.duration, result.name)}><Play size={12}/>Replay preview</button>
      <div className="motion-apply-buttons"><button disabled={disabled || previewBlocked} title={previewBlocked ? 'Replay this take before applying it' : undefined} onClick={() => apply('apply')}>Apply</button><button disabled={disabled || previewBlocked} title={previewBlocked ? 'Replay this take before applying it' : undefined} onClick={() => apply('append')}>Append</button></div>
      <label>Blend · seconds<input aria-label="Motion capture transition seconds" type="number" min="0" step="0.05" value={blend} onChange={event => setBlend(event.target.value)}/></label>
      <button className="mocap-adjust" onClick={() => { setError(null); setOpen(true); }}>Adjust mirror &amp; smoothing</button>
    </div>}
    {!open && error && <p className="motion-error" role="alert">{error}</p>}

    {open && <dialog ref={dialogRef} className="modal mocap-dialog" aria-label="Motion capture" onCancel={event => { event.preventDefault(); closeDialog(); }} onClick={event => { if (event.target === event.currentTarget) closeDialog(); }} onKeyDown={event => event.stopPropagation()}>
      <div className="modal-inner">
        <button className="icon-button mocap-close" aria-label="Close motion capture" disabled={analyzing !== null || recording !== null} onClick={closeDialog}><X size={19}/></button>
        <span className="modal-icon"><PersonStanding size={25}/></span>
        <div className="eyebrow">YOU MOVE. THEY MOVE.</div>
        <h2>Motion capture.</h2>
        <p>Give Still a video of one person, head to feet. <strong>{target.name}</strong> will copy the movement as best it can. Your video never leaves this device.</p>
        <div className="mocap-tabs" role="group" aria-label="Motion capture source">
          <button aria-pressed={source === 'video'} className={source === 'video' ? 'active' : ''} disabled={analyzing !== null || recording !== null} onClick={() => { stopCamera(true); if (stage === 'live') setStage('empty'); setSource('video'); }}><Video size={14}/>Use a video</button>
          <button aria-pressed={source === 'camera'} className={source === 'camera' ? 'active' : ''} disabled={analyzing !== null || recording !== null} onClick={() => setSource('camera')}><Camera size={14}/>Record myself</button>
        </div>

        <div className="mocap-stage">
          <video ref={videoRef} className={stage === 'live' ? 'mirrored' : ''} muted playsInline controls={stage === 'clip' && analyzing === null} onError={() => { if (stage === 'clip') setError('This video could not be opened here. Try an MP4 (H.264) or WebM file.'); }}/>
          <canvas ref={canvasRef} aria-hidden="true"/>
          {stage === 'empty' && <div className="mocap-stage-empty">
            {source === 'video'
              ? <><Video size={26}/><strong>Choose a video of your performance.</strong><span>Phone videos work great. Full body in frame, plain background helps.</span><button className="button secondary" onClick={() => fileRef.current?.click()}>Choose video</button></>
              : <><Camera size={26}/><strong>Getting your camera…</strong><span>Step back until your whole body fits, head to feet.</span></>}
          </div>}
          {stage === 'live' && <div className="mocap-livebar">
            {recording === null
              ? <button className="button primary" onClick={startRecording}><span className="mocap-rec-dot"/>Record</button>
              : <><span className="mocap-rec-time"><span className="mocap-rec-dot blinking"/>{recording.toFixed(1)}s</span><button className="button primary" onClick={stopRecording}><Square size={13}/>Stop</button></>}
          </div>}
          {analyzing !== null && <div className="mocap-progress"><progress max="1" value={Math.max(0, analyzing)} aria-label="Analysis progress"/><span>{analyzingLabel}</span></div>}
        </div>
        <input ref={fileRef} type="file" accept="video/*,.mov,.m4v" hidden aria-label="Performance video" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) chooseFile(file); }}/>
        {liveNote && stage === 'live' && <p className="micro-copy mocap-live-note">{liveNote}</p>}
        {stage === 'live' && recording === null && <p className="micro-copy">The skeleton is what Still sees. When it sticks to you, hit Record and act it out.</p>}

        {stage === 'clip' && <>
          <div className="mocap-clip-row"><strong>{clipName || 'Your clip'}</strong><span>{durationSec > 0 ? `${durationSec.toFixed(1)}s` : 'Reading…'}</span>
            {source === 'video' && <button className="text-button" disabled={busy} onClick={() => fileRef.current?.click()}>Choose a different video</button>}
            {source === 'camera' && <button className="text-button" disabled={busy} onClick={() => { clearTake(); onClear(); }}>Record again</button>}
          </div>
          <div className="mocap-options">
            <label>Start · sec<input aria-label="Analyze from seconds" type="number" min="0" step="0.1" value={trimStart} disabled={busy} onChange={event => setTrimStart(event.target.value)}/></label>
            <label>End · sec<input aria-label="Analyze to seconds" type="number" min="0" step="0.1" value={trimEnd} disabled={busy} onChange={event => setTrimEnd(event.target.value)}/></label>
            <label>Sample rate<select aria-label="Sample rate" value={sampleFps} disabled={busy} onChange={event => setSampleFps(event.target.value)}>
              <option value="10">10 / sec · fewer poses</option>
              <option value="15">15 / sec · balanced</option>
              <option value="30">30 / sec · most detail</option>
            </select></label>
            <label className="mocap-smoothing">Smoothing · {smoothing}%<input aria-label="Smoothing" type="range" min="0" max="100" step="5" value={smoothing} disabled={busy} onChange={event => setSmoothing(Number(event.target.value))}/></label>
            <label className="mocap-check"><input type="checkbox" checked={mirror} disabled={busy} onChange={event => setMirror(event.target.checked)}/><FlipHorizontal2 size={13}/>Mirror <small>for selfie videos that look flipped</small></label>
            <label className="mocap-check"><input type="checkbox" checked={travel} disabled={busy} onChange={event => setTravel(event.target.checked)}/><Footprints size={13}/>Move across the floor <small>side to side, like in the video</small></label>
          </div>
          {take && <p className="micro-copy">Found you in {take.detected} of {take.frames.length} moments ({take.duration.toFixed(1)}s). Mirror, smoothing and floor travel can change without re-analyzing.</p>}
        </>}

        {error && <p className="mocap-error" role="alert">{error}</p>}
        {analyzing !== null
          ? <button className="button secondary full-width" onClick={() => abortRef.current?.abort()}>Cancel analysis</button>
          : stage === 'clip' && (take
            ? <div className="mocap-analyze-row"><button className="button primary" disabled={busy || durationSec <= 0} onClick={() => preview()}>{posing ? <LoaderCircle size={15} className="spin"/> : <PersonStanding size={15}/>}Preview on my character</button><button className="button secondary" disabled={busy || durationSec <= 0} onClick={() => void analyze()}>Analyze again</button></div>
            : <button className="button primary full-width" disabled={busy || durationSec <= 0} onClick={() => void analyze()}>{posing ? <LoaderCircle size={15} className="spin"/> : <PersonStanding size={15}/>}Analyze my motion</button>)}
        <p className="micro-copy">Best results: one person, whole body visible, steady camera. Fast spins, floor work and walking toward the camera are copied loosely. You can fix any pose after applying, and Undo always restores your take.</p>
      </div>
    </dialog>}
  </section>;
}
