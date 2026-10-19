/** Publish a verified build as the next GitHub release; a draft never becomes the
 * update feed. Uses only Node and the GitHub CLI: in CI it runs in its own job with
 * no project dependencies installed, so nothing the build ran can reach the write
 * token. release-desktop.mjs prepares and checks the folder first.
 * Usage: node scripts/publish-release.mjs <release-folder> <notes.md> */
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertReleasable } from './release-guard.mjs';

const repo = 'mrchevyceleb/still-motion-studio';
const [directory, notes] = process.argv.slice(2, 4).map(value => value && path.resolve(value));
if (!directory || !notes) throw new Error('Usage: node scripts/publish-release.mjs <release-folder> <notes.md>');
const gh = args => execFileSync('gh', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const api = args => JSON.parse(gh(['api', ...args]));
const parse = value => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '')?.slice(1).map(Number);
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const sha256 = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
});

if (!(await readFile(notes, 'utf8')).trim()) throw new Error('Release notes are empty.');
const source = JSON.parse(await readFile(path.join(directory, 'release-source.json'), 'utf8'));
const { version, commit, installer, updateInstaller } = source;
if (source.repository !== repo || !parse(version) || !/^[0-9a-f]{40}$/.test(commit || '')
  || installer !== `Still-Motion-Studio-Setup-${version}.exe` || updateInstaller !== `Still-Motion-Studio-Update-${version}.exe`) throw new Error('Invalid release-source.json.');
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('These files were built from another commit.');
// Every file except the two manifests is listed in SHA256SUMS.txt; check the bytes survived the handoff.
const sums = new Map();
for (const line of (await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8')).split('\n').filter(Boolean)) {
  const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
  if (!match || sums.has(match[2])) throw new Error('Invalid SHA256SUMS.txt.');
  sums.set(match[2], match[1]);
}
for (const name of [installer, installer + '.blockmap', updateInstaller, updateInstaller + '.blockmap', 'latest.yml', 'blender-source.json', 'THIRD_PARTY_NOTICES.md']) {
  if (!sums.has(name)) throw new Error(`SHA256SUMS.txt does not list ${name}.`);
}
for (const [name, hash] of sums) if (await sha256(path.join(directory, name)) !== hash) throw new Error(`${name} does not match SHA256SUMS.txt.`);
const assets = [...sums.keys(), 'SHA256SUMS.txt', 'release-source.json'];

let previous;
try { previous = api([`repos/${repo}/releases/latest`]); }
catch (error) { if (!String(error.stderr || '').includes('HTTP 404')) throw error; }
if (previous && !(newer(parse(version), parse(previous.tag_name) || [0, 0, 0]) > 0)) throw new Error('The release version must be newer than the current stable release.');
assertReleasable(repo, commit);

const tag = `v${version}`;
// GitHub ignores target_commitish when a tag already exists, even if that tag
// has never been fetched locally. Resolve and peel the remote ref first.
function verifyRemoteTag() {
  let remoteTag;
  try { remoteTag = api([`repos/${repo}/git/ref/tags/${tag}`]).object; }
  catch (error) { if (!String(error.stderr || '').includes('HTTP 404')) throw error; }
  while (remoteTag?.type === 'tag') remoteTag = api([`repos/${repo}/git/tags/${remoteTag.sha}`]).object;
  if (remoteTag && (remoteTag.type !== 'commit' || remoteTag.sha !== commit)) throw new Error('The remote version tag points to another commit.');
}
verifyRemoteTag();
// GitHub's tag endpoint can return 404 for a draft whose tag has not been
// created yet. The authenticated release list includes those drafts.
function findRelease() {
  const matches = api(['--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]).flat().filter(value => value.tag_name === tag);
  if (matches.length > 1) throw new Error('Multiple releases use this tag. Resolve the duplicate drafts before publishing.');
  return matches[0];
}
let release = findRelease();
if (release && (!release.draft || release.target_commitish !== commit)) throw new Error('This tag already belongs to another or published release.');
if (!release) {
  gh(['release', 'create', tag, '--repo', repo, '--draft', '--target', commit, '--title', `Still Motion Studio ${version}`, '--notes-file', notes]);
  release = findRelease();
}
if (!release?.draft || release.target_commitish !== commit) throw new Error('GitHub did not confirm the matching source draft.');
// Publish last: clients must never observe a partially uploaded feed.
gh(['release', 'upload', tag, ...assets.map(file => path.join(directory, file)), '--repo', repo, '--clobber']);
const uploaded = api([`repos/${repo}/releases/${release.id}`]);
for (const file of assets) {
  const asset = uploaded.assets.find(value => value.name === file);
  if (!asset || asset.size !== (await stat(path.join(directory, file))).size) throw new Error(`GitHub asset is missing or incomplete: ${file}`);
  // A missing digest is not proof of a successful upload. Leave the release
  // in draft; retry after GitHub has completed processing the assets.
  if (asset.digest !== `sha256:${await sha256(path.join(directory, file))}`) throw new Error(`GitHub asset hash is unavailable or differs: ${file}. The release remains a draft.`);
}
verifyRemoteTag();
// Check again right before going live, in case a release was published while this one uploaded.
assertReleasable(repo, commit);
gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
const published = api([`repos/${repo}/releases/${release.id}`]);
if (published.draft || published.prerelease || published.tag_name !== tag || published.target_commitish !== commit) throw new Error('GitHub did not confirm the stable published release. Inspect the release before retrying.');
verifyRemoteTag();
console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
