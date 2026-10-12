/**
 * Queries over the code-search index (#7 `search`, #12 `trim_by_priority`). Ranking is BM25
 * over declaration-sized chunks, with symbol names and path words weighted up at index time;
 * file scores combine their best chunks and reward covering more of the query.
 */
import { join, posix } from "node:path";

import { readText } from "../utils/fsSafe.ts";
import { globMatcher } from "../utils/runtime.ts";
import { estimateTokens } from "../utils/tokenCount.ts";

import { terms } from "./chunk.ts";

import type { LoadedIndex } from "./index.ts";

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
}

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
  const dir = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return (rel) => rel === dir || rel.startsWith(dir + "/");
}

export async function search(
  loaded: LoadedIndex,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const q = [...new Set(terms(query))];
  if (q.length === 0) return [];
  const files = Object.entries(loaded.index.files);
  const allChunks = files.flatMap(([, f]) => f.chunks);
  const n = allChunks.length || 1;
  const avgLen = allChunks.reduce((s, c) => s + c.len, 0) / n || 1;
  const idf = new Map<string, number>();
  for (const t of q) {
    const df = allChunks.reduce((s, c) => s + (c.tf[t] ? 1 : 0), 0);
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const keep = pathFilter(opts.path);
  const scored: SearchResult[] = [];
  for (const [path, file] of files) {
    if (!keep(path)) continue;
    const covered = new Set<string>();
    const hits: ChunkHit[] = [];
    for (const c of file.chunks) {
      let score = 0;
      for (const t of q) {
        const tf = c.tf[t];
        if (!tf) continue;
        covered.add(t);
        score +=
          idf.get(t)! *
          ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.len) / avgLen)));
      }
      if (score > 0)
        hits.push({
          lines: `${c.start}-${c.end}`,
          start: c.start,
          end: c.end,
          symbols: c.symbols,
          score,
        });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 3);
    const base =
      top[0]!.score + 0.25 * top.slice(1).reduce((s, h) => s + h.score, 0);
    const score = base * (1 + 0.5 * (covered.size / q.length));
    scored.push({ path, score, chunks: top, related: [] });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const results = scored.slice(0, Math.max(1, opts.k ?? 5));
  const max = results[0]?.score || 1;
  for (const r of results) {
    r.score = Math.round((100 * r.score) / max) / 100;
    for (const h of r.chunks) h.score = Math.round(h.score * 100) / 100;
    r.related = [
      ...(loaded.imports.get(r.path) ?? []),
      ...(loaded.importedBy.get(r.path) ?? []),
    ]
      .filter(
        (p, i, all) =>
          all.indexOf(p) === i && !results.some((o) => o.path === p),
      )
      .slice(0, 3);
  }

  if (opts.includeCode) {
    const snippets = await Promise.all(
      results.map(async (r) => {
        const text = (await readText(join(loaded.root, r.path))) ?? "";
        const best = r.chunks[0]!;
        const code = text
          .split("\n")
          .slice(best.start - 1, best.end)
          .map((l, i) => `${best.start + i}\t${l}`)
          .join("\n");
        return {
          result: r,
          code,
          priority: r.score,
          tokens: estimateTokens(code),
        };
      }),
    );
    for (const s of trimByPriority(snippets, opts.maxTokens ?? 4000))
      s.result.code = s.code;
  }
  return results;
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
  const rel = path.replace(/^\.\//, "");
  const name = posix.basename(rel).replace(/\.[^.]+$/, "");
  const tests = Object.keys(loaded.index.files).filter((f) => {
    const base = posix.basename(f);
    return (
      f !== rel &&
      TEST_NAME.test(base) &&
      base.replace(TEST_NAME, "").replace(/\.[^.]+$/, "") === name
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
