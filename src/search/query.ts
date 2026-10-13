/**
 * Queries over the code-search index (#7 `search`, #12 `trim_by_priority`). Ranking is BM25
 * over declaration-sized chunks, with symbol names and path words weighted up at index time;
 * file scores combine their best chunks and reward covering more of the query.
 *
 * With embeddings (optional), chunks are also ranked by cosine similarity to the query and the
 * two rankings are merged with Reciprocal Rank Fusion: score = Σ wᵢ / (60 + rankᵢ). RRF only
 * looks at ranks, so BM25 scores and cosines never need calibrating against each other, and a
 * chunk that both find beats one that only one finds.
 */
import { join, posix } from 'node:path';

import { readText } from '../utils/fsSafe.ts';
import { globMatcher } from '../utils/runtime.ts';
import { estimateTokens } from '../utils/tokenCount.ts';

import { terms } from './chunk.ts';
import type { Embedder } from './embed.ts';
import { vectorSearch, type VectorStore } from './semantic.ts';

import type { LoadedIndex } from './index.ts';

const K1 = 1.2;
const B = 0.75;

export interface ChunkHit {
  lines: string;
  start: number;
  end: number;
  symbols: string[];
  score: number;
}

export interface SearchResult {
  path: string;
  score: number;
  chunks: ChunkHit[];
  /** Import-graph neighbours: what it imports and what imports it. */
  related: string[];
  /** Best chunk's code, numbered, when requested and within the token budget. */
  code?: string;
}

export interface SearchOptions {
  k?: number;
  /** Only files under this directory or matching this glob. */
  path?: string;
  /** Include the best chunk of each result, as long as the total fits `maxTokens`. */
  includeCode?: boolean;
  maxTokens?: number;
  /** keyword: BM25 only; semantic: vectors only; hybrid: both, fused. Default: hybrid when
   * `semantic` is given, else keyword. */
  mode?: SearchMode;
  semantic?: SemanticContext;
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';
export const SEARCH_MODES: SearchMode[] = ['keyword', 'semantic', 'hybrid'];

export interface SemanticContext {
  embedder: Embedder;
  store: VectorStore;
  /** RRF weight of each ranking (default 1 and 1). */
  weights?: { keyword: number; semantic: number };
}

export interface SearchOutcome {
  results: SearchResult[];
  mode: SearchMode;
  /** Highest query–chunk cosine similarity, when vectors were used. */
  bestSimilarity?: number;
  /** Vectors say nothing in the project is about the query (results are then empty). */
  noRelevantMatch?: boolean;
}

/** RRF's constant from the original paper: damps the gap between the very first ranks. */
const RRF_K = 60;
/** Chunks of each ranking that take part in the fusion. */
const FUSION_DEPTH = 200;

/**
 * #12 `trim_by_priority`: keep the highest-priority items while the running total fits;
 * stop at the first one that doesn't, so a lower-ranked item never displaces a better one.
 */
export function trimByPriority<T extends { priority: number; tokens: number }>(
  items: T[],
  maxTokens: number,
): T[] {
  const kept: T[] = [];
  let total = 0;
  for (const item of [...items].sort((a, b) => b.priority - a.priority)) {
    if (total + item.tokens > maxTokens) break;
    kept.push(item);
    total += item.tokens;
  }
  return kept;
}

function pathFilter(path?: string): (rel: string) => boolean {
  if (!path) return () => true;
  if (/[*?[{]/.test(path)) return globMatcher(path);
  const dir = path.replace(/^\.\//, '').replace(/\/+$/, '');
  return (rel) => rel === dir || rel.startsWith(dir + '/');
}

interface KeywordHit {
  path: string;
  chunk: number;
  score: number;
}

/** BM25 score of every chunk matching a query term, and the query terms each file covers. */
function keywordHits(loaded: LoadedIndex, q: string[], keep: (path: string) => boolean) {
  const hits: KeywordHit[] = [];
  const covered = new Map<string, number>();
  if (q.length === 0) return { hits, covered };
  const files = Object.entries(loaded.index.files);
  const allChunks = files.flatMap(([, f]) => f.chunks);
  const n = allChunks.length || 1;
  const avgLen = allChunks.reduce((s, c) => s + c.len, 0) / n || 1;
  const idf = new Map<string, number>();
  for (const t of q) {
    const df = allChunks.reduce((s, c) => s + (c.tf[t] ? 1 : 0), 0);
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  for (const [path, file] of files) {
    if (!keep(path)) continue;
    const terms = new Set<string>();
    file.chunks.forEach((c, chunk) => {
      let score = 0;
      for (const t of q) {
        const tf = c.tf[t];
        if (!tf) continue;
        terms.add(t);
        score += idf.get(t)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.len) / avgLen)));
      }
      if (score > 0) hits.push({ path, chunk, score });
    });
    if (terms.size) covered.set(path, terms.size);
  }
  return { hits, covered };
}

/** Per file: its best three chunks, combined; `bonus` multiplies the file's score. */
function rankFiles(
  loaded: LoadedIndex,
  hits: KeywordHit[],
  bonus: (path: string) => number,
): SearchResult[] {
  const byFile = new Map<string, KeywordHit[]>();
  for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
  const scored: SearchResult[] = [];
  for (const [path, fileHits] of byFile) {
    const chunks = loaded.index.files[path]!.chunks;
    const top = fileHits.sort((a, b) => b.score - a.score).slice(0, 3);
    const base = top[0]!.score + 0.25 * top.slice(1).reduce((s, h) => s + h.score, 0);
    scored.push({
      path,
      score: base * bonus(path),
      chunks: top.map((h) => {
        const c = chunks[h.chunk]!;
        return {
          lines: `${c.start}-${c.end}`,
          start: c.start,
          end: c.end,
          symbols: c.symbols,
          score: h.score,
        };
      }),
      related: [],
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

export async function search(
  loaded: LoadedIndex,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  return (await searchDetailed(loaded, query, opts)).results;
}

export async function searchDetailed(
  loaded: LoadedIndex,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchOutcome> {
  const mode = opts.mode ?? (opts.semantic ? 'hybrid' : 'keyword');
  const sem = opts.semantic;
  if (mode !== 'keyword' && !sem) throw new Error(`Search mode "${mode}" needs embeddings.`);
  const q = [...new Set(terms(query))];
  const keep = pathFilter(opts.path);
  const kw = mode === 'semantic' ? { hits: [], covered: new Map() } : keywordHits(loaded, q, keep);

  let scored: SearchResult[];
  let bestSimilarity: number | undefined;
  let noRelevantMatch = false;
  if (mode === 'keyword') {
    if (q.length === 0) return { results: [], mode };
    scored = rankFiles(loaded, kw.hits, (p) => 1 + 0.5 * ((kw.covered.get(p) ?? 0) / q.length));
  } else {
    const [qv] = await sem!.embedder.embed([query], 'query');
    const vec = vectorSearch(loaded, sem!.store, qv!, keep).slice(0, FUSION_DEPTH);
    bestSimilarity = vec[0]?.similarity;
    const w = sem!.weights ?? { keyword: 1, semantic: 1 };
    const fused = new Map<string, KeywordHit>();
    const add = (path: string, chunk: number, rank: number, weight: number) => {
      if (weight === 0) return; // that ranking is switched off
      const key = `${path}#${chunk}`;
      const h = fused.get(key) ?? fused.set(key, { path, chunk, score: 0 }).get(key)!;
      h.score += weight / (RRF_K + rank);
    };
    if (mode === 'hybrid')
      kw.hits
        .sort((a, b) => b.score - a.score)
        .slice(0, FUSION_DEPTH)
        .forEach((h, i) => add(h.path, h.chunk, i + 1, w.keyword));
    vec.forEach((h, i) => add(h.path, h.chunk, i + 1, w.semantic));
    // Nothing close in meaning (per-model threshold), and no file has every query word:
    // say so rather than return the least-bad files.
    const min = sem!.embedder.minSimilarity;
    const exact = q.length > 0 && [...kw.covered.values()].some((n) => n === q.length);
    noRelevantMatch = min !== undefined && (bestSimilarity ?? 0) < min && !exact;
    scored = noRelevantMatch ? [] : rankFiles(loaded, [...fused.values()], () => 1);
  }

  const results = scored.slice(0, Math.max(1, opts.k ?? 5));
  const max = results[0]?.score || 1;
  // Fused RRF scores are small (~0.03): keep more digits than BM25's.
  const digits = mode === 'keyword' ? 100 : 10_000;
  for (const r of results) {
    r.score = Math.round((100 * r.score) / max) / 100;
    for (const h of r.chunks) h.score = Math.round(h.score * digits) / digits;
    r.related = [...(loaded.imports.get(r.path) ?? []), ...(loaded.importedBy.get(r.path) ?? [])]
      .filter((p, i, all) => all.indexOf(p) === i && !results.some((o) => o.path === p))
      .slice(0, 3);
  }

  if (opts.includeCode) {
    const snippets = await Promise.all(
      results.map(async (r) => {
        const text = (await readText(join(loaded.root, r.path))) ?? '';
        const best = r.chunks[0]!;
        const code = text
          .split('\n')
          .slice(best.start - 1, best.end)
          .map((l, i) => `${best.start + i}\t${l}`)
          .join('\n');
        return {
          result: r,
          code,
          priority: r.score,
          tokens: estimateTokens(code),
        };
      }),
    );
    for (const s of trimByPriority(snippets, opts.maxTokens ?? 4000)) s.result.code = s.code;
  }
  return { results, mode, bestSimilarity, noRelevantMatch };
}

export interface Related {
  path: string;
  indexed: boolean;
  imports: string[];
  importedBy: string[];
  tests: string[];
}

const TEST_NAME = /(?:\.(?:test|spec)\.[^.]+$|_test\.\w+$|^test_)/;

/** What a file depends on, what depends on it, and the tests that look like they cover it. */
export function related(loaded: LoadedIndex, path: string): Related {
  const rel = path.replace(/^\.\//, '');
  const name = posix.basename(rel).replace(/\.[^.]+$/, '');
  const tests = Object.keys(loaded.index.files).filter((f) => {
    const base = posix.basename(f);
    return (
      f !== rel &&
      TEST_NAME.test(base) &&
      base.replace(TEST_NAME, '').replace(/\.[^.]+$/, '') === name
    );
  });
  return {
    path: rel,
    indexed: rel in loaded.index.files,
    imports: loaded.imports.get(rel) ?? [],
    importedBy: loaded.importedBy.get(rel) ?? [],
    tests,
  };
}
