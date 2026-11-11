/** Find the notes for a release: docs/releases/v<version>.md when it exists,
 * otherwise a list of the commits since the latest published release. */
import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.GITHUB_REPOSITORY || 'mrchevyceleb/still-motion-studio';
const run = (command, args) => execFileSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Usage: node scripts/release-notes.mjs <version>');

let notes = path.join(root, 'docs', 'releases', `v${version}.md`);
if (!await access(notes).then(() => true, () => false)) {
  let previous;
  try { previous = JSON.parse(run('gh', ['api', `repos/${repo}/releases/latest`])).tag_name; }
  catch (error) { if (!String(error.stderr || '').includes('HTTP 404')) throw error; }
  const known = previous && run('git', ['tag', '--list', previous]) === previous;
  const range = known ? [`${previous}..HEAD`] : ['-n', '50', 'HEAD'];
  const subjects = run('git', ['log', '--no-merges', '--format=%s (%h)', ...range]).split('\n')
    .filter(line => line && !/\[skip release\]/i.test(line));
  const lines = [`# Still Motion Studio ${version}`, ''];
  lines.push(known ? `Changes since ${previous.replace(/^v/, '')}:` : 'Recent changes:', '');
  lines.push(...(subjects.length ? subjects.map(subject => `- ${subject}`) : ['- Maintenance build with no source changes since the previous release.']));
  lines.push('', 'The Windows x64 installers are unsigned. Verify downloads with `SHA256SUMS.txt`. Install the full Setup once on a new computer; the smaller Update installer only works over a matching installed runtime.', '');
  const directory = path.join(root, '.local', 'release-notes');
  await mkdir(directory, { recursive: true });
  notes = path.join(directory, `v${version}.md`);
  await writeFile(notes, lines.join('\n'));
}
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `notes=${notes}\n`);
console.log(notes);
