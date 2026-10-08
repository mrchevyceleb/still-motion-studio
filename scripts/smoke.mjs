// Run against the local development server: node scripts/smoke.mjs
// Outputs screenshots, downloaded round-trip fixtures, and a concise report in .local/smoke.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.STILL_URL || 'http://127.0.0.1:5173';
const output = path.resolve('.local/smoke');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
const page = await context.newPage();
const failures = [];
const results = [];
page.on('pageerror', error => failures.push(error.message));
page.on('dialog', dialog => dialog.accept());
page.setDefaultTimeout(15_000);
const canvas = page.getByTestId('pose-canvas');

async function ready() {
  await expect(page.locator('.busy-overlay')).toHaveCount(0);
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await canvas.getAttribute('data-joints'))?.length ?? 0).toBeGreaterThan(30);
}

async function saved() {
  await expect(page.locator('.save-status')).toContainText('Saved on this device');
}

async function saveProject(filename) {
  await page.locator('.export-button').click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /Editable Still project/ }).click();
  const download = await downloading;
  assert.equal(await download.failure(), null);
  const target = path.join(output, filename);
  await download.saveAs(target);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  return JSON.parse(await readFile(target, 'utf8'));
}

async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, passed: true, milliseconds: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: String(error), milliseconds: Date.now() - started });
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  }
}

try {
  await step('Open the studio and capture desktop', async () => {
    let connected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 5_000 }); connected = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 1_000)); }
    }
    assert.ok(connected, `Development server unavailable at ${baseURL}`);
    await ready();
    await expect(page.locator('.tiny-badge')).toHaveText('6 POSES');
    await expect(page.locator('.motion-viewport-error')).toHaveCount(0);
    await saved();
    await page.screenshot({ path: path.join(output, 'desktop-1440.png'), fullPage: true });
  });

  await step('Playback advances and pauses', async () => {
    await page.getByRole('button', { name: 'Go to beginning', exact: true }).click();
    await page.getByRole('button', { name: 'Play animation', exact: true }).click();
    await expect.poll(async () => parseFloat(await page.locator('.timecode').innerText())).toBeGreaterThan(0.25);
    await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
    const paused = await page.locator('.timecode').innerText();
    await page.waitForTimeout(160);
    assert.equal(await page.locator('.timecode').innerText(), paused);
  });

  await step('Drag a joint, save its changed pose, undo and redo', async () => {
    await page.getByRole('button', { name: 'Go to pose 2', exact: true }).click();
    const before = await saveProject('before-drag.still');
    await page.waitForTimeout(250);
    const joints = JSON.parse(await canvas.getAttribute('data-joints'));
    const hand = joints.find(joint => /righthand/i.test(joint.name) && joint.visible);
    assert.ok(hand, 'The right hand must have a visible drag handle.');
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + hand.x, box.y + hand.y);
    await page.mouse.down();
    await page.mouse.move(box.x + hand.x - 46, box.y + hand.y - 42, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByRole('combobox', { name: 'Selected joint' })).toHaveValue(String(hand.index));
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    const after = await saveProject('after-drag.still');
    assert.notDeepEqual(after.keys, before.keys, 'Dragging must update the stored animation pose.');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const undone = await saveProject('after-undo.still');
    assert.deepEqual(undone.keys, before.keys, 'Undo must restore the complete original pose keys.');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    const redone = await saveProject('after-redo.still');
    assert.deepEqual(redone.keys, after.keys, 'Redo must restore the dragged pose.');
  });

  await step('Add and delete a pose at a new frame', async () => {
    await page.getByRole('button', { name: 'Next frame', exact: true }).click();
    await page.getByRole('button', { name: /Add a pose/ }).click();
    await expect(page.locator('.tiny-badge')).toHaveText('7 POSES');
    await page.getByRole('button', { name: 'Delete selected pose', exact: true }).click();
    await expect(page.locator('.tiny-badge')).toHaveText('6 POSES');
  });

  await step('Interpolation, camera, rotation, onion skin, and rig controls', async () => {
    await page.locator('.curve-section > summary').click();
    for (const name of ['Direct', 'Hold', 'Smooth']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.blend-options .active')).toHaveText(name);
    }
    for (const name of ['Front', 'Side', '3D']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.view-picker .active')).toHaveText(name);
    }
    await page.getByRole('button', { name: 'Rotate joint', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Rotate joint', exact: true })).toHaveClass('active');
    await page.getByRole('button', { name: 'Move joint', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Move joint', exact: true })).toHaveClass('active');
    const onion = page.getByRole('button', { name: 'Toggle onion skin', exact: true });
    await onion.click(); await expect(onion).toHaveAttribute('aria-pressed', 'true');
    await onion.click(); await expect(onion).toHaveAttribute('aria-pressed', 'false');
    const rig = page.getByRole('button', { name: 'Show joints', exact: true });
    await rig.click(); await expect(rig).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => JSON.parse(await canvas.getAttribute('data-joints')).every(joint => !joint.visible)).toBe(true);
    await rig.click(); await expect(rig).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('switch', { name: 'Floor contact' }).click();
    await expect(page.getByRole('switch', { name: 'Floor contact' })).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Gravity', { exact: true }).selectOption('1.62');
    await expect(page.getByLabel('Gravity', { exact: true })).toHaveValue('1.62');
  });

  await step('Save a project, switch character, and reimport the project', async () => {
    await page.getByRole('textbox', { name: 'Project name' }).fill('Smoke round trip');
    await page.getByRole('textbox', { name: 'Project name' }).blur();
    const original = await saveProject('round-trip.still');
    await page.getByRole('button', { name: 'New scene', exact: true }).click();
    await page.getByRole('button', { name: /Four little steps/ }).click();
    await ready();
    await expect(page.locator('.rig-status')).toContainText('Quadruped');
    await page.getByRole('button', { name: 'New scene', exact: true }).click();
    await page.locator('.recent-scenes button').filter({ hasText: 'Smoke round trip' }).first().click();
    await ready();
    const archivedOriginal = await saveProject('archived-new-scene.still');
    assert.deepEqual(archivedOriginal.keys, original.keys, 'New scene must preserve the replaced animation in Recent scenes.');
    await page.getByRole('button', { name: 'New scene', exact: true }).click();
    await page.getByRole('button', { name: /Four little steps/ }).first().click();
    await ready();
    const quadruped = await saveProject('before-import-archive.still');
    await page.getByLabel('Import file', { exact: true }).setInputFiles(path.join(output, 'round-trip.still'));
    await ready();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Smoke round trip');
    const restored = await saveProject('restored.still');
    assert.deepEqual(restored, original, 'Project reimport must preserve all character, key, and settings data.');
    await page.getByRole('button', { name: 'New scene', exact: true }).click();
    await page.locator('.recent-scenes button').filter({ hasText: 'Four little steps' }).first().click();
    await ready();
    const recovered = await saveProject('archived-import-scene.still');
    assert.deepEqual(recovered.keys, quadruped.keys, 'Import must preserve the replaced animation in Recent scenes.');
    assert.deepEqual(recovered.character, quadruped.character);
    await page.getByLabel('Import file', { exact: true }).setInputFiles(path.join(output, 'round-trip.still'));
    await ready();
    await saved();
  });

  await step('Autosave survives a page reload', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await ready();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Smoke round trip');
    await expect(page.getByLabel('Gravity', { exact: true })).toHaveValue('1.62');
    const original = JSON.parse(await readFile(path.join(output, 'round-trip.still'), 'utf8'));
    const restored = await saveProject('autosaved.still');
    assert.deepEqual(restored, original, 'Autosave must preserve the editable scene after reload.');
  });

  await step('Export a valid animated GLB', async () => {
    await page.locator('.export-button').click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: /Animated character/ }).click();
    const download = await downloading;
    assert.equal(await download.failure(), null);
    const target = path.join(output, 'animated-character.glb');
    await download.saveAs(target);
    const buffer = await readFile(target);
    assert.equal(buffer.toString('utf8', 0, 4), 'glTF');
    assert.equal(buffer.readUInt32LE(4), 2);
    assert.equal(buffer.readUInt32LE(8), buffer.length);
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLength));
    assert.ok(json.animations?.[0]?.channels?.length > 0, 'GLB needs baked animation channels.');
    assert.ok(json.meshes?.length > 0, 'GLB needs a character mesh.');
    if (await page.getByRole('button', { name: 'Close dialog' }).isVisible()) await page.getByRole('button', { name: 'Close dialog' }).click();
  });

  await step('Compact desktop layout and screenshot', async () => {
    await page.setViewportSize({ width: 1024, height: 850 });
    await ready();
    await page.getByRole('button', { name: 'Dismiss notification' }).click().catch(() => {});
    await page.screenshot({ path: path.join(output, 'compact-1024.png'), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, 'Compact desktop layout must not overflow horizontally.');
    await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeVisible();
  });

  assert.deepEqual(failures, [], 'The browser must not report unhandled JavaScript errors.');
  console.log(`All ${results.length} smoke checks passed. Artifacts: ${output}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ baseURL, results, browserErrors: failures }, null, 2));
  await browser.close();
}
