/** Run explicitly against a chosen tab. scene.new archives that tab's previous work. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../scripts/still-agent.mjs';

function rotateZ(pose, bone, degrees) {
  const [x, y, z, w] = pose[bone].quaternion;
  const radians = degrees * Math.PI / 360, s = Math.sin(radians), c = Math.cos(radians);
  pose[bone].quaternion = [x * c + y * s, y * c - x * s, z * c + w * s, w * c - z * s];
}

export default async function wave(client, args = [], options = {}) {
  if (!options.sessionId) throw new Error('Choose a tab explicitly: --session <UUID>. The example creates a new scene in that tab.');
  const providerIndex = args.indexOf('--provider');
  const provider = providerIndex >= 0 ? args[providerIndex + 1] : undefined;
  if (providerIndex >= 0 && (!provider || provider.startsWith('--'))) throw new Error('--provider requires a provider ID from scene.inspect.');
  const schema = await client.schema();
  for (const method of ['scene.new', 'skeleton.inspect', 'pose.get', 'keys.replace', 'pose.set', 'history.undo', 'history.redo']) {
    if (!schema.methods?.[method]) throw new Error(`This Still service does not support ${method}.`);
  }
  let state = await client.call('scene.inspect', {}, options);
  let revision = state.revision;
  const command = async (method, params = {}) => {
    const result = await client.call(method, params, { ...options, expectedRevision: revision });
    revision = result.revision;
    if (!Number.isSafeInteger(revision)) throw new Error('Still returned no scene revision; stopping before another mutation.');
    return result;
  };
  await command('scene.new', { kind: 'humanoid', blank: true, name: 'Agent wave' });
  await command('timeline.set', { duration: 4, fps: 30, time: 0 });
  const skeleton = await command('skeleton.inspect');
  const base = (await command('pose.get', { time: 0 })).pose;
  const find = name => {
    const bone = skeleton.bones.find(bone => bone.name.replace(/[^a-z]/gi, '').toLowerCase().endsWith(name.toLowerCase()));
    if (!bone) throw new Error(`The demo rig has no ${name}.`);
    return bone.index;
  };
  const arm = find('RightArm'), elbow = find('RightForeArm'), hand = find('RightHand');
  const keys = [0, .8, 1.6, 2.4, 3.2, 4].map((time, index) => {
    const pose = structuredClone(base);
    rotateZ(pose, arm, [0, 65, 95, 95, 65, 0][index]);
    rotateZ(pose, elbow, [0, 35, 45, 20, 35, 0][index]);
    rotateZ(pose, hand, [0, 0, -25, 25, 0, 0][index]);
    return { time, pose, label: ['Rest', 'Lift', 'Wave left', 'Wave right', 'Lower', 'Rest'][index] };
  });
  await command('keys.replace', { keys });
  await command('settings.set', { interpolation: 'smooth' });
  // Demonstrate an isolated edit and its history without changing the final six-pose result.
  await command('pose.set', { time: 1.6, bones: [{ bone: hand, rotationDegrees: [0, 0, 15] }] });
  await command('history.undo');
  await command('history.redo');
  await command('history.undo');
  if (provider) await command('motion.run', { provider, seed: 7 });
  await command('timeline.set', { time: 1.6 });
  await command('view.set', { cameraView: 'perspective', showRig: true, selectedBone: hand });
  const parent = path.resolve('.local/agent-example');
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, 'wave-'));
  const files = [];
  for (const [format, extension] of [['still', 'still'], ['glb', 'glb'], ...(args.includes('--unreal') ? [['unreal', 'zip']] : [])]) {
    files.push(await client.exportFile(format, path.join(output, `agent-wave.${extension}`), { ...options, expectedRevision: revision, fps: 30 }));
  }
  state = await command('scene.inspect');
  return { message: 'Six-pose wave created in the selected tab.', sessionId: options.sessionId, revision, state, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), index = args.indexOf('--session');
  const sessionId = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0) args.splice(index, 2);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  createClient({ sessionId }).then(client => wave(client, args, { sessionId, signal: abort.signal }))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ error: { code: error.code || 'ERROR', message: error.message, details: error.details } })); process.exitCode = 1; });
}
