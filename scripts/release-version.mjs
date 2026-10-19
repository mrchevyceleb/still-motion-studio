/** Pick the version for an automatic release. Every push to main ships, so the
 * package.json version is only a floor: a build never reuses a published or draft
 * release (or a bare tag). A draft left by an interrupted run of this exact commit
 * is resumed instead of skipped, so re-running a failed job finishes that release. */
import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleasable } from './release-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.GITHUB_REPOSITORY || 'mrchevyceleb/still-motion-studio';
const run = (command, args) => execFileSync(command, args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
const parse = value => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || '')?.slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const minimum = parse(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
if (!minimum) throw new Error('Use a stable major.minor.patch version in package.json.');
const commit = process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']);
// Stop a publishing run before the long build if it could never publish.
if (process.env.PUBLISH === 'true') assertReleasable(repo, commit);
const releases = run('gh', ['api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', '.[] | {tag_name, draft, target_commitish}']).split('\n').filter(Boolean).map(line => JSON.parse(line));
const tags = run('git', ['tag', '--list', 'v*']).split('\n');
const used = [...releases.map(release => release.tag_name), ...tags].map(parse).filter(Boolean).sort(compare);
const highest = used.at(-1);
const published = releases.filter(release => !release.draft).map(release => parse(release.tag_name)).filter(Boolean).sort(compare).at(-1);
const resumable = releases.filter(release => release.draft && release.target_commitish === commit).map(release => parse(release.tag_name))
  .filter(value => value && compare(value, minimum) >= 0 && (!published || compare(value, published) > 0)).sort(compare).at(-1);
const next = resumable || (highest && compare(highest, minimum) >= 0 ? [highest[0], highest[1], highest[2] + 1] : minimum);
const version = next.join('.');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(version);
