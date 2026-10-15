import type { CharacterAsset, ProjectDocument } from '../types';

const DATABASE = 'still-motion-studio';
const STORE = 'projects';
let saveQueue = Promise.resolve();
export interface ArchiveEntry { id: string; name: string; updatedAt: number }
export interface SceneEntry extends ArchiveEntry { createdAt: number; duration: number; keyCount: number; kind: CharacterAsset['kind']; thumbnail?: string; revision?: number }
export interface SceneWriteToken { id: string; revision: number }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function enqueue<T>(write: () => Promise<T>): Promise<T> {
  const task = saveQueue.catch(() => {}).then(write);
  saveQueue = task.then(() => {}, () => {});
  return task;
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('The scene could not be saved.'));
      try { action(transaction.objectStore(STORE), value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  } finally { db.close(); }
}

function readValue<T>(key: string): Promise<T> {
  return withStore('readonly', (store, done) => {
    const request = store.get(key);
    request.onsuccess = () => done(request.result);
  });
}

function sceneEntry(document: ProjectDocument, id: string, previous?: SceneEntry, thumbnail?: string): SceneEntry {
  return { id, name: document.name.trim() || 'Untitled', createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(), duration: document.duration, keyCount: document.keys.length, kind: document.character.kind, thumbnail: thumbnail ?? previous?.thumbnail };
}

/** Current recovery slot and permanent library entry commit together, or neither does. */
export function saveLocal(document: ProjectDocument, sceneId?: string, thumbnail?: string, token?: SceneWriteToken): Promise<{ id: string; revision: number; forked: boolean }> {
  const snapshot = structuredClone(document);
  return enqueue(async () => {
    const result = await withStore<{ id: string; revision: number; forked: boolean }>('readwrite', (store, done) => {
    const current = store.get('current-scene-id');
    current.onsuccess = () => {
      const index = store.get('scene-index');
      index.onsuccess = () => {
        const entries: SceneEntry[] = index.result ?? [];
        const requestedId = token?.id ?? sceneId ?? current.result ?? crypto.randomUUID();
        const previous = entries.find(entry => entry.id === requestedId);
        const forked = !!token && (previous?.revision ?? 0) !== token.revision;
        const id = forked ? crypto.randomUUID() : requestedId;
        const revision = forked ? 1 : (previous?.revision ?? 0) + 1;
        store.put(snapshot, 'current');
        store.put(id, 'current-scene-id');
        store.put(snapshot, `scene:${id}`);
        store.put([{ ...sceneEntry(snapshot, id, forked ? undefined : previous, thumbnail), revision }, ...entries.filter(entry => entry.id !== id)], 'scene-index');
        done({ id, revision, forked });
      };
    };
    });
    // Tokens follow a conflict copy so already-queued writes from this window stay together.
    if (token) { token.id = result.id; token.revision = result.revision; }
    return result;
  });
}

export async function loadSession(): Promise<{ document?: ProjectDocument; sceneId: string; revision: number }> {
  return withStore('readonly', (store, done) => {
    const document = store.get('current');
    const id = store.get('current-scene-id');
    const index = store.get('scene-index');
    index.onsuccess = () => done({ document: document.result, sceneId: id.result ?? crypto.randomUUID(), revision: (index.result as SceneEntry[] | undefined)?.find(entry => entry.id === id.result)?.revision ?? 0 });
  });
}

export async function listScenes(): Promise<SceneEntry[]> {
  return (await readValue<SceneEntry[] | undefined>('scene-index') ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readScene(id: string): Promise<{ document: ProjectDocument; revision: number }> {
  const result = await withStore<{ document: unknown; revision: number }>('readonly', (store, done) => {
    const document = store.get(`scene:${id}`), index = store.get('scene-index');
    index.onsuccess = () => done({ document: document.result, revision: (index.result as SceneEntry[] | undefined)?.find(entry => entry.id === id)?.revision ?? 0 });
  });
  return { document: validateProject(result.document), revision: result.revision };
}

/** Change a saved scene without loading it into the editor. */
export function editScene(id: string, change: 'rename' | 'duplicate' | 'delete', name?: string): Promise<number | undefined> {
  const title = name?.trim();
  if (change === 'rename' && (!title || title.length > 200)) return Promise.reject(new Error('Give this scene a name of 1–200 characters.'));
  return enqueue(() => withStore<number | undefined>('readwrite', (store, done) => {
    const index = store.get('scene-index');
    const current = store.get('current-scene-id');
    const document = store.get(`scene:${id}`);
    document.onsuccess = () => {
      const entries: SceneEntry[] = index.result ?? [];
      const previous = entries.find(entry => entry.id === id);
      if (!previous || !document.result || (change === 'delete' && current.result === id)) { store.transaction.abort(); return; }
      if (change === 'delete') {
        store.delete(`scene:${id}`);
        store.put(entries.filter(entry => entry.id !== id), 'scene-index');
      } else {
        const nextId = change === 'duplicate' ? crypto.randomUUID() : id;
        const next = { ...document.result, name: title ?? `${previous.name.slice(0, 193)} (copy)` };
        const revision = change === 'duplicate' ? 1 : (previous.revision ?? 0) + 1;
        store.put(next, `scene:${nextId}`);
        store.put([{ ...sceneEntry(next, nextId, change === 'duplicate' ? undefined : previous, previous.thumbnail), revision }, ...entries.filter(entry => entry.id !== nextId)], 'scene-index');
        if (current.result === id && change === 'rename') store.put(next, 'current');
        done(revision);
      }
    };
  }));
}

export function archiveLocal(document: ProjectDocument): Promise<void> {
  const task = saveQueue.catch(() => {}).then(() => writeArchive(document));
  saveQueue = task;
  return task;
}

export async function loadLocal(): Promise<ProjectDocument | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function listArchives(): Promise<ArchiveEntry[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('archive-index');
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/** Keep the last five replaced scenes, independently of the current recovery slot. */
async function writeArchive(document: ProjectDocument): Promise<void> {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = store.get('archive-index');
        request.onsuccess = () => {
          const entries: ArchiveEntry[] = request.result ?? [];
          const entry = { id: crypto.randomUUID(), name: document.name || 'Untitled', updatedAt: Date.now() };
          const next = [entry, ...entries];
          store.put(document, `archive:${entry.id}`);
          store.put(next.slice(0, 5), 'archive-index');
          next.slice(5).forEach(old => store.delete(`archive:${old.id}`));
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
}

export async function readArchive(id: string): Promise<ProjectDocument> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(`archive:${id}`);
      request.onsuccess = () => { try { resolve(validateProject(request.result)); } catch (error) { reject(error); } };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export function embedCharacter(asset: CharacterAsset): ProjectDocument['character'] {
  return asset.source === 'demo'
    ? { type: 'demo', kind: asset.kind }
    : { type: 'embedded', object: asset.root.toJSON(), kind: asset.kind, name: asset.name };
}

export function validateProject(input: unknown): ProjectDocument {
  if (!input || typeof input !== 'object') throw new Error('This is not a Still project.');
  const data = input as ProjectDocument;
  if (data.version !== 1 || typeof data.name !== 'string' || data.name.length > 200 ||
      !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 600 ||
      !Number.isInteger(data.fps) || data.fps < 1 || data.fps > 120 ||
      !Array.isArray(data.boneNames) || !data.boneNames.every(n => typeof n === 'string') ||
      (data.sourceClip != null && (!Number.isInteger(data.sourceClip) || data.sourceClip < 0)) ||
      !Array.isArray(data.keys) || !data.keys.length || data.keys.length > 72001 ||
      !data.character || !['demo', 'embedded'].includes(data.character.type) ||
      !['humanoid', 'quadruped', 'creature'].includes(data.character.kind) || (data.character.type === 'demo' && data.character.kind === 'creature') || !data.settings ||
      !['smooth', 'linear', 'stepped'].includes(data.settings.interpolation) ||
      typeof data.settings.floorContact !== 'boolean' ||
      !Number.isFinite(data.settings.gravity) || data.settings.gravity < 0 || data.settings.gravity > 30 ||
      !Number.isFinite(data.settings.strength) || data.settings.strength < 0 || data.settings.strength > 1) {
    throw new Error('This project is incomplete or uses an unsupported format.');
  }
  if (data.generated !== undefined && (!Array.isArray(data.generated) || data.generated.length < 2 || data.generated.length > 72001)) throw new Error('This project contains invalid generated motion.');
  if (data.generation !== undefined && (!data.generation || typeof data.generation.name !== 'string' || !['inbetween', 'physics'].includes(data.generation.kind) || !data.generation.metrics || typeof data.generation.metrics !== 'object' || !Array.isArray(data.generation.warnings) || !data.generation.warnings.every(w => typeof w === 'string'))) throw new Error('This project contains invalid generation details.');
  const comparison = data.generation?.comparison;
  if (comparison !== undefined && (!comparison || data.generation?.kind !== 'physics' || !data.generated || !Array.isArray(comparison.before) || comparison.before.length < 1 || comparison.before.length > 72001 || !['smooth', 'linear', 'stepped'].includes(comparison.interpolation))) throw new Error('This project contains an invalid physics comparison.');
  for (const sequence of [data.keys, ...(data.generated ? [data.generated] : []), ...(comparison ? [comparison.before] : [])]) {
   const times = new Set<number>();
   const ids = new Set<string>();
   for (const key of sequence) {
    if (key.morphs !== undefined && (!key.morphs || typeof key.morphs !== 'object' || Array.isArray(key.morphs) ||
        Object.entries(key.morphs).some(([name, value]) => !name || typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new Error('This project contains invalid morph values.');
    }
    if (typeof key.id !== 'string' || ids.has(key.id) || !Number.isFinite(key.time) || key.time < 0 || key.time > data.duration + 0.001 ||
        times.has(key.time) || !Array.isArray(key.pose) || key.pose.length !== data.boneNames.length ||
        key.pose.some(bone => !bone || ![bone.position, bone.quaternion, bone.scale].every((a, i) =>
          Array.isArray(a) && a.length === (i === 1 ? 4 : 3) && a.every(Number.isFinite)))) {
      throw new Error('This project contains invalid pose data.');
    }
    ids.add(key.id); times.add(key.time);
   }
  }
  return { ...data, keys: [...data.keys].sort((a, b) => a.time - b.time), generated: data.generated ? [...data.generated].sort((a, b) => a.time - b.time) : undefined, generation: comparison ? { ...data.generation!, comparison: { ...comparison, before: [...comparison.before].sort((a, b) => a.time - b.time) } } : data.generation };
}

export function downloadFile(contents: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
