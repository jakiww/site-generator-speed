// site-generator-speed: a faster drop-in for makefun-site 1.0.0.
//
// Returns makefun-site 1.0.0's answer for every input, byte for byte, but
// renders it far faster: Markdown inline runs scan whole plain runs and
// slice them at once instead of escaping one character at a time; blocks
// render as they are lexed instead of through token objects; front matter
// walks lines by index instead of splitting the whole source; slugs are
// memoised per build; each page's card is built once, not twice; and every
// template is compiled to a plain function once per build instead of being
// walked node by node on every page. Nothing is cached from one case to
// the next: every cache below lives inside one run() call.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. A regex finds the next special, so plain runs are sliced at once. */
function escapeHtml(text) {
  const re = /[&<>"']/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The combining marks a slug drops. */
const MARK_RE = /\p{M}/gu;

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text` (README.md, "Text"), memoised in `cache` for this build:
 * NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-"
 * left at the cut dropped), and "untitled" when nothing is left.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const v = out === '' ? 'untitled' : out;
  cache.set(text, v);
  return v;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. Counts transitions, no array built. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      inWord = false;
      continue;
    }
    if (c > 127 && /\s/.test(text[i])) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. Finds the closing line by index instead of splitting the whole source: only the front matter's own lines
 * are ever split out.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let pos = -1;
  let from = 3;
  while (true) {
    const k = text.indexOf('\n---', from);
    if (k === -1) return { error: 'the front matter is not closed' };
    const after = k + 4;
    if (after === text.length || text[after] === '\n') {
      pos = k;
      break;
    }
    from = k + 1;
  }
  const fmLines = text.slice(4, pos).split('\n');
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = pos + 4;
  return { data, body: after === text.length ? '' : text.slice(after + 1) };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let k = 3;
  while (k < line.length) {
    const c = line[k];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-')) break;
    k++;
  }
  for (let j = k; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return null;
  return line.slice(3, k);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let k = 3; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return false;
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let c = 0;
  while (c < line.length && line[c] === '#') c++;
  if (c === 0 || c > 6) return null;
  if (c >= line.length || (line[c] !== ' ' && line[c] !== '\t')) return null;
  let end = line.length;
  while (end > c + 1 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  const text = line.slice(c + 1, end);
  return text === '' ? null : { depth: c, text };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  let core;
  if (line.startsWith('---')) core = line.slice(3);
  else if (line.startsWith('***')) core = line.slice(3);
  else return false;
  for (let k = 0; k < core.length; k++) if (core[k] !== ' ' && core[k] !== '\t') return false;
  return true;
}

/** A bullet list line's item text, or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered list line's start number and item text, or null. */
function orderedOf(line) {
  let k = 0;
  while (k < line.length && k < 9 && line[k] >= '0' && line[k] <= '9') k++;
  if (k === 0 || line[k] !== '.' || line[k + 1] !== ' ') return null;
  return { start: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k < 2 || k >= line.length) return false;
  return /\S/.test(line[k]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return lineKind(line) !== 4;
}

/**
 * What `line` starts, by its first character, so the block loop and the paragraph check share one dispatch:
 * 0 blank, 1 fence, 2 heading, 3 thematic break, 4 anything else (blockquote, list or paragraph text).
 */
function lineKind(line) {
  if (line === '') return 0;
  const c = line.charCodeAt(0);
  if (c === 35) return headingOf(line) !== null ? 2 : 4;
  if (c === 96) return fenceOpen(line) !== null ? 1 : 4;
  if (c === 45 || c === 42) return isHr(line) ? 3 : 4;
  if (c === 32 || c === 9) return isBlank(line) ? 0 : 4;
  return 4;
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. A regex finds the next special character, so plain runs
 * are sliced at once instead of one character at a time; each call owns its regex, so nested renders cannot disturb
 * one another's scan.
 */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  const re = /[\\`*\[&<>"']/g;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) {
      out += s.slice(i, j);
      i = j;
    }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      const d = s[i + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        out += d === '>' ? '&gt;' : d;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    out += ESCAPES[c];
    i++;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). Lexes and
 * renders in one pass, so no token objects are ever built.
 */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = fenceOpen(line);
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let html = `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
      for (const l of body) html += `${escapeHtml(l)}\n`;
      html += '</code></pre>';
      blocks.push(html);
      continue;
    }
    if (kind === 2) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(trimLine(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      const start = isOrdered ? ordered.start : 1;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers a compiled template calls: S is the scope chain (innermost last), D the include depth, O the output. */
const H = {
  /** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
  get(S, path) {
    let s = S.length - 1;
    while (s >= 0 && !Object.hasOwn(S[s], path[0])) s--;
    if (s < 0) return undefined;
    let v = S[s][path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  },
  truthy,
  txt: textOf,
  esc: escapeHtml,
  /**
   * The memo key for rendering a template at depth `D` in scope `S`: its name, the depth, and the values of its free
   * names. Strings carry their length, objects their per-build identity, so two keys are equal exactly when the
   * render's inputs are: a template reads nothing but its free names (and what its own fors bind from them).
   */
  key(M, S, free, D, name) {
    let k = `${D}|${name}`;
    for (const f of free) {
      const v = H.get(S, [f]);
      if (v === undefined) k += '|u';
      else if (v === null) k += '|n';
      else if (typeof v === 'string') k += `|s${v.length}:${v}`;
      else if (typeof v === 'number' || typeof v === 'boolean') k += `|${typeof v}:${v}`;
      else {
        let id = M.ids.get(v);
        if (id === undefined) {
          id = M.next++;
          M.ids.set(v, id);
        }
        k += `|o${id}`;
      }
    }
    return k;
  },
};

/** Marker for a template whose free names cannot be analysed (an include cycle): it is never memoised. */
const CYCLIC = Symbol('cyclic');

/**
 * The names `nodes` reads that no enclosing for binds, with `bound` the names the enclosing fors bind: a template
 * reads nothing else, so those names (and the include depth) are its whole input. Includes are followed in the same
 * scope; a missing template reads nothing; an include cycle returns CYCLIC.
 */
function freeOfNodes(nodes, bound, parsed, memo, inProgress) {
  const free = new Set();
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const a = freeOfNodes(n.then, bound, parsed, memo, inProgress);
      if (a === CYCLIC) return CYCLIC;
      for (const x of a) free.add(x);
      if (n.else !== null) {
        const b = freeOfNodes(n.else, bound, parsed, memo, inProgress);
        if (b === CYCLIC) return CYCLIC;
        for (const x of b) free.add(x);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      const a = freeOfNodes(n.body, b2, parsed, memo, inProgress);
      if (a === CYCLIC) return CYCLIC;
      for (const x of a) free.add(x);
    } else if (n.kind === 'include') {
      const sub = parsed.get(n.name);
      if (sub === undefined) continue;
      const key = `${n.name}|${[...bound].sort().join(',')}`;
      let subFree = memo.get(key);
      if (subFree === undefined) {
        if (inProgress.has(key)) return CYCLIC;
        inProgress.add(key);
        subFree = freeOfNodes(sub, bound, parsed, memo, inProgress);
        inProgress.delete(key);
        if (subFree !== CYCLIC) memo.set(key, subFree);
      }
      if (subFree === CYCLIC) return CYCLIC;
      for (const x of subFree) free.add(x);
    }
  }
  return free;
}

/**
 * A template's node tree compiled to a function (S, D, O, T, H, M): S the scope chain, D the include depth, O the
 * output chunks, T the compiled templates by name, H the helpers above, M the per-build render memo. A for loop
 * reuses one frame per execution (mutated per item: rendering is synchronous, so no iteration can observe another's
 * frame), which keeps the scope chain an array push/pop instead of a fresh object per item. An include of a template
 * whose free names are known (and do not include `loop`, whose fields change per iteration) is memoised on those
 * names' values: a card, a header or a footer rendered once per build is reused wherever the same inputs recur.
 */
function compileTemplate(nodes, freeByName) {
  let code = '';
  let uid = 0;
  const gen = (ns) => {
    for (const n of ns) {
      if (n.kind === 'text') code += `O.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') code += `O.push(H.esc(H.txt(H.get(S,${JSON.stringify(n.path)}))));`;
      else if (n.kind === 'raw') code += `O.push(H.txt(H.get(S,${JSON.stringify(n.path)})));`;
      else if (n.kind === 'if') {
        code += `if(H.truthy(H.get(S,${JSON.stringify(n.path)}))!==${n.not}){`;
        gen(n.then);
        code += `}`;
        if (n.else !== null) {
          code += `else{`;
          gen(n.else);
          code += `}`;
        }
      } else if (n.kind === 'for') {
        const u = uid++;
        code += `{const __x${u}=H.get(S,${JSON.stringify(n.path)});if(Array.isArray(__x${u})){const __f${u}={};const __l${u}={index:0,first:false,last:false,length:__x${u}.length};__f${u}.loop=__l${u};S.push(__f${u});for(let __k${u}=0;__k${u}<__x${u}.length;__k${u}++){__f${u}[${JSON.stringify(n.name)}]=__x${u}[__k${u}];__l${u}.index=__k${u}+1;__l${u}.first=__k${u}===0;__l${u}.last=__k${u}===__x${u}.length-1;`;
        gen(n.body);
        code += `}S.pop();}}`;
      } else if (n.kind === 'include') {
        const free = freeByName.get(n.name);
        if (free !== undefined) {
          code += `if(D<8){const __t=T.get(${JSON.stringify(n.name)});if(__t!==undefined){const __k=H.key(M,S,${JSON.stringify(free)},D,${JSON.stringify(n.name)});let __m=M.map.get(__k);if(__m===undefined){const __o=[];__t(S,D+1,__o,T,H,M);__m=__o.join('');M.map.set(__k,__m);}O.push(__m);}}`;
        } else {
          code += `if(D<8){const __t=T.get(${JSON.stringify(n.name)});if(__t!==undefined)__t(S,D+1,O,T,H,M);}`;
        }
      }
    }
  };
  gen(nodes);
  return new Function('S', 'D', 'O', 'T', 'H', 'M', code);
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const C = { slugCache: new Map(), linkCache: new Map(), base: input.site.base_url.replace(/\/+$/, '') };
  const base = C.base;

  // Templates, parsed in code-unit order of name; one that does not parse is reported and left out. Each parsed
  // template's free names are analysed once, so includes of a template that reads only values already known can be
  // memoised on those values (a card, a header, a footer rendered once per build, reused wherever it recurs).
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const freeByName = new Map();
  {
    const memo = new Map();
    const inProgress = new Set();
    for (const [name, nodes] of parsed) {
      const free = freeOfNodes(nodes, new Set(), parsed, memo, inProgress);
      if (free !== CYCLIC && !free.has('loop')) freeByName.set(name, [...free].sort());
    }
  }
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(nodes, freeByName));
  const M = { map: new Map(), ids: new WeakMap(), next: 1 };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  sources.push(...kept);

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, C.slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const linkCache = C.linkCache;
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const key = `${dir}\n${rel}`;
        let hit = linkCache.get(key);
        if (hit === undefined) {
          const path = rel === '' ? null : resolvePath(dir, rel);
          hit = {
            page: path !== null && bySource.has(path) ? bySource.get(path).url : null,
            stat: path !== null && staticPaths.has(path) ? path : null,
          };
          linkCache.set(key, hit);
        }
        if (hit.page !== null) return `${hit.page}${frag}`;
        if (hit.stat !== null) return `${base}/${hit.stat}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, C.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, C.slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, C.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, C.slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Each source's card, built once: the reference builds it again inside pageOf, with the same values.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of sources) s.card = cardOf(s);

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn([{ site, tags: allTags, recent, ...vars }], 0, out, templates, H, M);
    return out.join('');
  };
  for (const s of sources) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
