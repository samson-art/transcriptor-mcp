#!/usr/bin/env node
// Self-check for the Claude Code hooks: node .claude/hooks/guards.check.mjs
// Needs network (gh) for the release cases.
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const hook = (file, command) =>
  spawnSync('node', [fileURLToPath(new URL(file, import.meta.url))], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  });

const mergeOf = (pr) =>
  execFileSync('git', ['log', '--merges', '--format=%h', `--grep=Merge pull request #${pr} `], { encoding: 'utf8' }).split('\n')[0];

const FORCE = ['git', 'add', '-f'].join(' ');
const NO_VERIFY = '--no-' + 'verify';
const message = `Explain why ${FORCE} and ${NO_VERIFY} are refused\n\ngit tag v9.9.9 comes later.`;

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
  ['guard-secrets.mjs', `git commit -m \`printf 'x\n${FORCE} y'\``, 0],
  ['guard-secrets.mjs', `${FORCE} cookies.txt`, 2],
  ['guard-secrets.mjs', 'git add -Af cookies.txt', 2],
  ['guard-secrets.mjs', 'git stage -f cookies.txt', 2],
  ['guard-secrets.mjs', 'git -C /tmp/x add --force .env', 2],
  ['guard-secrets.mjs', `git commit ${NO_VERIFY} -m x`, 2],
  ['guard-secrets.mjs', 'git commit -nm x', 2],
  ['guard-secrets.mjs', 'echo ok\ngit commit -anm x', 2],
  ['guard-secrets.mjs', 'HUSKY=0 git commit -m x', 2],
  ['guard-secrets.mjs', 'git -c core.hooksPath=/dev/null commit -m x', 2],
  // guard-release
  ['guard-release.mjs', 'git tag -l', 0],
  ['guard-release.mjs', 'git --no-pager tag --contains v1.5.8', 0],
  ['guard-release.mjs', 'git tag -n5 v1.5.8', 0],
  ['guard-release.mjs', 'git tag feature-x', 0],
  ['guard-release.mjs', 'git tag "backup-$(date +%F)"', 0],
  ['guard-release.mjs', 'gh pr create --body "the next step is git tag v1.5.9"', 0],
  ['guard-release.mjs', `git tag v0.0.0-check ${mergeOf(43)}`, 0],
  // v1.4.1: merged with its first commit only; the review fix landed on the branch later.
  ['guard-release.mjs', `git tag -a v0.0.0-check -m "x" ${mergeOf(32)}`, 2],
  ['guard-release.mjs', `git tag -am "x" v0.0.0-check ${mergeOf(32)}`, 2],
  ['guard-release.mjs', `git -c a.b=c tag v0.0.0-check ${mergeOf(32)}`, 2],
  ['guard-release.mjs', `echo ok\ngit tag v0.0.0-check ${mergeOf(32)}`, 2],
  ['guard-release.mjs', `gh release create v0.0.0-check --target=${mergeOf(32)} --notes x`, 2],
  // Not a merge commit: the PR head, and a PR commit from before its review fixes.
  ['guard-release.mjs', `git tag v0.0.0-check ${mergeOf(43)}^2`, 2],
  ['guard-release.mjs', `git tag v0.0.0-check ${mergeOf(43)}^2~1`, 2],
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
