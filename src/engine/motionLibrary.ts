import type { CharacterAsset } from '../types';

export interface MotionClipRecord { name: string; duration: number; index: number }
export interface PersonalMotion { id: string; filename: string; provider: 'My Motions' | 'Mixamo' | 'Meshy'; body: CharacterAsset['kind']; addedAt: number; size: number; clips: MotionClipRecord[] }
export interface PendingMeshyTask { id: string; type: 'rigging' | 'animations' | 'text-to-motion'; name: string; status: string; createdAt: number; rigId?: string; actionId?: number; targetRig?: string; expiresAt?: number }

const DATABASE = 'still-motion-library';
const STORES = ['sources', 'entries', 'mappings', 'tasks'] as const;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('The motion library could not save this change.'));
      try { action(tx, result => { value = result; }); } catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export async function motionHash(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function listPersonalMotions(): Promise<PersonalMotion[]> {
  return transaction(['entries'], 'readonly', (tx, done) => {
    const request = tx.objectStore('entries').getAll();
    request.onsuccess = () => done((request.result as PersonalMotion[]).sort((a, b) => b.addedAt - a.addedAt));
  });
}

/** Save the original bytes and all clip metadata in one transaction. */
export async function addPersonalMotion(file: File, clips: MotionClipRecord[], body: CharacterAsset['kind'], provider: PersonalMotion['provider'] = 'My Motions'): Promise<PersonalMotion> {
  if (!clips.length) throw new Error('This file has no animation clips.');
  const id = await motionHash(file);
  const entry: PersonalMotion = { id, filename: file.name, provider, body, addedAt: Date.now(), size: file.size, clips };
  return transaction(['sources', 'entries'], 'readwrite', (tx, done) => {
    const existing = tx.objectStore('entries').get(id);
    existing.onsuccess = () => {
      if (existing.result) { done(existing.result as PersonalMotion); return; }
      try {
        tx.objectStore('sources').put(file, id);
        tx.objectStore('entries').put(entry, id);
        done(entry);
      } catch { tx.abort(); }
    };
  });
}

export function readPersonalMotion(entry: PersonalMotion): Promise<File> {
  return transaction(['sources'], 'readonly', (tx, done) => {
    const request = tx.objectStore('sources').get(entry.id);
    request.onsuccess = () => {
      if (!request.result) { tx.abort(); return; }
      done(new File([request.result as Blob], entry.filename));
    };
  });
}

export function removePersonalMotion(id: string): Promise<void> {
  return transaction(['sources', 'entries'], 'readwrite', (tx, done) => {
    tx.objectStore('sources').delete(id);
    tx.objectStore('entries').delete(id);
    done();
  });
}

export function rigFingerprint(asset: CharacterAsset): string {
  return JSON.stringify(asset.bones.map((bone, i) => [bone.name, asset.bones.indexOf(bone.parent as typeof bone), ...asset.restPose[i].position.map(value => Number(value.toFixed(4)))]));
}

export function readMotionMapping(source: CharacterAsset, target: CharacterAsset): Promise<number[] | undefined> {
  return transaction(['mappings'], 'readonly', (tx, done) => {
    const request = tx.objectStore('mappings').get(`${rigFingerprint(source)}=>${rigFingerprint(target)}`);
    request.onsuccess = () => done(request.result as number[] | undefined);
  });
}

export function saveMotionMapping(source: CharacterAsset, target: CharacterAsset, mapping: number[]): Promise<void> {
  return transaction(['mappings'], 'readwrite', (tx, done) => {
    tx.objectStore('mappings').put([...mapping], `${rigFingerprint(source)}=>${rigFingerprint(target)}`);
    done();
  });
}

export function listMeshyTasks(): Promise<PendingMeshyTask[]> {
  return transaction(['tasks'], 'readonly', (tx, done) => {
    const request = tx.objectStore('tasks').getAll();
    request.onsuccess = () => done((request.result as PendingMeshyTask[]).sort((a, b) => b.createdAt - a.createdAt));
  });
}

export function saveMeshyTask(task: PendingMeshyTask): Promise<void> {
  return transaction(['tasks'], 'readwrite', (tx, done) => { tx.objectStore('tasks').put(task, task.id); done(); });
}

export function removeMeshyTask(id: string): Promise<void> {
  return transaction(['tasks'], 'readwrite', (tx, done) => { tx.objectStore('tasks').delete(id); done(); });
}
