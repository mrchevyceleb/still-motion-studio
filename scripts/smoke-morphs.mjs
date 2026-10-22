// Local editor integration proof. Build the Blender fixture first; no Unreal needed.
// node scripts/smoke-morphs.mjs [/tmp/still-morph-fixture.glb] [output-directory]
// Set STILL_MORPH_FBX to the extracted animation.fbx to check FBXLoader too.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const fixture = path.resolve(process.argv[2] || '/tmp/still-morph-fixture.glb');
const output = path.resolve(process.argv[3] || '/tmp/still-morph-editor-proof');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' } });
let browser, page;
const errors = [], results = [];
const pass = message => { results.push(message); console.log('PASS ' + message); };
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: { providers: [], busy: false } }));
  const ready = async () => {
    await expect(page.locator('.busy-overlay')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  };
  const download = async (kind, filename) => {
    await page.locator('.export-button').click();
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: kind === 'still' ? /Editable Still project/ : /Animated character/ }).click();
    const file = await waiting;
    assert.equal(await file.failure(), null);
    const target = path.join(output, filename);
    await file.saveAs(target);
    if (kind === 'still') await page.getByRole('button', { name: 'Close dialog' }).click();
    return target;
  };
  await page.goto(server.resolvedUrls.local[0]);
  await ready();
  await expect(page.locator('.face-shapes')).toHaveCount(0);
  pass('No controls on a character without morphs');
  await page.getByLabel('Import file', { exact: true }).setInputFiles(fixture);
  await ready();
  const blink = page.getByRole('slider', { name: 'Blink shape', exact: true });
  const smile = page.getByRole('slider', { name: 'Smile shape', exact: true });
  await expect.poll(async () => Number(await blink.inputValue())).toBeCloseTo(.15, 3);
  await expect.poll(async () => Number(await smile.inputValue())).toBeCloseTo(.8, 3);
  pass('Imported animated Blink and Smile');
  await blink.focus(); await blink.press('End');
  await expect.poll(async () => Number(await blink.inputValue())).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => Number(await blink.inputValue())).toBeCloseTo(.15, 3);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => Number(await blink.inputValue())).toBe(1);
  const saved = await download('still', 'morphs.still');
  const document = JSON.parse(await readFile(saved, 'utf8'));
  assert.equal(document.keys[0].morphs.Blink, 1);
  assert.ok(Math.abs(document.keys[30].morphs.Blink - .85) < 1e-3);
  pass('Moment edit, Undo/Redo, and project morph data');
  await blink.focus(); await blink.press('Home');
  await page.getByLabel('Import file', { exact: true }).setInputFiles(saved);
  await ready();
  await expect.poll(async () => Number(await blink.inputValue())).toBe(1);
  await expect(page.locator('.save-status')).toContainText(/Saved/);
  await page.reload(); await ready();
  await expect.poll(async () => Number(await blink.inputValue())).toBe(1);
  pass('Project reopen and local recovery');
  const playhead = page.getByRole('slider', { name: 'Timeline playhead', exact: true });
  await playhead.focus(); await playhead.press('End');
  await expect.poll(async () => Number(await blink.inputValue())).toBeCloseTo(.25, 3);
  await expect.poll(async () => Number(await smile.inputValue())).toBe(1);
  await page.getByRole('button', { name: 'Go to beginning', exact: true }).click();
  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(.2);
  await expect.poll(async () => Number(await smile.inputValue())).toBeLessThan(.75);
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
  pass('Scrubbing and playback update morph values');
  await page.screenshot({ path: path.join(output, 'face-shapes.png'), fullPage: true });
  const glbPath = await download('glb', 'morphs.glb');
  const binary = await readFile(glbPath);
  const jsonLength = binary.readUInt32LE(12);
  const gltf = JSON.parse(binary.subarray(20, 20 + jsonLength).toString());
  const buffer = binary.subarray(28 + jsonLength);
  const floats = index => {
    const accessor = gltf.accessors[index], view = gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType, 5126);
    return Array.from({ length: accessor.count }, (_, i) => buffer.readFloatLE((view.byteOffset || 0) + (accessor.byteOffset || 0) + i * 4));
  };
  const animation = gltf.animations[0], weights = animation.channels.filter(channel => channel.target.path === 'weights');
  assert.equal(weights.length, 1);
  const sampler = animation.samplers[weights[0].sampler], times = floats(sampler.input), values = floats(sampler.output);
  const names = gltf.meshes[gltf.nodes[weights[0].target.node].mesh].extras.targetNames;
  for (const [time, expected] of [[0, { Blink: 1, Smile: .8 }], [1, { Blink: .85, Smile: .2 }], [2, { Blink: .25, Smile: 1 }]]) {
    const frame = times.findIndex(t => Math.abs(t - time) < 1e-6);
    assert.ok(frame >= 0);
    for (const [name, value] of Object.entries(expected)) assert.ok(Math.abs(values[frame * names.length + names.indexOf(name)] - value) < 1e-3);
  }
  pass(`GLB weights channel: ${times.length} frames, ${names.join(', ')}`);
  const engine = await page.evaluate(async bytes => {
    const { importCharacter, restoreCharacter } = await import('/src/engine/character.ts');
    const { sampleClip, buildAnimationClip } = await import('/src/engine/motion.ts');
    const { captureMorphs, createMorphSampler, applyMorphs } = await import('/src/engine/morphs.ts');
    const { duplicateMoment } = await import('/src/engine/keyframeEditing.ts');
    const { editMotion } = await import('/src/engine/clipEditing.ts');
    const { validateProject } = await import('/src/engine/project.ts');
    const { DEFAULT_SETTINGS } = await import('/src/types.ts');
    const asset = await importCharacter(new File([new Uint8Array(bytes)], 'proof.glb'));
    const keys = sampleClip(asset, asset.clips[0]);
    const check = (value, expected) => { if (Math.abs(value - expected) > 1e-5) throw new Error(`Morph mismatch ${value} vs ${expected}`); };
    for (const mode of ['smooth', 'linear', 'stepped']) {
      const moments = [keys[0], keys[30], keys[60]], sample = createMorphSampler(moments, mode);
      applyMorphs(asset, sample(.5));
      check(captureMorphs(asset).Blink, mode === 'stepped' ? 1 : mode === 'smooth' ? .955 : .925);
      const clip = buildAnimationClip(asset, moments, 2, { ...DEFAULT_SETTINGS, interpolation: mode });
      const roundtrip = sampleClip(asset, clip);
      check(roundtrip[15].morphs.Blink, sample(.5).Blink);
    }
    const duplicate = duplicateMoment([keys[0], keys[60]], keys[0], 2, 30);
    check(duplicate.key.morphs.Blink, 1);
    for (const edit of [{ kind: 'reverse' }, { kind: 'trim', start: .5, end: 1.5 }, { kind: 'speed', factor: 2 }, { kind: 'in-place' }, { kind: 'loop', blend: .25 }, { kind: 'repeat', count: 2, blend: .25 }]) {
      const result = editMotion(asset, { keys, duration: 2, interpolation: 'linear' }, edit, 30);
      if (result.keys.some(key => !key.morphs || !Number.isFinite(key.morphs.Blink))) throw new Error('Clip edit dropped shapes: ' + edit.kind);
    }
    const restored = await restoreCharacter(asset.root.toJSON(), asset.kind, asset.name);
    check(restored.restMorphs.Blink, asset.restMorphs.Blink);
    applyMorphs(restored, keys[0].morphs);
    check(captureMorphs(restored).Blink, 1);
    let rejected = false;
    try { validateProject({ version: 1, name: 'Bad', duration: 2, fps: 30, keys: [{ ...keys[0], morphs: { Blink: null } }], boneNames: asset.bones.map(bone => bone.name), character: { type: 'embedded', kind: asset.kind }, settings: DEFAULT_SETTINGS }); } catch { rejected = true; }
    if (!rejected) throw new Error('Invalid saved morph values accepted');
    return { modes: 3, clipEdits: 6, frames: keys.length, restored: true };
  }, [...binary]);
  pass('Engine interpolation, clip edits, duplication, restoration, and invalid-project guard');
  if (process.env.STILL_MORPH_FBX) {
    await page.getByLabel('Import file', { exact: true }).setInputFiles(path.resolve(process.env.STILL_MORPH_FBX));
    await ready();
    await expect.poll(async () => Number(await blink.inputValue())).toBeCloseTo(.15, 3);
    await expect.poll(async () => Number(await smile.inputValue())).toBeCloseTo(.8, 3);
    pass('FBXLoader imports named morphs and their animation');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'proof.json'), JSON.stringify({ passed: true, results, engine, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, results, engine, output }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ results, errors, body: (await page?.locator('body').innerText())?.slice(-4000) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
