/** A release only ever moves the update feed forward. Refuse a commit that is
 * already released, or one that isn't built on top of the latest release (a
 * re-run of an old job, for example), so installed copies never update to older
 * code. Needs only Node and the GitHub CLI. */
import { execFileSync } from 'node:child_process';

const api = (route, jq) => {
  const out = execFileSync('gh', ['api', route, ...(jq ? ['--jq', jq] : [])], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  return jq ? out : JSON.parse(out);
};

export function assertReleasable(repo, commit) {
  let latest;
  try { latest = api(`repos/${repo}/releases/latest`); }
  catch (error) { if (String(error.stderr || '').includes('HTTP 404')) return; throw error; }
  let target = api(`repos/${repo}/git/ref/tags/${latest.tag_name}`).object;
  while (target.type === 'tag') target = api(`repos/${repo}/git/tags/${target.sha}`).object;
  if (target.type !== 'commit') throw new Error(`${latest.tag_name} does not point to a commit.`);
  if (target.sha === commit) throw new Error(`${commit.slice(0, 7)} is already released as ${latest.tag_name}.`);
  const status = api(`repos/${repo}/compare/${target.sha}...${commit}`, '.status');
  if (status !== 'ahead') throw new Error(`${commit.slice(0, 7)} is not newer than ${latest.tag_name} (${status}). Push a new commit to main to release.`);
}
