import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve('public/motions');
const mesh2MotionCommit = '653a9698f5f315523072f1c3ff3496100401317b';
const packs = [
  ['quaternius-ual1.glb', 'Quaternius', 'humanoid', 'be684571ed655a1b892c2c07e6e2aeca053b606c442d34004adaf1d944090d01', 'https://quaternius.com/packs/universalanimationlibrary.html'],
  ['quaternius-ual2.glb', 'Quaternius', 'humanoid', '814eee878f82934992d3ea746c539df25e981487109c591f5efbb8dd03286f99', 'https://quaternius.com/packs/universalanimationlibrary2.html'],
  ['bird-animations.glb', 'Mesh2Motion', 'creature', '9624b0bf70abe400ed0445c2423c69d5e046bd7d60074e399e2be161763c4f99'],
  ['dragon-animations.glb', 'Mesh2Motion', 'creature', '73262041b09aa0499778818162b34955e76e17548212825548799643d5c925b3'],
  ['fox-animations.glb', 'Mesh2Motion', 'quadruped', '80e80641a5692a14aba7616a46d2a28d3595479764887c578c766b99dba8a0d0'],
  ['horse-animations.glb', 'Mesh2Motion', 'quadruped', 'c6f890c307e457b9aa7cceda1fbc1e39f8e6723ef340f23e3e667e122673b51c'],
  ['human-addon-animations.glb', 'Mesh2Motion', 'humanoid', 'a0d64d555e0d492026b72d58bf8e16c5e86779295f9093e376dcc001915c2c95'],
  ['human-base-animations.glb', 'Mesh2Motion', 'humanoid', '406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c'],
  ['kaiju-animations.glb', 'Mesh2Motion', 'creature', '675a098d8cdddf5247c55d49fa04712556cd0493facec0be586b6bb9aaeed410'],
  ['shark-animations.glb', 'Mesh2Motion', 'creature', '918321bbcab9439456fcc5838d745c810ea6fd5adb658ccc3651b5d4244f9107'],
  ['snake-animations.glb', 'Mesh2Motion', 'creature', '795e4c62ba1e02f3f33e900832cdc6a1ca5a4aa4f6fe426fccd3aaa0f7f6ac25'],
  ['spider-animations.glb', 'Mesh2Motion', 'creature', 'a321c1617c7f74cf86c050694bc254e74409c6c69db26fe542338f2f7c43d07a'],
];

function category(name) {
  const value = name.toLowerCase();
  if (/walk|run|jog|sprint|crawl|swim|fly|gallop|tro(t|tting)/.test(value)) return 'Locomotion';
  if (/attack|hit|punch|kick|shoot|combat|chop/.test(value)) return 'Action';
  if (/idle|rest|breath|sleep|stand/.test(value)) return 'Idle';
  if (/dance|wave|emote|gesture|talk|cheer/.test(value)) return 'Expression';
  return 'Other';
}

const clips = [];
const sources = [];
for (const [file, provider, body, expectedHash, sourceUrl] of packs) {
  const bytes = await readFile(path.join(directory, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedHash) throw new Error(`${file}: source hash mismatch`);
  if (bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${file}: invalid GLB`);
  const jsonSize = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonSize));
  const animations = gltf.animations ?? [];
  if (!animations.length || !gltf.skins?.length) throw new Error(`${file}: no rigged animations`);
  sources.push({ file, provider, body, sha256, bytes: bytes.length, license: 'CC0-1.0', sourceUrl: sourceUrl ?? `https://github.com/Mesh2Motion/mesh2motion-app/blob/${mesh2MotionCommit}/static/animations/${file}` });
  animations.forEach((animation, index) => {
    const name = animation.name || `Clip ${index + 1}`;
    if (/^(a\s*t\s*pose|rest\s*pose|t\s*pose)$/i.test(name.replace(/[_-]/g, ' '))) return;
    const duration = Math.max(...animation.samplers.map(sampler => {
      const accessor = gltf.accessors[sampler.input];
      if (!accessor?.max?.length) throw new Error(`${file}: missing duration for ${name}`);
      return accessor.max[0];
    }));
    if (!(duration > 0) || duration > 600) throw new Error(`${file}: invalid duration for ${name}`);
    clips.push({ id: `${file}:${index}`, sourceFile: file, clipIndex: index, name: name.replaceAll('_', ' '), duration: Number(duration.toFixed(3)), provider, body, category: category(name), loop: /loop|idle|walk|run|fly|swim/i.test(name) });
  });
}
const catalog = { version: 1, mesh2MotionCommit, sources, clips };
const output = path.join(directory, 'catalog.json');
const serialized = JSON.stringify(catalog, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== serialized) throw new Error('Motion catalog is stale. Run npm run motions:catalog.');
} else await writeFile(output, serialized);
console.log(`${clips.length} verified offline clips across ${sources.length} CC0 packs`);
