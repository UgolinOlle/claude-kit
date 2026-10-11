/**
 * Cheap, dependency-free context compression (#14).
 *   strip:   drop comments, blank lines and trailing whitespace (string-aware), minify JSON
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
      return stripBlockComments(text)
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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

/** Declarations with 1-based line numbers; null when the language has no outline support. */
export function outlineText(path: string, text: string): string | null {
  const ext = extname(path).toLowerCase();
  const rule = OUTLINE.find((o) => o.exts.includes(ext));
  if (!rule) return null;
  const width = String(text.split('\n').length).length;
  let inFence = false;
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (ext.startsWith('.md') && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || !rule.re.test(line)) return;
    const clean = line.replace(/\s*\{\s*$/, '').replace(/\s+$/, '');
    out.push(
      `${String(i + 1).padStart(width)}: ${clean.length > MAX_OUTLINE_LINE ? clean.slice(0, MAX_OUTLINE_LINE) + '…' : clean}`,
    );
  });
  return out.join('\n');
}
