import type { CharacterAsset, ProjectDocument } from '../types';

const DATABASE = 'still-motion-studio';
const STORE = 'projects';
let saveQueue = Promise.resolve();
export interface ArchiveEntry { id: string; name: string; updatedAt: number }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function saveLocal(document: ProjectDocument): Promise<void> {
  const task = saveQueue.catch(() => {}).then(() => writeLocal(document));
  saveQueue = task;
  return task;
}

async function writeLocal(document: ProjectDocument): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(document, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
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
export function archiveLocal(document: ProjectDocument): Promise<void> {
  const task = saveQueue.catch(() => {}).then(async () => {
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
  });
  saveQueue = task;
  return task;
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
      !['humanoid', 'quadruped'].includes(data.character.kind) || !data.settings ||
      !['smooth', 'linear', 'stepped'].includes(data.settings.interpolation) ||
      typeof data.settings.floorContact !== 'boolean' ||
      !Number.isFinite(data.settings.gravity) || data.settings.gravity < 0 || data.settings.gravity > 30 ||
      !Number.isFinite(data.settings.strength) || data.settings.strength < 0 || data.settings.strength > 1) {
    throw new Error('This project is incomplete or uses an unsupported format.');
  }
  if (data.generated !== undefined && (!Array.isArray(data.generated) || data.generated.length < 2 || data.generated.length > 72001)) throw new Error('This project contains invalid generated motion.');
  if (data.generation !== undefined && (!data.generation || typeof data.generation.name !== 'string' || !['inbetween', 'physics'].includes(data.generation.kind) || !data.generation.metrics || typeof data.generation.metrics !== 'object' || !Array.isArray(data.generation.warnings) || !data.generation.warnings.every(w => typeof w === 'string'))) throw new Error('This project contains invalid generation details.');
  for (const sequence of [data.keys, ...(data.generated ? [data.generated] : [])]) {
   const times = new Set<number>();
   const ids = new Set<string>();
   for (const key of sequence) {
    if (typeof key.id !== 'string' || ids.has(key.id) || !Number.isFinite(key.time) || key.time < 0 || key.time > data.duration + 0.001 ||
        times.has(key.time) || !Array.isArray(key.pose) || key.pose.length !== data.boneNames.length ||
        key.pose.some(bone => !bone || ![bone.position, bone.quaternion, bone.scale].every((a, i) =>
          Array.isArray(a) && a.length === (i === 1 ? 4 : 3) && a.every(Number.isFinite)))) {
      throw new Error('This project contains invalid pose data.');
    }
    ids.add(key.id); times.add(key.time);
   }
  }
  return { ...data, keys: [...data.keys].sort((a, b) => a.time - b.time), generated: data.generated ? [...data.generated].sort((a, b) => a.time - b.time) : undefined };
}

export function downloadFile(contents: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
