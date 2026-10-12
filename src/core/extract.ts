/**
 * `compress --extract` (#14, strategy 2): keep only the facts of a prose document (API
 * endpoints, constraints, tables, code examples, numbers), grouped by kind and tagged with the
 * section they came from. Runs locally and deterministically; nothing is summarised by a model.
 */
import { stripBlockComments } from './memory.ts';

export interface ExtractedItem {
  text: string;
  /** Nearest heading above the item, if any. */
  section?: string;
  line: number;
}

export interface Extracted {
  api: ExtractedItem[];
  constraints: ExtractedItem[];
  tables: ExtractedItem[];
  code: ExtractedItem[];
  numbers: ExtractedItem[];
}

const HTTP = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[\w\-./:{}?=&*]*/g;
const CONSTRAINT =
  /\b(?:must|never|always|required|requires|mandatory|forbidden|only (?:if|when|after|before)|cannot|can't|do not|don't|should not|shouldn't|at most|at least|maximum|minimum|no more than|limit(?:s|ed)?)\b|\b(?:MUST|SHALL|SHOULD)\b/i;
const NUMBER =
  /(?:\$\s?\d|\b\d[\d,.]*\s?(?:%|ms|s|sec|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|[KMGT]i?B|bytes?|[KM]\b|req(?:uests)?|rps|qps|tokens?|chars?|characters?|lines?|items?|rows?|retries|attempts|times|x\b|×|USD|EUR))/i;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** Headings that are themselves an API reference: `createUser(input)`, `POST /users`. */
const API_HEADING = /^`?[\w.$]+\([^)]*\)`?|^`?(?:GET|POST|PUT|PATCH|DELETE)\s+\//;

const clean = (s: string) =>
  s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Sentences of a prose line; list items stay whole. */
function sentences(line: string): string[] {
  const item = clean(line);
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) return [item];
  // Split after a word, not after list numbering like "1." or "**2."
  return item.split(/(?<=[a-z)\]`'"][.!?])\s+(?=[A-Z`"(*])/).filter(Boolean);
}

export function extractKeyInfo(text: string): Extracted {
  const out: Extracted = { api: [], constraints: [], tables: [], code: [], numbers: [] };
  const seen = new Set<string>();
  const add = (kind: keyof Extracted, item: ExtractedItem) => {
    const key = `${kind}\0${item.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out[kind].push(item);
  };

  const headings: string[] = [];
  const section = () => headings.filter(Boolean).at(-1);
  const lines = stripBlockComments(text).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      const start = i;
      while (++i < lines.length && FENCE.exec(lines[i]!)?.[1] !== fence);
      const block = lines
        .slice(start, i + 1)
        .join('\n')
        .trimEnd();
      for (const m of block.matchAll(HTTP))
        add('api', { text: `\`${m[0]}\``, section: section(), line: lineNo });
      if (block.split('\n').length > 2)
        add('code', { text: block, section: section(), line: lineNo });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const depth = h[1]!.length;
      headings.length = depth;
      headings[depth - 1] = h[2]!.replace(/`/g, '');
      if (API_HEADING.test(h[2]!)) add('api', { text: h[2]!, section: section(), line: lineNo });
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const start = i;
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]!)) i++;
      const rows = lines.slice(start, i + 1);
      if (rows.length >= 2)
        add('tables', {
          text: rows.map((r) => r.trim().replace(/\s*\|\s*/g, '|')).join('\n'),
          section: section(),
          line: lineNo,
        });
      continue;
    }

    if (!line.trim()) continue;
    for (const sentence of sentences(line)) {
      const api = [...sentence.matchAll(HTTP)];
      if (api.length) {
        add('api', { text: sentence, section: section(), line: lineNo });
        continue;
      }
      if (CONSTRAINT.test(sentence))
        add('constraints', { text: sentence, section: section(), line: lineNo });
      else if (NUMBER.test(sentence))
        add('numbers', { text: sentence, section: section(), line: lineNo });
    }
  }
  return out;
}

const TITLES: [keyof Extracted, string][] = [
  ['api', 'API'],
  ['constraints', 'Constraints'],
  ['tables', 'Tables'],
  ['code', 'Code examples'],
  ['numbers', 'Numbers'],
];

/** Markdown grouped by kind, then by section (named once); `L12` points back into the source. */
export function formatExtracted(source: string, x: Extracted): string {
  const parts = [`# Key info: ${source}`];
  for (const [kind, title] of TITLES) {
    const items = x[kind];
    if (items.length === 0) continue;
    const lines = [`## ${title}`];
    let current: string | undefined = '\0';
    for (const it of items) {
      if (it.section !== current) {
        current = it.section;
        if (current) lines.push(`### ${current}`);
      }
      lines.push(
        kind === 'tables' || kind === 'code'
          ? `L${it.line}:\n${it.text}`
          : `- ${it.text} L${it.line}`,
      );
    }
    parts.push(lines.join('\n'));
  }
  if (parts.length === 1)
    parts.push('_No API references, constraints, tables, code or numbers found._');
  return parts.join('\n\n');
}
