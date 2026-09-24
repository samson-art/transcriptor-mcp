#!/usr/bin/env node
// Claude Code PreToolUse(Bash) hook. Before a release tag (`git tag v…` or
// `gh release create v…`), proves the target is the merge commit of a merged PR
// and that it contains every commit of that PR — including review fixes pushed
// after someone clicked Merge. v1.4.1 shipped without its review fixes that way.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gitInvocations, parseOptions, simpleCommands } from './git-commands.mjs';

let cwd; // the -C directory of the tag command, if any
const run = (bin, args) => execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (...args) => run('git', args);
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return '';
  }
};

function refuse(message) {
  process.stderr.write(`Blocked release tag: ${message}\n`);
  process.exit(2);
}

const TAG_LIST_MODE = ['--list', '--delete', '--verify', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--column', '--no-column'];
const isRelease = (tag) => /^v\d/.test(tag);
// A shell-built name that could expand to a release version: `v$X`, `$TAG`, a backtick command.
const isDynamicRelease = (word) => /[$`]/.test(word) && /^(v|\$|`)/.test(word);

function releaseFromGitTag(args) {
  const { shorts, longs, positionals } = parseOptions(args, ['m', 'F', 'u', 'n'], ['--message', '--file', '--local-user', '--cleanup', '--trailer', '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--column']);
  if (['l', 'd', 'v', 'n'].some((s) => shorts.has(s)) || TAG_LIST_MODE.some((l) => longs.has(l))) return null;
  const [tag, commit] = positionals;
  if (!tag) return null;
  if (isDynamicRelease(tag)) refuse(`the tag name "${tag}" is built by the shell. Write the version literally so it can be checked.`);
  return isRelease(tag) ? { tag, target: commit ?? 'HEAD' } : null;
}

function releaseFromGh(words) {
  const args = words.slice(3);
  const { positionals } = parseOptions(args, ['t', 'n', 'F', 'R'], ['--target', '--title', '--notes', '--notes-file', '--notes-start-tag', '--discussion-category', '--repo']);
  const tag = positionals[0];
  if (!tag) return null;
  if (isDynamicRelease(tag)) refuse(`the tag name "${tag}" is built by the shell. Write the version literally so it can be checked.`);
  if (!isRelease(tag)) return null;
  if (tryGit('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) return { tag, target: `refs/tags/${tag}` };
  const eq = args.find((a) => a.startsWith('--target='));
  const at = args.indexOf('--target');
  if (eq) return { tag, target: eq.slice('--target='.length) };
  if (at >= 0) return { tag, target: args[at + 1] };
  tryGit('fetch', '-q', 'origin', 'main');
  return { tag, target: 'origin/main' };
}

function findRelease(cmd) {
  for (const { dir, sub, args } of gitInvocations(cmd)) {
    if (sub === 'tag') {
      cwd = dir;
      const r = releaseFromGitTag(args);
      if (r) return r;
      cwd = undefined;
    }
  }
  for (const words of simpleCommands(cmd)) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const w = words.slice(i);
    if (/(^|\/)gh$/.test(w[0] ?? '') && w[1] === 'release' && w[2] === 'create') {
      const r = releaseFromGh(w);
      if (r) return r;
    }
  }
  return null;
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_input ?? {};
} catch {
  process.exit(0);
}
const release = findRelease(String(input.command ?? ''));
if (!release) process.exit(0);

const sha = tryGit('rev-parse', `${release.target}^{commit}`);
if (!sha) refuse(`cannot resolve "${release.target}" for ${release.tag} to a commit.`);

let pr;
try {
  const prs = JSON.parse(
    run('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '[.[] | select(.merged_at) | {number, ref: .head.ref, head: .head.sha, merge: .merge_commit_sha, sameRepo: (.head.repo.full_name == .base.repo.full_name)}]']),
  );
  pr = prs.find((p) => p.merge === sha);
} catch (e) {
  refuse(`could not ask GitHub which PR ${sha.slice(0, 7)} merged (${String(e.stderr || e.message).trim()}). Push the merge commit, or check ancestry by hand and let the maintainer tag.`);
}
if (!pr) {
  refuse(`${sha.slice(0, 7)} is not the merge commit of a merged PR. Tag the "Merge pull request #N" commit on main after pulling it.`);
}

const tips = new Map([[pr.head, 'PR head at merge']]);
// Branch tips only mean something when the PR branch lives in this repo; a fork's
// branch name can collide with an unrelated branch here.
if (pr.sameRepo) {
  const remoteTip = tryGit('ls-remote', 'origin', `refs/heads/${pr.ref}`).split(/\s/)[0];
  if (remoteTip) {
    tryGit('fetch', '-q', 'origin', pr.ref);
    tips.set(remoteTip, `origin/${pr.ref}`);
  }
  const localTip = tryGit('rev-parse', '-q', '--verify', `refs/heads/${pr.ref}`);
  if (localTip) tips.set(localTip, `local ${pr.ref}`);
}

const missing = [];
for (const [tip, where] of tips) {
  if (tryGit('cat-file', '-t', tip) !== 'commit') {
    missing.push(`${where} ${tip.slice(0, 7)} is not available locally (git fetch, then retry)`);
    continue;
  }
  try {
    git('merge-base', '--is-ancestor', tip, sha);
  } catch {
    const log = tryGit('log', '--oneline', `${sha}..${tip}`);
    missing.push(`${where} has commits that ${release.tag} would not contain:\n${log.replace(/^/gm, '    ')}`);
  }
}

if (missing.length) {
  refuse(
    `${release.tag} points at ${sha.slice(0, 7)}, the merge of #${pr.number}, which does not contain the whole PR.\n` +
      missing.map((m) => `  ${m}`).join('\n') +
      `\nOpen a follow-up PR with those commits and tag its merge commit instead.`,
  );
}
process.exit(0);
