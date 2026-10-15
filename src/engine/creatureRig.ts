import { Box3, Vector3 } from 'three';
import type { AnatomicalFit, RigJointSpec } from './anatomicalRig';
import type { Vec3 } from '../types';

export type CreatureShape = 'hydra' | 'serpent' | 'tentacles';
export interface CreatureRigOptions { shape: CreatureShape; chains: number; segments: number }
export const DEFAULT_CREATURE_RIG: CreatureRigOptions = { shape: 'hydra', chains: 3, segments: 5 };

/** Editable geometric seeds, deliberately independent of legs or human landmarks. */
export function fitCreatureRig(vertices: Vector3[], bounds: Box3, options = DEFAULT_CREATURE_RIG): AnatomicalFit {
  const { shape, chains, segments } = options;
  if (!['hydra', 'serpent', 'tentacles'].includes(shape) || !Number.isInteger(chains) || chains < 1 || chains > 8 || !Number.isInteger(segments) || segments < 2 || segments > 10) throw new Error('Choose 1–8 chains and 2–10 joints per chain.');
  const size = bounds.getSize(new Vector3()), center = bounds.getCenter(new Vector3());
  if (bounds.isEmpty() || !size.toArray().every(Number.isFinite) || size.y < 1e-6) throw new Error('A creature mesh with usable height is needed.');
  const joints: RigJointSpec[] = [];
  const add = (name: string, parent: string | undefined, position: Vector3) => joints.push({ name, ...(parent ? { parent } : {}), position: position.toArray() as Vec3 });
  const point = (x: number, y: number, z: number) => new Vector3(center.x + x * size.x, bounds.min.y + y * size.y, center.z + z * size.z);
  add('Root', undefined, point(0, .12, 0));
  add('Body', 'Root', point(0, shape === 'tentacles' ? .72 : .32, 0));
  const count = shape === 'serpent' ? 1 : chains;
  for (let branch = 0; branch < count; branch++) {
    const lane = count === 1 ? 0 : (branch / (count - 1) - .5) * .78;
    let parent = 'Body';
    for (let i = 0; i < segments; i++) {
      const t = (i + 1) / segments;
      let p: Vector3;
      if (shape === 'tentacles') {
        const angle = 2 * Math.PI * branch / count;
        p = point(Math.cos(angle) * .43 * t, .72 - .62 * t, Math.sin(angle) * .43 * t);
      } else {
        p = point(lane * (.3 + .7 * t), .32 + .57 * t, 0);
        // Follow the local section in depth; the preview is authoritative for
        // bent necks, overlapping heads and surfaces without distinct branches.
        const band = vertices.filter(v => Math.abs(v.y - p.y) < size.y * .055 && Math.abs(v.x - p.x) < size.x / Math.max(4, count * 2));
        if (band.length > 5) {
          const z = band.map(v => v.z).sort((a, b) => a - b);
          p.z = z[Math.floor(z.length / 2)];
        }
      }
      const name = `Chain${branch + 1}_${i === segments - 1 && shape !== 'tentacles' ? 'Head' : `Joint${i + 1}`}`;
      add(name, parent, p); parent = name;
    }
    if (shape !== 'tentacles') {
      const head = new Vector3().fromArray(joints[joints.length - 1].position);
      // Each head has a separate jaw hinge and endpoint; both can be repositioned.
      const jaw = head.clone().add(new Vector3(0, -size.y * .045, size.z * .06));
      add(`Chain${branch + 1}_Jaw`, parent, jaw);
      add(`Chain${branch + 1}_JawTip`, `Chain${branch + 1}_Jaw`, jaw.clone().add(new Vector3(0, -size.y * .015, size.z * .12)));
    }
  }
  return { joints, diagnostics: {
    version: 1, method: 'creature-chains', bodyType: 'creature', evidence: 'limited', reviewRequired: true,
    sampledVertices: vertices.length, measurements: { chains: count, segments },
    warnings: ['Creature joints are editable estimates. Place every chain and jaw inside its matching part before binding.', 'Automatic distance weights can need cleanup where heads or tentacles overlap. Test each branch separately.'],
  } };
}
