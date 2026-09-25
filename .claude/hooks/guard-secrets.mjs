#!/usr/bin/env node
// This hook refuses to commit files that must stay local. These are the files
// that .gitignore covers and the files with key names. It also refuses the ways
// around the pre-commit gate.
//
//   node .claude/hooks/guard-secrets.mjs --staged   git pre-commit (husky)
//   node .claude/hooks/guard-secrets.mjs            Claude Code PreToolUse(Bash), JSON on stdin
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gitInvocations, parseOptions } from './git-commands.mjs';

const KEY_FILE = /(^|\/)(id_rsa|id_ed25519|[^/]+\.pem|[^/]+\.key|[^/]+\.p12)$/;

const git = (dir, args, input) =>
  execFileSync('git', dir ? ['-C', dir, ...args] : args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

function ignored(top, paths) {
  try {
    return new Set(git(top, ['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0')).split('\0').filter(Boolean));
  } catch (e) {
    if (e.status === 1) return new Set(); // Exit 1 means that no path is ignored.
    throw e;
  }
}

// Paths from `diff --cached` are relative to the repo root, so both commands run there.
function stagedOffenders(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
  const paths = git(top, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  const hits = paths.length ? ignored(top, paths) : new Set();
  return paths.filter((p) => hits.has(p) || KEY_FILE.test(p));
}

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function report(files) {
  refuse(
    `Blocked: these staged files must stay local. Git ignores them, or they have key names:\n` +
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
const GATE = 'the pre-commit checks (format, lint, types, tests, build, secrets)';

for (const { env, config, dir, sub, args } of gitInvocations(String(input.command ?? ''))) {
  if (config.some((c) => c.toLowerCase().startsWith('core.hookspath'))) refuse(`Blocked: a core.hooksPath override skips ${GATE}.`);
  if (config.some((c) => c.toLowerCase().startsWith('alias.'))) refuse('Blocked: a one-off git alias can hide options from this check. Write the git command in full.');
  if (sub === 'config' && args.some((a) => a.toLowerCase() === 'core.hookspath') && !args.some((a) => ['--get', '--get-all', '-l', '--list'].includes(a))) {
    refuse(`Blocked: a change to core.hooksPath turns off ${GATE}. Run npm ci to set up the hooks.`);
  }
  if (sub === 'add' || sub === 'stage') {
    const { shorts, longs } = parseOptions(args, [], ['--chmod', '--pathspec-from-file'], [], ['--force']);
    if (shorts.has('f') || longs.has('--force')) {
      refuse('Blocked: `git add` with --force stages gitignored files, and those files hold local secrets here. If the file belongs in the repo, change .gitignore on purpose.');
    }
  }
  if (sub === 'update-index' && args.includes('--add')) refuse('Blocked: `git update-index --add` can stage gitignored files. Use `git add`.');
  if (sub === 'commit') {
    if (env.HUSKY === '0') refuse(`Blocked: HUSKY=0 skips ${GATE}. Fix what they report.`);
    if (Object.keys(env).some((k) => k.startsWith('GIT_CONFIG'))) refuse(`Blocked: GIT_CONFIG_* variables can turn off ${GATE}.`);
    const { shorts, longs } = parseOptions(args, COMMIT_SHORT_VALUE, COMMIT_LONG_VALUE, ['u', 'S'], ['--no-verify']);
    if (shorts.has('n') || longs.has('--no-verify')) refuse(`Blocked: --no-verify skips ${GATE}. Fix what they report.`);
    let files;
    try {
      const hooks = git(dir, ['rev-parse', '--git-path', 'hooks']).trim();
      const hooksDir = isAbsolute(hooks) ? hooks : resolve(dir ?? '.', hooks);
      if (!existsSync(join(hooksDir, 'pre-commit'))) {
        refuse(`Blocked: this checkout has no pre-commit hook, so ${GATE} do not run. Run npm ci here first.`);
      }
      files = stagedOffenders(dir);
    } catch (e) {
      refuse(`Blocked: git did not list the staged files (${String(e.stderr || e.message).trim()}). Write the git -C path or the cd path literally.`);
    }
    if (files.length) report(files);
  }
}
process.exit(0);
