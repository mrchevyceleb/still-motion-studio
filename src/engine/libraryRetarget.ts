import type { CharacterAsset } from '../types';
import { suggestBoneMapping } from './retarget';

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

function demoHumanRole(name: string): string | null {
  const n = key(name);
  if (n === 'pelvis' || n === 'hips') return 'Hips';
  if (n === 'spine01' || n === 'spine') return 'Spine';
  if (n === 'spine03' || n === 'chest') return 'Spine1';
  if (n === 'neck01' || n === 'neck') return 'Neck';
  if (n === 'head') return 'Head';
  const side = n.endsWith('l') ? 'Left' : n.endsWith('r') ? 'Right' : null;
  if (!side) return null;
  const limb = n.slice(0, -1);
  const aliases: Record<string, string> = {
    clavicle: 'Shoulder', upperarm: 'Arm', lowerarm: 'ForeArm', hand: 'Hand',
    thigh: 'UpLeg', calf: 'Leg', foot: 'Foot', ball: 'ToeBase',
  };
  return aliases[limb] ? side + aliases[limb] : null;
}

function demoQuadrupedRole(name: string): string | null {
  const n = key(name);
  if (n === 'hips') return 'Hips';
  if (n === 'spine1') return 'Spine';
  if (n === 'spine4' || n === 'spine6') return 'Neck';
  if (n === 'head') return 'Head';
  if (n === 'tailbase' || n === 'tail1') return 'Tail';
  if (n === 'tailend' || n === 'tail4') return 'TailTip';
  const side = n.endsWith('l') ? 'Left' : n.endsWith('r') ? 'Right' : null;
  if (!side) return null;
  const base = n.slice(0, -1);
  const pair = base.startsWith('front') ? 'Front' : base.startsWith('back') ? 'Hind' : null;
  if (!pair) return null;
  if (/legupper|humerus/.test(base)) return `${pair}${side}UpperLeg`;
  if (/leglower/.test(base)) return `${pair}${side}LowerLeg`;
  if (/legfoot/.test(base)) return `${pair}${side}Foot`;
  return null;
}

export function suggestLibraryMapping(target: CharacterAsset, source: CharacterAsset): number[] {
  const proposed = suggestBoneMapping(target, source);
  if (target.source !== 'demo') return proposed;
  const aliases = target.kind === 'humanoid' ? demoHumanRole : target.kind === 'quadruped' ? demoQuadrupedRole : () => null;
  const targetNames = new Map(target.bones.map((bone, index) => [bone.name, index]));
  const used = new Set(proposed.filter(index => index >= 0));
  source.bones.forEach((bone, index) => {
    if (proposed[index] >= 0) return;
    const role = aliases(bone.name);
    const targetIndex = role ? targetNames.get(role) : undefined;
    if (targetIndex !== undefined && !used.has(targetIndex)) { proposed[index] = targetIndex; used.add(targetIndex); }
  });
  return proposed;
}

export function mappingReady(target: CharacterAsset, mapping: number[]): boolean {
  const mapped = new Set(mapping.filter(index => index >= 0).map(index => target.bones[index]?.name));
  if (target.source !== 'demo') return false;
  const required = target.kind === 'humanoid'
    ? ['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot']
    : target.kind === 'quadruped'
      ? ['Hips', 'Spine', 'Head', ...['Front', 'Hind'].flatMap(pair => ['Left', 'Right'].flatMap(side => [`${pair}${side}UpperLeg`, `${pair}${side}LowerLeg`, `${pair}${side}Foot`]))]
      : [];
  return required.length > 0 && required.every(name => mapped.has(name));
}
