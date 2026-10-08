// Sample only the acquired CC0 authored clips through the actual import bridge.
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const base = path.resolve('.local/owned-humanoid');
const sources = JSON.parse(await fs.readFile(path.join(base, 'sources.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [];
const sourcesHash = digest(await fs.readFile(path.join(base, 'sources.json')));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173');
  await fs.mkdir(path.join(base, 'requests'), { recursive: true });
  for (const source of sources.sources) for (const file of source.files.filter(item => item.file.endsWith('.glb'))) {
    const location = path.resolve(base, file.file);
    if (path.relative(base, location).startsWith('..') || source.license !== 'CC0-1.0' || !['universal-animation-library', 'universal-animation-library-2'].includes(source.id)) throw new Error('Unrecognized CC0 source.');
    const input = await fs.readFile(location);
    if (digest(input) !== file.sha256) throw new Error('Acquired CC0 source hash mismatch: ' + file.file);
    const bytes = input.toString('base64');
    const clips = await page.evaluate(async ({ bytes, sourceId }) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { importCharacter, applyPose, capturePose } = await import('/src/engine/character.ts');
      const { makeMotionRequest } = await import('/src/engine/assistance.ts');
      const buffer = Uint8Array.from(atob(bytes), value => value.charCodeAt(0));
      const asset = await importCharacter(new File([buffer], 'cc0.glb'));
      const output = [];
      for (const clip of asset.clips) {
        if (clip.duration < .15 || /t.?pose|a.?pose|rest|reference/i.test(clip.name)) continue;
        applyPose(asset, asset.restPose);
        const mixer = new THREE.AnimationMixer(asset.root), action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
        const keys = [];
        const frames = Math.ceil(clip.duration * 20);
        for (let frame = 0; frame <= frames; frame++) {
          const time = Math.min(frame / 20, clip.duration);
          mixer.setTime(time); keys.push({ id: String(frame), time, pose: capturePose(asset) });
        }
        mixer.stopAllAction(); mixer.uncacheRoot(asset.root);
        const request = makeMotionRequest(asset, keys, [keys[0], keys[keys.length - 1]], clip.duration,
          { gravity: 9.81, strength: .7, floorContact: true, interpolation: 'linear' }, 'inbetween', 42);
        output.push({ clip: clip.name, sourceId, request });
      }
      return output;
    }, { bytes, sourceId: source.id });
    for (const clip of clips) {
      const filename = source.id + '--' + clip.clip.replace(/[^a-z0-9_-]/gi, '_') + '.json';
      const content = JSON.stringify(clip);
      await fs.writeFile(path.join(base, 'requests', filename), content);
      records.push({ file: filename, sha256: digest(content), sourceId: source.id, sourceFile: file.file, sourceSha256: file.sha256 });
    }
    console.log(source.id, clips.length, 'clips', clips[0]?.request.rig.names.length, 'bones');
  }
  await fs.writeFile(path.join(base, 'requests', 'index.json'), JSON.stringify({ sourcesSha256: sourcesHash, files: records }, null, 2));
} finally { await browser.close(); }
