/**
 * Cheap, dependency-free context compression (#14).
 *   strip:   drop comments, blank lines and trailing whitespace (string-aware), minify JSON;
 *            for Markdown, drop what renders but carries no meaning (badges, images, rules,
 *            table padding) and keep headings, prose, lists, tables and code verbatim
 *   outline: declarations only, with line numbers, so Claude can read just the ranges it needs
 */
import { extname, basename } from 'node:path';

import { stripBlockComments } from './memory.ts';

type Lang = 'c' | 'css' | 'hash' | 'markdown' | 'json' | 'plain';

const C_LIKE = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.java',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.kts',
  '.scala',
  '.php',
  '.dart',
  '.zig',
]);
const CSS = new Set(['.css', '.less']);
const HASH = new Set([
  '.py',
  '.pyi',
  '.sh',
  '.bash',
  '.zsh',
  '.rb',
  '.yaml',
  '.yml',
  '.toml',
  '.r',
  '.pl',
  '.ex',
  '.exs',
  '.tf',
]);
const HASH_NAMES = new Set([
  'Dockerfile',
  'Makefile',
  'Gemfile',
  'Rakefile',
  '.gitignore',
  '.claudeignore',
]);

export function langOf(path: string): Lang {
  const ext = extname(path).toLowerCase();
  if (C_LIKE.has(ext) || ext === '.scss') return 'c';
  if (CSS.has(ext)) return 'css';
  if (HASH.has(ext) || HASH_NAMES.has(basename(path))) return 'hash';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.json') return 'json';
  return 'plain';
}

/** Remove comments with a small scanner that skips string literals. */
function stripComments(src: string, lang: 'c' | 'css' | 'hash'): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const lineComment = lang === 'c' ? '//' : lang === 'hash' ? '#' : null;
  const blockComments = lang !== 'hash';
  while (i < n) {
    const ch = src[i]!;
    // strings: ' " ` (backtick only for C-like)
    if (ch === '"' || ch === "'" || (ch === '`' && lang === 'c')) {
      const quote = ch;
      // python triple quotes
      const triple = lang === 'hash' && src.startsWith(quote.repeat(3), i);
      const end = triple ? quote.repeat(3) : quote;
      let j = i + end.length;
      while (j < n && !src.startsWith(end, j)) {
        if (src[j] === '\\') j++;
        else if (!triple && quote !== '`' && src[j] === '\n') break; // unterminated: stop at EOL
        j++;
      }
      j = Math.min(n, j + end.length);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (blockComments && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const comment = src.slice(i, end === -1 ? n : end + 2);
      out += '\n'.repeat(comment.split('\n').length - 1);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (lineComment && src.startsWith(lineComment, i)) {
      const prev = src[i - 1];
      const atBoundary = lang === 'c' ? prev !== ':' : prev === undefined || /\s/.test(prev);
      const shebang = lang === 'hash' && i === 0 && src[1] === '!';
      if (atBoundary && !shebang) {
        const end = src.indexOf('\n', i);
        i = end === -1 ? n : end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function squeeze(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n');
}

const FENCE = /^\s*(```|~~~)/;
/** A table separator row: | --- | :---: | ---: | */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** `| a   |  b |` → `|a|b|`; separators keep their alignment colons. Escaped pipes survive. */
function squeezeTableRow(line: string): string {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
  if (TABLE_SEPARATOR.test(line))
    return `|${cells.map((c) => `${c.startsWith(':') ? ':' : ''}-${c.endsWith(':') ? ':' : ''}`).join('|')}|`;
  return `|${cells.join('|')}|`;
}

function compressProseLine(line: string): string | null {
  // Badge rows and decorative images: [![alt](img)](link) / ![alt](img)
  const noBadges = line.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').trimEnd();
  if (!noBadges.trim() && line.trim()) return null;
  const noImages = noBadges.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) =>
    alt.trim() ? `[image: ${alt.trim()}]` : '',
  );
  if (!noImages.trim() && line.trim()) return null;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(noImages)) return null; // horizontal rule
  if (/^\s*\|.*\|\s*$/.test(noImages)) return squeezeTableRow(noImages);
  return noImages.replace(/[ \t]+$/, '');
}

export function compressMarkdown(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of stripBlockComments(text).split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker === fence) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line.trimEnd());
      continue;
    }
    const kept = compressProseLine(line);
    if (kept !== null) out.push(kept);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function compressText(path: string, text: string): string {
  const lang = langOf(path);
  switch (lang) {
    case 'json':
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {
        return squeeze(text);
      }
    case 'markdown':
      return compressMarkdown(text);
    case 'plain':
      return squeeze(text);
    default:
      return squeeze(stripComments(text, lang));
  }
}

const OUTLINE: { exts: string[]; re: RegExp }[] = [
  {
    exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|namespace)\s+[\w$]+|^(?:export\s+)?(?:const|let|var)\s+[\w${}\s,]+=|^\s{2,4}(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*(?!(?:if|for|while|switch|catch|return|await|new|throw)\b)[\w$#]+\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::[^{=]+)?\{\s*$/,
  },
  { exts: ['.py', '.pyi'], re: /^\s*(?:async\s+)?(?:def|class)\s+\w+/ },
  { exts: ['.go'], re: /^(?:func|type)\s|^(?:var|const)\s+\w/ },
  {
    exts: ['.rs'],
    re: /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|mod|type|const|static|macro_rules!)\b/,
  },
  { exts: ['.rb'], re: /^\s*(?:def|class|module)\s/ },
  {
    exts: ['.java', '.kt', '.kts', '.cs', '.scala', '.swift', '.php', '.dart'],
    re: /^\s{0,4}(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|override|suspend|async)\s+)*(?:fun|func|def|class|interface|object|enum|record|struct|trait|function)\b|^\s{0,4}(?:(?:public|private|protected|internal|static|final|abstract|override|async)\s+)+[\w<>[\],\s]+\s+\w+\s*\(/,
  },
  { exts: ['.md', '.mdx'], re: /^#{1,6}\s/ },
];

const MAX_OUTLINE_LINE = 140;

export interface Declaration {
  /** 1-based line number. */
  line: number;
  /** The declaration line, trimmed of a trailing `{`. */
  text: string;
}

/** Declaration (or Markdown heading) lines; null when the language has no outline support. */
export function declarations(path: string, text: string): Declaration[] | null {
  const ext = extname(path).toLowerCase();
  const rule = OUTLINE.find((o) => o.exts.includes(ext));
  if (!rule) return null;
  let inFence = false;
  const out: Declaration[] = [];
  text.split('\n').forEach((line, i) => {
    if (ext.startsWith('.md') && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || !rule.re.test(line)) return;
    out.push({ line: i + 1, text: line.replace(/\s*\{\s*$/, '').replace(/\s+$/, '') });
  });
  return out;
}

/** Declarations with 1-based line numbers; null when the language has no outline support. */
export function outlineText(path: string, text: string): string | null {
  const decls = declarations(path, text);
  if (!decls) return null;
  const width = String(text.split('\n').length).length;
  return decls
    .map(
      (d) =>
        `${String(d.line).padStart(width)}: ${d.text.length > MAX_OUTLINE_LINE ? d.text.slice(0, MAX_OUTLINE_LINE) + '…' : d.text}`,
    )
    .join('\n');
}
