import type { ProjectDocument, RigKind } from '../types';

export interface CharacterEntry {
  id: string;
  name: string;
  kind: RigKind;
  boneCount: number;
  createdAt: number;
  fingerprint: string;
  thumbnail?: string;
}
export interface SavedCharacter extends CharacterEntry {
  model: ProjectDocument['character'];
  boneNames: string[];
}

const fingerprints = new WeakMap<object, { bones: string; value: string }>();

/** Ignore animation state and serialization IDs, while retaining mesh, skin and bind rig. */
export function characterFingerprint(model: ProjectDocument['character'], boneNames: string[]): string {
  const cached = fingerprints.get(model);
  const bones = JSON.stringify(boneNames);
  if (cached?.bones === bones) return cached.value;
  const ids = new Map<string, string>();
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.uuid === 'string' && !ids.has(object.uuid)) ids.set(object.uuid, `id:${ids.size}`);
    Object.keys(object).sort().filter(key => key !== 'animations' && key !== 'metadata').forEach(key => collect(object[key]));
  }
  collect(model);
  let a = 2166136261, b = 3339675911, length = 0;
  const feed = (text: string) => {
    length += text.length;
    for (let index = 0; index < text.length; index++) {
      a = Math.imul(a ^ text.charCodeAt(index), 16777619);
      b = Math.imul(b ^ text.charCodeAt(index), 2246822519);
    }
  };
  // Stream into the hash: no second model tree or giant JSON string during migration.
  function visit(value: unknown): void {
    if (typeof value === 'string') { const text = ids.get(value) ?? value; feed(`s${text.length}:`); feed(text); return; }
    if (!value || typeof value !== 'object') { feed(`${typeof value}:${String(value)};`); return; }
    if (Array.isArray(value)) { feed(`[${value.length}:`); value.forEach(visit); feed(']'); return; }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort().filter(key =>
      key !== 'animations' && key !== 'metadata' && key !== 'warnings' && key !== 'height' &&
      !(object.type === 'Bone' && ['matrix', 'position', 'quaternion', 'rotation', 'scale'].includes(key)) &&
      key !== 'morphTargetInfluences' && !(object === model && key === 'name')
    );
    feed(`{${keys.length}:`);
    for (const key of keys) { feed(`${key.length}:${key}`); visit(object[key]); }
    feed('}');
  }
  visit(model); feed(bones);
  const fingerprint = `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${length}`;
  fingerprints.set(model, { bones, value: fingerprint });
  return fingerprint;
}

export function characterEntry(document: ProjectDocument, id: string, thumbnail?: string): SavedCharacter {
  const model = document.character;
  return {
    id, name: model.type === 'embedded' ? model.name.trim().slice(0, 200) || 'My character' : model.kind === 'humanoid' ? 'Practice partner' : 'Four-legged friend',
    kind: model.kind, boneCount: document.boneNames.length, createdAt: Date.now(),
    fingerprint: characterFingerprint(model, document.boneNames), thumbnail,
    model, boneNames: document.boneNames,
  };
}
