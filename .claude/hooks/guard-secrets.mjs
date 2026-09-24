#!/usr/bin/env node
// Refuses to commit files that must stay local: anything .gitignore covers
// (so it could only have been staged with `git add -f`) and obvious key files.
// Also refuses the ways around the pre-commit gate.
//
//   node .claude/hooks/guard-secrets.mjs --staged   git pre-commit (husky)
//   node .claude/hooks/guard-secrets.mjs            Claude Code PreToolUse(Bash), JSON on stdin
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gitInvocations, parseOptions } from './git-commands.mjs';

const KEY_FILE = /(^|\/)(id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.key|[^/]+\.p12)$/;

const git = (dir, args, input) =>
  execFileSync('git', dir ? ['-C', dir, ...args] : args, { encoding: 'utf8', input });

function ignored(dir, paths) {
  try {
    return new Set(git(dir, ['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0')).split('\0').filter(Boolean));
  } catch {
    return new Set(); // exit 1: nothing is ignored
  }
}

function stagedOffenders(dir) {
  const paths = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const hits = ignored(dir, paths);
  return paths.filter((p) => hits.has(p) || KEY_FILE.test(p));
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function report(files) {
  refuse(
    `Blocked: these staged files must stay local (gitignored or key files):\n` +
      files.map((f) => `  ${f}`).join('\n') +
      `\nUnstage them with: git restore --staged <file>`,
  );
}

if (process.argv.includes('--staged')) {
  const files = stagedOffenders();
  if (files.length) report(files);
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}').tool_input ?? {};
} catch {
  process.exit(0);
}

const COMMIT_SHORT_VALUE = ['m', 'F', 'C', 'c', 't'];
const COMMIT_LONG_VALUE = ['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file'];

for (const { env, config, dir, sub, args } of gitInvocations(String(input.command ?? ''))) {
  if (config.some((c) => c.toLowerCase().startsWith('core.hookspath'))) {
    refuse('Blocked: overriding core.hooksPath skips the pre-commit checks (format, lint, types, tests, build, secrets).');
  }
  if (sub === 'add' || sub === 'stage') {
    const { shorts, longs } = parseOptions(args, [], ['--chmod', '--pathspec-from-file']);
    if (shorts.has('f') || longs.has('--force')) {
      refuse('Blocked: `git add` with --force stages gitignored files, and those hold local secrets here. If the file belongs in the repo, change .gitignore on purpose instead.');
    }
  }
  if (sub === 'commit') {
    if (env.HUSKY === '0') refuse('Blocked: HUSKY=0 skips the pre-commit checks. Fix what they report instead.');
    const { shorts, longs } = parseOptions(args, COMMIT_SHORT_VALUE, COMMIT_LONG_VALUE, ['u', 'S']);
    if (shorts.has('n') || longs.has('--no-verify')) {
      refuse('Blocked: committing with --no-verify skips the pre-commit checks (format, lint, types, tests, build, secrets). Fix what they report instead.');
    }
    const files = stagedOffenders(dir);
    if (files.length) report(files);
  }
}
process.exit(0);
