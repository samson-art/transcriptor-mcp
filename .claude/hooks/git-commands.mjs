// The Claude Code hooks share this file. It turns a Bash command string into the
// git and gh commands that the shell runs. A hook then reads real options, not
// the text of commit messages, PR bodies or heredocs.
//
// ponytail: this is a small shell lexer, not a shell. It knows quotes, escapes,
// $(...), backticks, heredocs, here-strings, (( )), ; & | and newlines, keywords
// such as `then` and `do`, and wrappers such as `env`, `sh -c` and `eval`. CI
// runs the last check on the files in the repo (.github/workflows/ci.yml).

function skipHeredocBody(src, i, delim, strip) {
  // i is the start of a line. Skip lines until one line is the delimiter.
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const line = src.slice(i, nl < 0 ? src.length : nl);
    i = nl < 0 ? src.length : nl + 1;
    if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
  }
  return i;
}

function readHeredocDelim(src, i) {
  // i is the first '<' of '<<'. Returns [delim, strip, next index].
  i += 2;
  let strip = false;
  if (src[i] === '-') {
    strip = true;
    i++;
  }
  while (src[i] === ' ' || src[i] === '\t') i++;
  let delim = '';
  while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
    if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') delim += src[i];
    i++;
  }
  return [delim, strip, i];
}

// i is just after an opening backtick. Returns the index after the closing one.
function skipBacktick(src, i) {
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}

// Returns the index after the ')' that closes a '$(' that opened before i.
function skipSubstitution(src, i) {
  let depth = 1;
  const pending = [];
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j + 1;
    } else if (c === '"') {
      i = skipDoubleQuoted(src, i + 1, [])[1];
    } else if (c === '`') {
      i = skipBacktick(src, i + 1);
    } else if (c === '\\') {
      i += 2;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      i += 3;
    } else if (c === '<' && src[i + 1] === '<') {
      const [delim, strip, next] = readHeredocDelim(src, i);
      if (delim) pending.push([delim, strip]);
      i = next;
    } else if (c === '\n') {
      i++;
      while (pending.length) i = skipHeredocBody(src, i, ...pending.shift());
    } else {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
  }
  return i;
}

// i is just after the opening '"'. Returns [text, index after the closing '"'].
// The shell runs $(...) and backticks inside double quotes, so their bodies go to `nested`.
function skipDoubleQuoted(src, i, nested) {
  let text = '';
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\' && i + 1 < src.length) {
      text += src[i + 1];
      i += 2;
    } else if (src[i] === '$' && src[i + 1] === '(') {
      const end = skipSubstitution(src, i + 2);
      nested.push(src.slice(i + 2, end - 1));
      text += src.slice(i, end);
      i = end;
    } else if (src[i] === '`') {
      const end = skipBacktick(src, i + 1);
      nested.push(src.slice(i + 1, end - 1));
      text += src.slice(i, end);
      i = end;
    } else {
      text += src[i++];
    }
  }
  return [text, i + 1];
}

/** Splits a command string into simple commands, each a list of words. Includes the commands inside $(...) and backticks. */
export function simpleCommands(src) {
  src = src.replace(/\r\n?/g, '\n');
  const out = [];
  const nested = [];
  let words = [];
  let cur = null;
  const pending = [];
  const push = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const end = () => {
    push();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const e = j < 0 ? src.length : j;
      cur = (cur ?? '') + src.slice(i + 1, e);
      i = e;
    } else if (c === '"') {
      const [text, next] = skipDoubleQuoted(src, i + 1, nested);
      cur = (cur ?? '') + text;
      i = next - 1;
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') cur = (cur ?? '') + src[i + 1];
      i++;
    } else if (c === '$' && src[i + 1] === '(') {
      const e = skipSubstitution(src, i + 2);
      nested.push(src.slice(i + 2, e - 1));
      cur = (cur ?? '') + src.slice(i, e);
      i = e - 1;
    } else if (c === '`') {
      const e = skipBacktick(src, i + 1);
      nested.push(src.slice(i + 1, e - 1));
      cur = (cur ?? '') + src.slice(i, e);
      i = e - 1;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      // A here-string. The next word is data, not a heredoc delimiter.
      push();
      i += 2;
    } else if (c === '<' && src[i + 1] === '<') {
      push();
      const [delim, strip, next] = readHeredocDelim(src, i);
      if (delim) pending.push([delim, strip]);
      i = next - 1;
    } else if (c === '\n') {
      end();
      let j = i + 1;
      while (pending.length) j = skipHeredocBody(src, j, ...pending.shift());
      i = j - 1;
    } else if (c === '(' && src[i + 1] === '(') {
      // Arithmetic: (( a << b )) is not a heredoc.
      end();
      const e = src.indexOf('))', i + 2);
      i = e < 0 ? src.length : e + 1;
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      end();
    } else if (c === ' ' || c === '\t') {
      push();
    } else if (c === '#' && cur === null) {
      const nl = src.indexOf('\n', i);
      i = (nl < 0 ? src.length : nl) - 1;
    } else {
      cur = (cur ?? '') + c;
    }
  }
  end();
  for (const n of nested) out.push(...simpleCommands(n));
  return out;
}

const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'sudo']);
const SHELL = /(^|\/)(sh|bash|zsh|dash)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function joinDir(base, dir) {
  if (dir?.startsWith('~')) dir = (process.env.HOME ?? '~') + dir.slice(1);
  if (!base || dir === undefined) return dir ?? base;
  return dir.startsWith('/') ? dir : `${base}/${dir}`;
}

/**
 * The commands that the shell runs, after it drops assignments, keywords and
 * wrappers: [{ env, dir, words }]. `dir` comes from a literal `cd` earlier in
 * the string. `export NAME=value` carries into later commands.
 */
export function commands(src) {
  const found = [];
  const exported = {};
  let base;
  const walk = (text) => {
    for (const raw of simpleCommands(text)) {
      if (raw[0] === 'export') {
        for (const w of raw.slice(1)) if (ASSIGNMENT.test(w)) exported[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1);
        continue;
      }
      const env = { ...exported };
      let i = 0;
      let words = null;
      while (i < raw.length) {
        const w = raw[i];
        if (ASSIGNMENT.test(w)) {
          env[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1);
          i++;
        } else if (KEYWORDS.has(w)) {
          i++;
        } else if (w === 'env' || w === 'xargs' || w === 'timeout') {
          i++;
          while (raw[i]?.startsWith('-')) i += ['-u', '-n', '-I', '-L', '-P', '-s', '-k'].includes(raw[i]) ? 2 : 1;
          if (w === 'timeout' && raw[i]) i++;
        } else if (SHELL.test(w) && raw[i + 1] === '-c') {
          walk(raw[i + 2] ?? '');
          break;
        } else if (w === 'eval') {
          walk(raw.slice(i + 1).join(' '));
          break;
        } else {
          words = raw.slice(i);
          break;
        }
      }
      if (!words) continue;
      if (words[0] === 'cd') {
        base = joinDir(base, words[1] ?? '~');
        continue;
      }
      found.push({ env, dir: base, words });
    }
  };
  walk(src);
  return found;
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/**
 * The git commands in a command string:
 * { env: {NAME: value}, config: ['k=v', ...], dir: the directory git runs in, or undefined, sub: 'commit', args: [...] }.
 */
export function gitInvocations(src) {
  const found = [];
  for (const { env, dir: base, words } of commands(src)) {
    if (!/(^|\/)git$/.test(words[0])) continue;
    let i = 1;
    const config = [];
    let dir = base;
    while (i < words.length && words[i].startsWith('-')) {
      const w = words[i];
      if (GIT_GLOBAL_WITH_VALUE.has(w)) {
        if (w === '-c' || w === '--config-env') config.push(words[i + 1] ?? '');
        if (w === '-C') dir = joinDir(dir, words[i + 1]);
        i += 2;
      } else {
        if (w.startsWith('--config-env=')) config.push(w.slice(13));
        i++;
      }
    }
    if (i < words.length) found.push({ env, config, dir, sub: words[i], args: words.slice(i + 1) });
  }
  return found;
}

/**
 * Walks options the way git's parser does for one subcommand.
 * shortWithValue: short letters that take a value (the rest of the cluster or the next word).
 * longWithValue: long options that take the next word as value when they have no '='.
 * shortWithOptional: short letters whose optional value is always attached (-uno, -Skey).
 * knownLongs: other long options to recognise. Git accepts a unique prefix of a
 * long option, so `--no-verif` is reported as `--no-verify`.
 * Returns { shorts: Set of short letters, longs: Set, positionals: [] }.
 */
export function parseOptions(args, shortWithValue, longWithValue, shortWithOptional = [], knownLongs = []) {
  const shorts = new Set();
  const longs = new Set();
  const positionals = [];
  const known = [...longWithValue, ...knownLongs];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let name = a.split('=')[0];
      const matches = known.filter((k) => k.startsWith(name));
      if (!known.includes(name) && name.length > 3 && matches.length === 1) name = matches[0];
      longs.add(name);
      if (!a.includes('=') && longWithValue.includes(name)) i++;
    } else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        shorts.add(a[k]);
        if (shortWithOptional.includes(a[k])) break;
        if (shortWithValue.includes(a[k])) {
          if (k === a.length - 1) i++;
          break;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { shorts, longs, positionals };
}
