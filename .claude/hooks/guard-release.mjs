#!/usr/bin/env node
// Claude Code PreToolUse(Bash) hook, and the first check in publish-docker.yml.
// A v* tag push deploys production. Before a command creates or pushes a v* tag,
// this hook makes sure that the tag points at the merge commit of a merged PR.
// The merge must also contain every commit of that PR, with the review fixes
// that came after someone clicked Merge. v1.4.1 shipped without its review fixes.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { commands, gitInvocations, parseOptions } from './git-commands.mjs';

const NETWORK = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};
const run = (cwd, bin, args) =>
  execFileSync(bin, args, { cwd, env: NETWORK, timeout: 20000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return run(cwd, 'git', args);
  } catch {
    return '';
  }
};

function refuse(message) {
  process.stderr.write(`Blocked release tag: ${message}\n`);
  process.exit(2);
}

const TAG_LIST_MODE = ['--list', '--delete', '--verify', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const TAG_LONG_VALUE = ['--message', '--file', '--local-user', '--cleanup', '--trailer', '--sort', '--format', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const isRelease = (tag) => /^v/.test(tag);
// A name that the shell builds, and that can expand to a release version: `v$X`, `$TAG`, a backtick command.
const isDynamicRelease = (word) => /[$`]/.test(word) && /^(v|\$|`)/.test(word);
const isSha = (word) => /^[0-9a-f]{7,40}$/i.test(word ?? '');
const NAME_THE_SHA = 'Name the merge commit by its sha, as in `git tag -a vX.Y.Z -m vX.Y.Z <merge sha>`.';

function checkName(tag) {
  if (isDynamicRelease(tag)) refuse(`the shell builds the tag name "${tag}". Write the version literally, so that this hook can check it.`);
  return isRelease(tag);
}

function fromGitTag(args, dir) {
  const { shorts, longs, positionals } = parseOptions(args, ['m', 'F', 'u', 'n'], TAG_LONG_VALUE);
  if (['l', 'd', 'v', 'n'].some((s) => shorts.has(s)) || TAG_LIST_MODE.some((l) => longs.has(l))) return [];
  const [tag, commit] = positionals;
  if (!tag || !checkName(tag)) return [];
  if (!isSha(commit)) refuse(`${tag} has no explicit commit. ${NAME_THE_SHA}`);
  return [{ tag, target: commit, dir }];
}

function fromGitPush(args, dir) {
  const { longs, positionals } = parseOptions(args, ['o'], ['--repo', '--receive-pack', '--exec', '--push-option']);
  if (['--tags', '--follow-tags', '--mirror'].some((l) => longs.has(l))) refuse('push each release tag by its name, so that this hook can check it.');
  const found = [];
  const specs = positionals.slice(1);
  for (let k = 0; k < specs.length; k++) {
    let spec = specs[k].replace(/^\+/, '');
    if (spec === 'tag') spec = specs[++k] ?? '';
    const [src, dst = src] = spec.includes(':') ? spec.split(':') : [spec];
    const name = dst.replace(/^refs\/tags\//, '');
    if (!src || dst.startsWith('refs/heads/') || !checkName(name)) continue;
    if (spec.includes(':')) {
      if (dst.startsWith('refs/tags/') || tryGit(dir, 'rev-parse', '-q', '--verify', `refs/tags/${name}`)) found.push({ tag: name, target: src, dir });
    } else if (tryGit(dir, 'rev-parse', '-q', '--verify', `refs/tags/${name}`)) {
      found.push({ tag: name, target: `refs/tags/${name}`, dir });
    }
  }
  return found;
}

function fromGh(words, dir) {
  const args = words.slice(3);
  const { positionals } = parseOptions(args, ['t', 'n', 'F', 'R'], ['--target', '--title', '--notes', '--notes-file', '--notes-start-tag', '--discussion-category', '--repo']);
  const tag = positionals[0];
  if (!tag || !checkName(tag)) return [];
  const eq = args.find((a) => a.startsWith('--target='));
  const target = eq ? eq.slice('--target='.length) : args[args.indexOf('--target') + 1];
  if (args.indexOf('--target') < 0 && !eq) refuse(`gh release create ${tag} has no --target. Pass --target <merge sha>.`);
  if (!isSha(target)) refuse(`the --target of ${tag} is not a commit sha. ${NAME_THE_SHA}`);
  return [{ tag, target, dir }];
}

function findReleases(cmd) {
  const found = [];
  for (const { dir, sub, args } of gitInvocations(cmd)) {
    if (sub === 'tag') found.push(...fromGitTag(args, dir));
    if (sub === 'push') found.push(...fromGitPush(args, dir));
    if (sub === 'update-ref' && !args.includes('-d') && args.some((a) => /^refs\/tags\/v/.test(a))) {
      refuse('create release tags with `git tag`, so that this hook can check them.');
    }
  }
  for (const { dir, words } of commands(cmd)) {
    if (/(^|\/)gh$/.test(words[0]) && words[1] === 'release' && ['create', 'new'].includes(words[2])) found.push(...fromGh(words, dir));
    if (/(^|\/)gh$/.test(words[0]) && words[1] === 'api' && words.some((w) => /refs\/tags\/v/.test(w))) {
      refuse('create release tags with `git tag`, so that this hook can check them.');
    }
    if (/(^|\/)npm$/.test(words[0]) && words[1] === 'version' && words[2] && !words.some((w) => /^--(no-git-tag-version|git-tag-version=false)$/.test(w))) {
      refuse('`npm version` creates a v* tag on a commit that is not a merge. Add --no-git-tag-version.');
    }
  }
  return found;
}

function check({ tag, target, dir }) {
  const sha = tryGit(dir, 'rev-parse', `${target}^{commit}`);
  if (!sha) refuse(`"${target}" for ${tag} does not resolve to a commit. Fetch it first.`);

  let pr;
  try {
    const prs = JSON.parse(
      run(dir, 'gh', ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '[.[] | select(.merged_at) | {number, ref: .head.ref, head: .head.sha, merge: .merge_commit_sha, sameRepo: (.head.repo.full_name == .base.repo.full_name)}]']),
    );
    pr = prs.find((p) => p.merge === sha);
  } catch (e) {
    refuse(`GitHub did not say which PR ${sha.slice(0, 7)} merged (${String(e.stderr || e.message).trim()}). Push the merge commit, or let the maintainer tag.`);
  }
  if (!pr) refuse(`${sha.slice(0, 7)} is not the merge commit of a merged PR. Tag the "Merge pull request #N" commit on main.`);

  const tips = new Map([[pr.head, 'PR head at merge']]);
  // A fork's branch name can match an unrelated branch in this repo, so branch tips count only for branches of this repo.
  if (pr.sameRepo) {
    let remoteTip = '';
    try {
      remoteTip = run(dir, 'git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${pr.ref}`]).split(/\s/)[0];
    } catch (e) {
      // Exit 2 means that the branch is gone. Any other failure hides a possible late commit.
      if (e.status !== 2) refuse(`origin did not answer for branch ${pr.ref} (${String(e.stderr || e.message).trim()}). The branch can hold late review fixes.`);
    }
    if (remoteTip) {
      if (tryGit(dir, 'cat-file', '-t', remoteTip) !== 'commit') tryGit(dir, 'fetch', '-q', '--no-write-fetch-head', 'origin', pr.ref);
      tips.set(remoteTip, `origin/${pr.ref}`);
    }
    const localTip = tryGit(dir, 'rev-parse', '-q', '--verify', `refs/heads/${pr.ref}`);
    if (localTip) tips.set(localTip, `local ${pr.ref}`);
  }

  const missing = [];
  for (const [tip, where] of tips) {
    if (tryGit(dir, 'cat-file', '-t', tip) !== 'commit') {
      missing.push(`${where} ${tip.slice(0, 7)} is not in this clone. Run git fetch, then try again.`);
      continue;
    }
    try {
      run(dir, 'git', ['merge-base', '--is-ancestor', tip, sha]);
    } catch {
      const log = tryGit(dir, 'log', '--oneline', `${sha}..${tip}`);
      missing.push(`${where} has commits that ${tag} does not contain:\n${log.replace(/^/gm, '    ')}`);
    }
  }
  if (missing.length) {
    refuse(
      `${tag} points at ${sha.slice(0, 7)}, the merge of #${pr.number}. That merge does not contain the whole PR.\n` +
        missing.map((m) => `  ${m}`).join('\n') +
        `\nOpen a follow-up PR with those commits, and tag its merge commit.`,
    );
  }
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_input ?? {};
} catch {
  process.exit(0);
}
for (const release of findReleases(String(input.command ?? ''))) check(release);
process.exit(0);
