import { createServer } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { createDemoCharacter } = await server.ssrLoadModule('/src/engine/character.ts');
  const { createDemoKeys } = await server.ssrLoadModule('/src/engine/motion.ts');
  const { makeMotionRequest } = await server.ssrLoadModule('/src/engine/assistance.ts');
  const { DEFAULT_SETTINGS } = await server.ssrLoadModule('/src/types.ts');
  const asset = createDemoCharacter('humanoid');
  const keys = createDemoKeys(asset);
  const request = makeMotionRequest(asset, keys, keys, 4, DEFAULT_SETTINGS, 'inbetween', 42);
  await mkdir('.local/ai-motion', { recursive: true });
  await writeFile('.local/ai-motion/request-demo.json', JSON.stringify(request));
  console.log(`Wrote ${request.frames.length} frames, ${request.anchors.length} anchors, ${request.rig.names.length} bones`);
} finally { await server.close(); }
