/** Preserve the license texts of the installed production dependency tree. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const sections = ['Third-party JavaScript licenses\nGenerated from package-lock.json. Original license terms apply to each component.'];
for (const [relative, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!relative || entry.dev) continue;
  const directory = path.join(root, relative);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (entry.optional && error.code === 'ENOENT') continue; throw error; }
  const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name));
  const texts = [];
  for (const name of names) {
    try { texts.push(`${name}\n${await readFile(path.join(directory, name), 'utf8')}`); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
  if (!texts.length && manifest.name === 'lazy-val' && manifest.version === '1.0.5' && manifest.license === 'MIT') {
    texts.push(await readFile(path.join(root, 'docs/licenses/lazy-val-1.0.5.txt'), 'utf8'));
  }
  if (!texts.length) throw new Error(`Missing redistribution notice for ${manifest.name}. Inspect its license before building.`);
  sections.push(`${manifest.name}@${manifest.version} (${manifest.license || 'see notice'})\n${texts.join('\n\n')}`);
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/THIRD-PARTY-LICENSES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
console.log(`Included license notices for ${sections.length - 1} JavaScript dependencies.`);
