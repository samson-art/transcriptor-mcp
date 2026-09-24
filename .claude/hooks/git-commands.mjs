// Shared by the Claude Code hooks: turns a Bash command string into the git
// invocations it runs, so a hook looks at real options and never at text inside
// commit messages, PR bodies, heredocs or $(...).
//
// ponytail: a small shell lexer (quotes, escapes, $(...), heredocs, ; & | and
// newlines), not a shell. Enough for how agents write commands; the husky
// pre-commit run is the backstop for anything it misreads.

function skipHeredocBody(src, i, delim, strip) {
  // i points just past a newline; skip lines until one equals the delimiter.
  while (i < src.length) {
    const nl = src.indexOf('\n', i);
    const line = src.slice(i, nl < 0 ? src.length : nl);
    i = nl < 0 ? src.length : nl + 1;
    if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
  }
  return i;
}

function readHeredocDelim(src, i) {
  // i points at the first '<' of '<<'. Returns [delim, strip, next index].
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

// i points just past an opening backtick. Returns the index past the closing one.
function skipBacktick(src, i) {
  while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}

// Returns the index just past the ')' that closes a '$(' opened before i.
function skipSubstitution(src, i) {
  let depth = 1;
  const pending = [];
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      i = j < 0 ? src.length : j + 1;
    } else if (c === '"') {
      i = skipDoubleQuoted(src, i + 1)[1];
    } else if (c === '`') {
      i = skipBacktick(src, i + 1);
    } else if (c === '\\') {
      i += 2;
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

// i points just past the opening '"'. Returns [text, index past the closing '"'].
function skipDoubleQuoted(src, i) {
  let text = '';
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\' && i + 1 < src.length) {
      text += src[i + 1];
      i += 2;
    } else if (src[i] === '$' && src[i + 1] === '(') {
      const end = skipSubstitution(src, i + 2);
      text += src.slice(i, end);
      i = end;
    } else if (src[i] === '`') {
      const end = skipBacktick(src, i + 1);
      text += src.slice(i, end);
      i = end;
    } else {
      text += src[i++];
    }
  }
  return [text, i + 1];
}

/** Splits a command string into simple commands, each a list of words. */
export function simpleCommands(src) {
  const out = [];
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
      const [text, next] = skipDoubleQuoted(src, i + 1);
      cur = (cur ?? '') + text;
      i = next - 1;
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') cur = (cur ?? '') + src[i + 1];
      i++;
    } else if (c === '$' && src[i + 1] === '(') {
      const e = skipSubstitution(src, i + 2);
      cur = (cur ?? '') + src.slice(i, e);
      i = e - 1;
    } else if (c === '`') {
      const e = skipBacktick(src, i + 1);
      cur = (cur ?? '') + src.slice(i, e);
      i = e - 1;
    } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      push();
      const [delim, strip, next] = readHeredocDelim(src, i);
      if (delim) pending.push([delim, strip]);
      i = next - 1;
    } else if (c === '\n') {
      end();
      let j = i + 1;
      while (pending.length) j = skipHeredocBody(src, j, ...pending.shift());
      i = j - 1;
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
  return out;
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/**
 * The git invocations in a command string:
 * { env: {NAME: value}, config: ['k=v', ...], dir: '-C value or undefined', sub: 'commit', args: [...] }.
 */
export function gitInvocations(src) {
  const found = [];
  for (const words of simpleCommands(src)) {
    let i = 0;
    const env = {};
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      const eq = words[i].indexOf('=');
      env[words[i].slice(0, eq)] = words[i].slice(eq + 1);
      i++;
    }
    if (words[i] === 'env' || words[i] === 'command') i++;
    if (!/(^|\/)git$/.test(words[i] ?? '')) continue;
    i++;
    const config = [];
    let dir;
    while (i < words.length && words[i].startsWith('-')) {
      const w = words[i];
      if (GIT_GLOBAL_WITH_VALUE.has(w)) {
        if (w === '-c') config.push(words[i + 1] ?? '');
        if (w === '-C') dir = dir && !words[i + 1]?.startsWith('/') ? `${dir}/${words[i + 1]}` : words[i + 1];
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
 * shortWithValue: short letters that take a value (rest of cluster or next word).
 * shortWithOptional: short letters whose optional value can only be attached (-uno, -Skey).
 * longWithValue: long options that take the next word as value when written without '='.
 * Returns { shorts: Set of short letters, longs: Set, positionals: [] }.
 */
export function parseOptions(args, shortWithValue, longWithValue, shortWithOptional = []) {
  const shorts = new Set();
  const longs = new Set();
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
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
