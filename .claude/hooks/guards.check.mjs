#!/usr/bin/env node
// Self-check for the Claude Code hooks: node .claude/hooks/guards.check.mjs
// Run it from the repo root, after npm ci. The release cases need gh and network access.
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const hook = (file, command) =>
  spawnSync('node', [fileURLToPath(new URL(file, import.meta.url))], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const mergeOf = (pr) => git('log', '--merges', '--format=%H', `--grep=Merge pull request #${pr} `).split('\n')[0];

const good = mergeOf(43);
// v1.4.1: the merge has only the first commit of PR #32. The review fix landed on the branch later.
const bad = mergeOf(32);
const prHead = git('rev-parse', `${good}^2`);
const beforeFixes = git('rev-parse', `${good}^2~1`);

const FORCE = ['git', 'add', '-f'].join(' ');
const NO_VERIFY = '--no-' + 'verify';
const message = `Say why ${FORCE} and ${NO_VERIFY} are refused\n\ngit tag v9.9.9 comes later.`;

const cases = [
  // guard-secrets
  ['guard-secrets.mjs', 'npm test', 0],
  ['guard-secrets.mjs', 'git add -A', 0],
  ['guard-secrets.mjs', `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`, 0],
  ['guard-secrets.mjs', `gh pr create --title x --body "$(cat <<'EOF'\n${message}\nEOF\n)"`, 0],
  ['guard-secrets.mjs', `git commit -F - <<'EOF'\n${message}\nEOF`, 0],
  ['guard-secrets.mjs', 'git commit -m "-n is fine inside a message"', 0],
  ['guard-secrets.mjs', 'grep -n -- "--force" README.md', 0],
  ['guard-secrets.mjs', 'git commit -uno -m x', 0],
  ['guard-secrets.mjs', 'git config --get core.hooksPath', 0],
  ['guard-secrets.mjs', `${FORCE} cookies.txt`, 2],
  ['guard-secrets.mjs', 'git add -Af cookies.txt', 2],
  ['guard-secrets.mjs', 'git add --forc cookies.txt', 2],
  ['guard-secrets.mjs', 'git stage -f cookies.txt', 2],
  ['guard-secrets.mjs', 'git update-index --add cookies.txt', 2],
  ['guard-secrets.mjs', 'git -C /tmp/x add --force .env', 2],
  ['guard-secrets.mjs', `git commit ${NO_VERIFY} -m x`, 2],
  ['guard-secrets.mjs', 'git commit --no-verif -m x', 2],
  ['guard-secrets.mjs', 'git commit -nm x', 2],
  ['guard-secrets.mjs', 'echo ok\ngit commit -anm x', 2],
  ['guard-secrets.mjs', 'HUSKY=0 git commit -m x', 2],
  ['guard-secrets.mjs', 'env HUSKY=0 git commit -m x', 2],
  ['guard-secrets.mjs', 'export HUSKY=0; git commit -m x', 2],
  ['guard-secrets.mjs', 'GIT_CONFIG_COUNT=1 git commit -m x', 2],
  ['guard-secrets.mjs', 'git -c core.hooksPath=/dev/null commit -m x', 2],
  ['guard-secrets.mjs', 'git --config-env core.hooksPath=V commit -m x', 2],
  ['guard-secrets.mjs', 'git config core.hooksPath /dev/null', 2],
  ['guard-secrets.mjs', 'git -c alias.ci=commit ci -m x', 2],
  ['guard-secrets.mjs', 'for f in cookies.txt; do git add -f "$f"; done', 2],
  ['guard-secrets.mjs', '{ git commit -n -m x; }', 2],
  ['guard-secrets.mjs', 'sh -c "git commit -n -m x"', 2],
  ['guard-secrets.mjs', 'echo $(git commit -n -m x)', 2],
  ['guard-secrets.mjs', 'cat <<< "x"\ngit commit -n -m x', 2],
  ['guard-secrets.mjs', 'cat >f <<EOF\r\nhi\r\nEOF\r\ngit commit -n -m x', 2],
  ['guard-secrets.mjs', '(( k = 1 << 2 ))\ngit commit -n -m x', 2],
  ['guard-secrets.mjs', 'R=/nonexistent; git -C "$R" commit -m x', 2],
  // guard-release
  ['guard-release.mjs', 'git tag -l', 0],
  ['guard-release.mjs', 'git --no-pager tag --contains v1.5.8', 0],
  ['guard-release.mjs', 'git tag -n5 v1.5.8', 0],
  ['guard-release.mjs', 'git tag feature-x', 0],
  ['guard-release.mjs', 'git push origin main', 0],
  ['guard-release.mjs', 'npm version 9.9.9 --no-git-tag-version', 0],
  ['guard-release.mjs', 'gh pr create --body "the next step is git tag v1.5.9"', 0],
  ['guard-release.mjs', `git tag -a v0.0.0-check -m x ${good}`, 0],
  ['guard-release.mjs', `git tag -a v0.0.0-check -m "x" ${bad}`, 2],
  ['guard-release.mjs', `git tag -am "x" v0.0.0-check ${bad}`, 2],
  ['guard-release.mjs', `git tag -a --mess notes v0.0.0-check ${bad}`, 2],
  ['guard-release.mjs', `git tag --sort=refname v0.0.0-check ${bad}`, 2],
  ['guard-release.mjs', `git tag vnext ${bad}`, 2],
  ['guard-release.mjs', `git -c a.b=c tag v0.0.0-check ${bad}`, 2],
  ['guard-release.mjs', `echo ok\ngit tag v0.0.0-check ${bad}`, 2],
  ['guard-release.mjs', `if true; then git tag -a v0.0.0-check -m x ${bad}; fi`, 2],
  ['guard-release.mjs', `git tag -a v0.0.0-a -m x ${good} && git tag -a v0.0.0-b -m x ${bad}`, 2],
  ['guard-release.mjs', 'git pull --ff-only && git tag -a v0.0.0-check -m v0.0.0-check', 2],
  ['guard-release.mjs', `gh release create v0.0.0-check --target=${bad} --notes x`, 2],
  ['guard-release.mjs', 'gh release create v0.0.0-check --target main --notes x', 2],
  ['guard-release.mjs', `gh release new v0.0.0-check --target ${bad}`, 2],
  ['guard-release.mjs', `git push origin ${bad}:refs/tags/v0.0.0-check`, 2],
  ['guard-release.mjs', 'git push --follow-tags', 2],
  ['guard-release.mjs', `git update-ref refs/tags/v0.0.0-check ${good}`, 2],
  ['guard-release.mjs', 'npm version 9.9.9', 2],
  // Not merge commits: the PR head, and a PR commit from before its review fixes.
  ['guard-release.mjs', `git tag v0.0.0-check ${prHead}`, 2],
  ['guard-release.mjs', `git tag v0.0.0-check ${beforeFixes}`, 2],
  ['guard-release.mjs', 'git tag "v$VERSION"', 2],
];

let failed = 0;
for (const [file, command, want] of cases) {
  const { status, stderr } = hook(file, command);
  const label = command.split('\n')[0].slice(0, 90);
  try {
    assert.equal(status, want);
    console.log(`ok   ${file} ${label}`);
  } catch {
    failed++;
    console.log(`FAIL ${file} ${label}: exit ${status}, want ${want}\n${stderr}`);
  }
}
process.exit(failed ? 1 : 0);
