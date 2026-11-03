/** Stage the on-device motion-capture tracker into public/mocap.
 * The Wasm runtime is copied from the installed @mediapipe/tasks-vision
 * package, so it always matches the JavaScript in package-lock.json. The
 * pose model is a pinned, hash-verified download; model weights stay out of
 * Git like every other model in this project (see public/mocap/NOTICE.txt).
 * Without --require-model a failed download only warns: the editor builds
 * and runs offline, and Motion Capture reports itself unavailable. */
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'mocap');
const wasmSource = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmFiles = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'];
const modelFile = 'pose_landmarker_full.task';
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const modelSha256 = '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1';
const requireModel = process.argv.includes('--require-model');

const exists = file => access(file).then(() => true, () => false);
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

await mkdir(path.join(target, 'wasm'), { recursive: true });
for (const name of wasmFiles) {
  const from = path.join(wasmSource, name);
  const to = path.join(target, 'wasm', name);
  if (!await exists(from)) throw new Error(`Missing ${name} in @mediapipe/tasks-vision. Run npm ci, then npm run mocap:assets.`);
  const [sourceSize, targetSize] = await Promise.all([stat(from).then(info => info.size), stat(to).then(info => info.size, () => -1)]);
  if (sourceSize !== targetSize) await copyFile(from, to);
}

const model = path.join(target, modelFile);
if (await exists(model) && await sha256(model) === modelSha256) {
  console.log('Motion capture assets ready (pose model verified).');
} else {
  try {
    const response = await fetch(modelUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== modelSha256) throw new Error(`Pose model checksum mismatch: ${actual}`);
    await writeFile(model, bytes);
    console.log('Motion capture assets ready (pose model downloaded and verified).');
  } catch (error) {
    if (requireModel) throw error;
    console.warn(`Motion capture pose model unavailable (${error.message}). The editor still builds; Motion Capture will report itself unavailable until npm run mocap:assets succeeds.`);
  }
}
