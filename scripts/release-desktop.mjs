/** Publish a complete, tested Windows build; a draft never becomes the feed. */
import { readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Resolve the parsers from electron-updater's declared dependencies.
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const semver = updaterRequire('semver');
const repo = 'mrchevyceleb/still-motion-studio';
const run = (command, args) => execFileSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gh = args => run('gh', args);
const api = args => JSON.parse(gh(['api', ...args]));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
if (!semver.valid(version) || semver.prerelease(version)) throw new Error('Publish a stable semantic version.');
if (run('git', ['status', '--porcelain'])) throw new Error('Commit the release source before publishing.');
const commit = run('git', ['rev-parse', 'HEAD']);
const notes = path.resolve(root, process.argv[2] || `docs/releases/v${version}.md`);
if (!(await readFile(notes, 'utf8')).trim()) throw new Error('Release notes are empty.');
const directory = path.join(root, '.local', 'installers');
const installer = `Still-Motion-Studio-Setup-${version}.exe`;
const updateInstaller = `Still-Motion-Studio-Update-${version}.exe`;
const metadata = yaml.load(await readFile(path.join(directory, 'latest.yml'), 'utf8'));
const packedVersion = JSON.parse(await readFile(path.join(directory, 'win-unpacked/resources/runtime/app/package.json'), 'utf8')).version;
const { id: runtimeId } = JSON.parse(await readFile(path.join(directory, 'win-unpacked/resources/runtime/runtime.json'), 'utf8'));
// The full installer must stay first so releases older than the runtime split never take the app-only one.
if (metadata?.version !== version || packedVersion !== version || metadata.path !== installer || metadata.runtimeId !== runtimeId
  || metadata.files?.map(file => file.url).join() !== [installer, updateInstaller].join()) throw new Error('Build the current version with npm run desktop:dist before publishing.');
let sha512;
for (const info of metadata.files) {
  const bytes = await readFile(path.join(directory, info.url));
  const digest = createHash('sha512').update(bytes).digest('base64');
  if (info.sha512 !== digest || info.size !== bytes.length) throw new Error(`Installer hash or size differs from latest.yml: ${info.url}`);
  if (info.url === installer) sha512 = digest;
  await stat(path.join(directory, info.url + '.blockmap'));
}
if (metadata.sha512 !== sha512) throw new Error('Installer hash differs from latest.yml.');
// A full installer redistributes Blender; publish its matching source beside it.
const blenderSource = JSON.parse(await readFile(path.join(directory, 'win-unpacked/resources/runtime/blender-source.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(blenderSource.version) || blenderSource.archive !== `blender-${blenderSource.version}.tar.xz`) throw new Error('Invalid Blender source metadata.');
const archive = process.env.STILL_BLENDER_SOURCE_ARCHIVE;
if (!archive || path.basename(archive) !== blenderSource.archive) throw new Error(`Set STILL_BLENDER_SOURCE_ARCHIVE to the matching ${blenderSource.archive} from ${blenderSource.upstream}.`);
// Read only the version header from the archive; do not extract into the workspace.
const header = run('tar', ['-xOf', path.resolve(archive), `blender-${blenderSource.version}/source/blender/blenkernel/BKE_blender_version.h`]);
const [major, minor, patch] = blenderSource.version.split('.').map(Number);
if (Number(/#define BLENDER_VERSION\s+(\d+)/.exec(header)?.[1]) !== major * 100 + minor || Number(/#define BLENDER_VERSION_PATCH\s+(\d+)/.exec(header)?.[1]) !== patch) throw new Error('Blender source archive does not match the bundled version.');
const sourceDestination = path.join(directory, blenderSource.archive);
if (path.resolve(archive) !== sourceDestination) await copyFile(archive, sourceDestination);
blenderSource.sha256 = createHash('sha256').update(await readFile(sourceDestination)).digest('hex');
await writeFile(path.join(directory, 'blender-source.json'), JSON.stringify(blenderSource, null, 2) + '\n');
await copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(directory, 'THIRD_PARTY_NOTICES.md'));
const assets = [installer, installer + '.blockmap', updateInstaller, updateInstaller + '.blockmap', 'latest.yml', blenderSource.archive, 'blender-source.json', 'THIRD_PARTY_NOTICES.md'];
const sums = [];
for (const file of assets) sums.push(`${createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')}  ${file}`);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
assets.push('SHA256SUMS.txt');
await writeFile(path.join(directory, 'release-source.json'), JSON.stringify({ repository: repo, version, commit, installer, sha512, updateInstaller, runtimeId }, null, 2) + '\n');
assets.push('release-source.json');
let previous;
try { previous = api([`repos/${repo}/releases/latest`]); }
catch (error) { if (!String(error.stderr || '').includes('HTTP 404')) throw error; }
if (previous && !semver.gt(version, previous.tag_name.replace(/^v/, ''))) throw new Error('The release version must be newer than the current stable release.');
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
  try {
    const taggedCommit = run('git', ['rev-list', '-n', '1', tag]);
    if (taggedCommit && taggedCommit !== commit) throw new Error('The version tag points to another commit.');
  } catch (error) { if (!String(error.stderr || '').includes('unknown revision')) throw error; }
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
  const digest = createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex');
  // A missing digest is not proof of a successful upload. Leave the release
  // in draft; retry after GitHub has completed processing the assets.
  if (asset.digest !== `sha256:${digest}`) throw new Error(`GitHub asset hash is unavailable or differs: ${file}. The release remains a draft.`);
}
verifyRemoteTag();
gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
const published = api([`repos/${repo}/releases/${release.id}`]);
if (published.draft || published.prerelease || published.tag_name !== tag || published.target_commitish !== commit) throw new Error('GitHub did not confirm the stable published release. Inspect the release before retrying.');
verifyRemoteTag();
console.log(`Published https://github.com/${repo}/releases/tag/${tag}`);
