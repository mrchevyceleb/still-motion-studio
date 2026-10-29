import type { CharacterAsset } from '../types';
import { suggestBoneMapping } from './retarget';

const unprefix = (name: string) => name.replace(/^.*[|:]/, '').replace(/^(?:(?:mixamorig\d*|cc_base)[_ -]?|bip\d+[_ -]?|def[_ -])/i, '');
const key = (name: string) => unprefix(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function demoHumanRole(name: string): string | null {
  const numberedSpine = unprefix(name).match(/^spine[_ -]0?([123])$/i);
  if (numberedSpine) return ['Spine', 'Spine1', 'Spine2'][Number(numberedSpine[1]) - 1];
  const n = key(name);
  const standard = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', ...['Left', 'Right'].flatMap(side => ['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase'].map(part => side + part))];
  const direct = standard.find(role => role.toLowerCase() === n);
  if (direct) return direct;
  if (n === 'pelvis' || n === 'hips') return 'Hips';
  if (n === 'spine01' || n === 'spine') return 'Spine';
  if (n === 'chest') return 'Spine1';
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
  const aliases = target.kind === 'humanoid' ? demoHumanRole : target.source === 'demo' && target.kind === 'quadruped' ? demoQuadrupedRole : () => null;
  const targetRoles = new Map<string, number[]>();
  target.bones.forEach((bone, index) => {
    const role = target.kind === 'humanoid' ? demoHumanRole(bone.name) : bone.name;
    if (role) targetRoles.set(role, [...(targetRoles.get(role) ?? []), index]);
  });
  // Match named humanoid roles before generic name matching: spine_02 is
  // the second spine joint, while Mixamo's Spine2 is the third.
  if (target.kind === 'humanoid') source.bones.forEach((bone, index) => {
    if (aliases(bone.name)) proposed[index] = -1;
  });
  const used = new Set(proposed.filter(index => index >= 0));
  const shortSpine = target.kind === 'humanoid' && !targetRoles.has('Spine2') && targetRoles.get('Spine1')?.length === 1 && source.bones.some(bone => aliases(bone.name) === 'Spine2');
  source.bones.forEach((bone, index) => {
    if (proposed[index] >= 0) return;
    let role = aliases(bone.name);
    if (shortSpine && role === 'Spine1') return;
    if (shortSpine && role === 'Spine2') role = 'Spine1';
    const candidates = role ? targetRoles.get(role) : undefined;
    const targetIndex = candidates?.length === 1 ? candidates[0] : undefined;
    if (targetIndex !== undefined && !used.has(targetIndex)) { proposed[index] = targetIndex; used.add(targetIndex); }
  });
  return proposed;
}

export function mappingReady(target: CharacterAsset, mapping: number[]): boolean {
  const mapped = new Set(mapping.filter(index => index >= 0).map(index => target.kind === 'humanoid' ? demoHumanRole(target.bones[index]?.name ?? '') : target.bones[index]?.name));
  if (target.kind !== 'humanoid' && target.source !== 'demo') return false;
  const required = target.kind === 'humanoid'
    ? ['Hips', 'Spine', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot']
    : target.kind === 'quadruped'
      ? ['Hips', 'Spine', 'Head', ...['Front', 'Hind'].flatMap(pair => ['Left', 'Right'].flatMap(side => [`${pair}${side}UpperLeg`, `${pair}${side}LowerLeg`, `${pair}${side}Foot`]))]
      : [];
  return required.length > 0 && required.every(name => mapped.has(name));
}

/** Corresponding landmarks let the retargeter align characters facing different directions. */
export function libraryAlignment(target: CharacterAsset, mapping: number[]): { source: number[]; target: number[]; limbs: number[]; next: [number, number][]; ends: number[]; handSides: [number, number, number][] } | undefined {
  if (target.kind !== 'humanoid') return undefined;
  const roles = ['LeftArm', 'RightArm'];
  const targetIndices = roles.map(role => mapping.find(index => index >= 0 && demoHumanRole(target.bones[index].name) === role) ?? -1);
  const sourceIndices = targetIndices.map(index => mapping.indexOf(index));
  const roleIndex = (role: string) => mapping.find(index => index >= 0 && demoHumanRole(target.bones[index].name) === role) ?? -1;
  const chains = ['Left', 'Right'].flatMap(side => [['Arm', 'ForeArm', 'Hand'], ['UpLeg', 'Leg', 'Foot', 'ToeBase']].map(parts => parts.map(part => roleIndex(side + part))));
  const limbs = chains.map(chain => chain.find(index => index >= 0) ?? -1).filter(index => index >= 0);
  const next: [number, number][] = chains.flatMap(chain => chain.slice(0, -1).flatMap((index, i) => index >= 0 && chain[i + 1] >= 0 ? [[index, chain[i + 1]] as [number, number]] : []));
  const handSides: [number, number, number][] = [];
  for (const side of ['Left', 'Right']) {
    const hand = roleIndex(side + 'Hand');
    if (hand < 0) continue;
    const fingerFor = (part: string) => mapping.find(index => {
      if (index < 0 || !target.bones[index].name.toLowerCase().includes(part) || /metacarpal|twist|helper/i.test(target.bones[index].name)) return false;
      let parent = target.bones[index].parent;
      while (parent) { if (parent === target.bones[hand]) return true; parent = parent.parent; }
      return false;
    });
    const finger = fingerFor('middle');
    if (finger !== undefined) next.push([hand, finger]);
    const index = fingerFor('index'), pinky = fingerFor('pinky') ?? fingerFor('little');
    if (finger !== undefined && index !== undefined && pinky !== undefined) handSides.push([hand, index, pinky]);
  }
  const ends = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'].map(roleIndex).filter(index => index >= 0);
  return targetIndices.every(index => index >= 0) && sourceIndices.every(index => index >= 0) ? { source: sourceIndices, target: targetIndices, limbs, next, ends, handSides } : undefined;
}
