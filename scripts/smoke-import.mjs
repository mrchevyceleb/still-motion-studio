// Optional integration smoke. Supply FBX and unrigged GLB fixtures as CLI arguments.
// node scripts/smoke-import.mjs .local/sample-mixamo.fbx .local/unrigged.glb
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve('.local/smoke-import');
await mkdir(output, { recursive: true });
const fixtures = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('dialog', dialog => dialog.accept());
page.setDefaultTimeout(30_000);
const results = [];
const canvas = page.getByTestId('pose-canvas');
const joints = async () => JSON.parse(await canvas.getAttribute('data-joints') || '[]');
const settled = async () => { await expect(page.locator('.busy-overlay')).toHaveCount(0, { timeout: 30_000 }); await expect(page.getByRole('alert')).toHaveCount(0); };
async function importFile(filename) { await page.getByLabel('Import file', { exact: true }).setInputFiles(path.resolve(filename)); await settled(); }
async function download(kind, filename) {
  await page.locator('.export-button').click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: kind === 'still' ? /Editable Still project/ : /Animated character/ }).click();
  const result = await downloaded;
  assert.equal(await result.failure(), null);
  const target = path.join(output, filename);
  await result.saveAs(target);
  if (await page.getByRole('button', { name: 'Close dialog' }).isVisible()) await page.getByRole('button', { name: 'Close dialog' }).click();
  return target;
}
async function project(filename) { return JSON.parse(await readFile(await download('still', filename), 'utf8')); }
async function dragHand(dx = -35, dy = -30) {
  await page.waitForTimeout(240);
  const hand = (await joints()).find(joint => /righthand$/i.test(joint.name) && joint.visible);
  assert.ok(hand, 'Right-hand posing handle must be on screen.');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + hand.x, box.y + hand.y);
  await page.mouse.down();
  await page.mouse.move(box.x + hand.x + dx, box.y + hand.y + dy, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole('combobox', { name: 'Selected joint' })).toHaveValue(String(hand.index));
}
async function validateGLB(filename, requireSkin = true) {
  const buffer = await readFile(filename);
  assert.equal(buffer.toString('utf8', 0, 4), 'glTF');
  const json = JSON.parse(buffer.toString('utf8', 20, 20 + buffer.readUInt32LE(12)));
  assert.ok(json.animations?.[0]?.channels?.length);
  assert.ok(json.meshes?.length);
  if (requireSkin) assert.ok(json.skins?.length, 'Animated skinned character must include skins.');
}
function assertRestEquivalent(before, after) {
  assert.equal(after.boneNames.length, before.boneNames.length);
  before.boneNames.forEach((name, index) => {
    // glTF makes duplicate FBX node names unique with a numeric suffix.
    assert.ok(after.boneNames[index] === name || after.boneNames[index].replace(/_\d+$/, '') === name);
  });
  const rest = document => document.character.object.object.userData.stillAsset.restPose;
  rest(before).forEach((bone, index) => {
    const restored = rest(after)[index];
    for (const property of ['position', 'scale']) bone[property].forEach((value, axis) => {
      assert.ok(Math.abs(value - restored[property][axis]) < 1e-4, `Rest ${property} changed for ${before.boneNames[index]}`);
    });
    const dot = bone.quaternion.reduce((sum, value, axis) => sum + value * restored.quaternion[axis], 0);
    assert.ok(Math.abs(dot) > 1 - 1e-5, `Rest rotation changed for ${before.boneNames[index]}`);
  });
}
async function step(name, action) {
  await action(); results.push(name); console.log(`PASS ${name}`);
}
try {
  await page.goto(process.env.STILL_URL || 'http://127.0.0.1:5173', { waitUntil: 'networkidle' });
  await settled();
  await step('Real Mixamo FBX preserves its rig and source animation', async () => {
    await importFile(fixtures[0] || '.local/sample-mixamo.fbx');
    await expect(page.locator('.rig-status')).toContainText('Original rig preserved');
    await expect.poll(async () => (await joints()).length).toBeGreaterThan(50);
    assert.ok(parseInt(await page.locator('.tiny-badge').innerText()) > 6);
    await expect(page.locator('.blend-options .active')).toHaveText('Direct');
    const clip = page.getByRole('combobox', { name: 'Animation clip' });
    await expect(clip).toHaveValue('0');
    const firstClip = await project('source-clip-0.still');
    await clip.selectOption('1');
    await expect(clip).toHaveValue('1');
    const secondClip = await project('source-clip-1.still');
    assert.equal(secondClip.sourceClip, 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(clip).toHaveValue('0');
    const undone = await project('source-clip-undo.still');
    assert.deepEqual(undone.keys, firstClip.keys);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(clip).toHaveValue('1');
    await importFile(path.join(output, 'source-clip-1.still'));
    await expect(clip).toHaveValue('1');
    const resumed = await project('source-clip-restored.still');
    assert.deepEqual(resumed.keys, secondClip.keys);
    const all = await joints();
    const thumb = all.find(j => /thumb/i.test(j.name));
    assert.ok(thumb && !thumb.visible, 'Detailed finger controls should initially be hidden.');
    await page.getByRole('button', { name: /Try the right hand/ }).click();
    await page.getByRole('combobox', { name: 'Selected joint' }).selectOption(String(thumb.index));
    await expect.poll(async () => (await joints()).find(j => j.index === thumb.index).visible).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileInspector = page.getByRole('button', { name: /Character & joint controls/ });
    await expect(mobileInspector).toBeVisible();
    await mobileInspector.click();
    await expect(mobileInspector).toHaveAttribute('aria-expanded', 'true');
    await expect(clip).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Selected joint' })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'X joint rotation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset this joint' })).toBeVisible();
    await page.screenshot({ path: path.join(output, 'mobile-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    // This fixture's second source clip is a one-frame bind pose.
    await clip.selectOption('0');
    await page.getByRole('button', { name: /Simplify to 6 poses/ }).click();
    await expect(page.locator('.tiny-badge')).toHaveText('6 POSES');
    await expect(clip).toHaveValue('-1');
    await expect(page.getByRole('button', { name: 'Go to pose 1', exact: true })).toBeVisible();
  });
  await step('Edit imported rig, round-trip its project, export and reimport GLB', async () => {
    const before = await project('imported-before.still');
    await dragHand();
    const after = await project('imported-edited.still');
    assert.notDeepEqual(after.keys, before.keys);
    assert.equal(after.character.type, 'embedded');
    await importFile(path.join(output, 'imported-edited.still'));
    const restored = await project('imported-restored.still');
    assert.deepEqual(restored.keys, after.keys);
    assert.deepEqual(restored.boneNames, after.boneNames);
    // Export while showing a bent authored pose, rather than the rest pose.
    await page.getByRole('button', { name: 'Go to pose 2', exact: true }).click();
    await page.waitForTimeout(240);
    const beforeExport = await joints();
    const playhead = await page.locator('.timecode').innerText();
    const glb = await download('glb', 'imported-edited.glb');
    await validateGLB(glb);
    await settled();
    await expect(page.locator('.timecode')).toHaveText(playhead);
    await page.waitForTimeout(240);
    (await joints()).forEach((joint, index) => {
      assert.ok(Math.abs(joint.x - beforeExport[index].x) <= 1 && Math.abs(joint.y - beforeExport[index].y) <= 1, 'GLB export must restore the currently displayed pose.');
    });
    await importFile(glb);
    await expect(page.locator('.rig-status')).toContainText('Original rig preserved');
    await expect.poll(async () => (await joints()).length).toBeGreaterThan(50);
    const reimported = await project('glb-rest-metadata.still');
    assertRestEquivalent(after, reimported);
    await page.getByRole('button', { name: 'Play animation', exact: true }).click();
    await expect.poll(async () => parseFloat(await page.locator('.timecode').innerText())).toBeGreaterThan(.2);
    await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'mixamo-roundtrip.png'), fullPage: true });
  });
  await step('Fit a humanoid rig to an unrigged model and edit it', async () => {
    await importFile(fixtures[1] || '.local/unrigged.glb');
    await expect(page.getByRole('button', { name: /Fit my rig/ })).toBeVisible();
    await page.getByRole('button', { name: /Fit my rig/ }).click();
    await settled();
    await expect.poll(async () => (await joints()).length).toBeGreaterThan(15);
    const before = await project('autorig-before.still');
    await dragHand(-35, 40);
    const after = await project('autorig-edited.still');
    assert.notDeepEqual(after.keys, before.keys);
    assert.ok(JSON.stringify(after.character.object).includes('SkinnedMesh'));
    await page.screenshot({ path: path.join(output, 'autorig-edited.png'), fullPage: true });
    await importFile(path.join(output, 'autorig-edited.still'));
    const restored = await project('autorig-restored.still');
    assert.deepEqual(restored.keys, after.keys);
    assert.deepEqual(restored.boneNames, after.boneNames);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileInspector = page.getByRole('button', { name: /Character & joint controls/ });
    if (await mobileInspector.getAttribute('aria-expanded') !== 'true') await mobileInspector.click();
    await expect(page.locator('.import-notes summary')).toBeVisible();
    await page.locator('.import-notes summary').click();
    await expect(page.locator('.import-notes')).toContainText('Starter rig');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await step('Apply physics, save/reload its baked keys, and export the new skin', async () => {
    await page.getByRole('switch', { name: 'Floor contact' }).click();
    await page.getByRole('button', { name: /Quick ground pass/ }).click();
    await settled();
    assert.ok(parseInt(await page.locator('.tiny-badge').innerText()) > 2);
    const physics = await project('autorig-physics.still');
    assert.equal(new Set(physics.keys.map(key => key.id)).size, physics.keys.length);
    await importFile(path.join(output, 'autorig-physics.still'));
    const restored = await project('autorig-physics-restored.still');
    assert.deepEqual(restored.keys, physics.keys);
    const glb = await download('glb', 'autorig-physics.glb');
    await validateGLB(glb);
    await importFile(glb);
    await expect(page.locator('.rig-status')).toContainText('Original rig preserved');
    await expect.poll(async () => (await joints()).length).toBeGreaterThan(15);
  });
  assert.deepEqual(browserErrors, []);
  console.log(`All ${results.length} import smoke checks passed. Artifacts: ${output}`);
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error); process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: results, browserErrors }, null, 2));
  await browser.close();
}
