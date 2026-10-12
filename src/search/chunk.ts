/**
 * Turns source text into searchable chunks (#7). Code is cut at declarations, reusing the
 * `compress --outline` patterns, so a hit points at a function or class rather than a whole
 * file; files without declarations fall back to fixed windows.
 */
import { declarations } from '../core/compress.ts';

export interface Chunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** Names declared in the chunk (functions, classes, headings…). */
  symbols: string[];
  /** Term → weighted frequency. */
  tf: Record<string, number>;
  /** Sum of tf: the document length BM25 normalises by. */
  len: number;
}

const STOP = new Set(
  `a an and are as at be by for from has in is it of on or that the this to was were will with
  const let var function return import export default def class self this true false null none
  undefined new if else elif for while do switch case break continue try catch finally throw
  async await yield public private protected static void int str string number boolean bool
  any type interface fn func pub mut use mod impl struct enum package go`.split(/\s+/),
);

function stem(t: string): string {
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

/**
 * Search terms: identifiers are split on camelCase, snake_case and digits, lowercased and
 * lightly stemmed; compound identifiers are also kept whole, so `getUserById` matches both
 * "user" and the exact name.
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const word = m[0];
    const parts = word
      .split(/[_$]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)/)
      .filter(Boolean);
    const whole = word.toLowerCase().replace(/^[_$]+|[_$]+$/g, '');
    if (parts.length > 1 && whole.length >= 3 && !STOP.has(whole)) out.push(whole);
    for (const p of parts) {
      const t = stem(p.toLowerCase());
      if (t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t)) out.push(t);
    }
  }
  return out;
}

const SYMBOL =
  /\b(?:function\*?|class|interface|type|enum|namespace|def|fn|func|struct|trait|impl|mod|module|object|record|const|let|var)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/;
const METHOD = /^\s*(?:[\w$#]+\s+)*?([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\(/;

/** The declared name in a declaration line, or a heading's text. */
export function symbolOf(line: string): string | undefined {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return heading[1]!.replace(/[`*_]/g, '').trim() || undefined;
  return SYMBOL.exec(line)?.[1] ?? METHOD.exec(line)?.[1];
}

const MAX_LINES = 80;
const WINDOW = 50;
const SYMBOL_WEIGHT = 3;
const PATH_WEIGHT = 2;

function makeChunk(
  lines: string[],
  start: number,
  end: number,
  symbols: string[],
  pathTerms: string[],
): Chunk {
  const tf: Record<string, number> = {};
  const add = (t: string, w: number) => (tf[t] = (tf[t] ?? 0) + w);
  for (const t of terms(lines.slice(start - 1, end).join('\n'))) add(t, 1);
  for (const s of symbols) for (const t of terms(s)) add(t, SYMBOL_WEIGHT);
  for (const t of pathTerms) add(t, PATH_WEIGHT);
  return {
    start,
    end,
    symbols,
    tf,
    len: Object.values(tf).reduce((a, b) => a + b, 0),
  };
}

export function chunkFile(path: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const total = lines.length;
  const pathTerms = [...new Set(terms(path.replace(/\.[^./]+$/, '')))];
  const starts = (declarations(path, text) ?? []).map((d) => ({
    line: d.line,
    symbol: symbolOf(d.text),
  }));

  // Ranges: [preamble], one per declaration, then long ranges split into windows.
  const ranges: { start: number; end: number; symbol?: string }[] = [];
  if (starts.length === 0) ranges.push({ start: 1, end: total });
  else {
    if (starts[0]!.line > 1) ranges.push({ start: 1, end: starts[0]!.line - 1 });
    starts.forEach((s, i) =>
      ranges.push({
        start: s.line,
        end: (starts[i + 1]?.line ?? total + 1) - 1,
        symbol: s.symbol,
      }),
    );
  }
  const chunks: Chunk[] = [];
  for (const r of ranges) {
    if (r.end < r.start) continue;
    if (!lines.slice(r.start - 1, r.end).some((l) => l.trim())) continue;
    const size = r.end - r.start + 1;
    const step = size > MAX_LINES ? WINDOW : size;
    for (let s = r.start; s <= r.end; s += step) {
      const e = Math.min(r.end, s + step - 1);
      chunks.push(makeChunk(lines, s, e, r.symbol && s === r.start ? [r.symbol] : [], pathTerms));
    }
  }
  return chunks;
}
