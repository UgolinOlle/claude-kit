/**
 * Measures code search quality on a real project, per mode (keyword, semantic, hybrid):
 *   recall@5  share of queries with at least one expected file in the top 5
 *   MRR       mean of 1 / rank of the first expected file (0 when it isn't in the top 20)
 *   latency   mean time per query, indexes already up to date
 * Queries with `"expected": []` have no answer in the project: they are left out of recall
 * and MRR, and reported separately (did search say "no relevant match"?). The best cosine
 * similarity of answered and unanswered queries is printed to calibrate MIN_SIMILARITY.
 *
 * semantic and hybrid need the embeddings runtime (`claude-kit search --setup`); without it
 * they are skipped. The first run builds the project's semantic index (progress on stderr).
 *
 * Usage: bun scripts/search-eval.ts --cwd <project> --queries <file.json>
 *          [--model <id>] [--weights 1,1] [--json]
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { DEFAULT_MODEL, loadEmbedder } from '../src/search/embed.ts';
import { updateIndex } from '../src/search/index.ts';
import {
  type SearchMode,
  SEARCH_MODES,
  type SemanticContext,
  searchDetailed,
} from '../src/search/query.ts';
import { SemanticIndex } from '../src/search/semantic.ts';

interface Query {
  query: string;
  expected: string[];
}

const K = 5;
const DEPTH = 20;

interface QueryResult {
  query: string;
  expected: string[];
  rank: number | null;
  top: string[];
  ms: number;
  bestSimilarity?: number;
}

interface ModeReport {
  mode: SearchMode;
  skipped?: string;
  recallAt5?: number;
  mrr?: number;
  meanMs?: number;
  /** Negative queries answered with "no relevant match". */
  rejected?: number;
  negatives?: number;
  /** Positive queries wrongly answered with "no relevant match". */
  falseRejects?: number;
  misses?: QueryResult[];
  queries?: QueryResult[];
}

const { values } = parseArgs({
  options: {
    cwd: { type: 'string' },
    queries: { type: 'string' },
    model: { type: 'string' },
    weights: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (!values.cwd || !values.queries) {
  console.error(
    'Usage: bun scripts/search-eval.ts --cwd <project> --queries <file.json> [--model <id>] [--weights 1,1] [--json]',
  );
  process.exit(2);
}
const root = resolve(values.cwd);
const queries = (await Bun.file(resolve(values.queries)).json()) as Query[];
const [wk = 1, ws = 1] = (values.weights ?? '1,1').split(',').map(Number);
const loaded = await updateIndex(root);

let semantic: SemanticContext | undefined;
let skipped: string | undefined;
let build: { seconds: number; chunks: number } | undefined;
try {
  const index = new SemanticIndex(root, values.model ?? DEFAULT_MODEL, (m) => loadEmbedder(m), {
    onProgress: (p) => process.stderr.write(`\rsemantic index: ${p.done}/${p.total} chunks`),
  });
  const t0 = performance.now();
  const { store, embedder } = await index.refresh(loaded);
  process.stderr.write('\n');
  build = { seconds: (performance.now() - t0) / 1000, chunks: loaded.stats.chunks };
  semantic = { store, embedder, weights: { keyword: wk, semantic: ws } };
} catch (err) {
  skipped = (err as Error).message;
}

async function runMode(mode: SearchMode): Promise<ModeReport> {
  if (mode !== 'keyword' && !semantic) return { mode, skipped };
  const results: QueryResult[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const out = await searchDetailed(loaded, q.query, {
      k: DEPTH,
      mode,
      semantic: mode === 'keyword' ? undefined : semantic,
    });
    const ms = performance.now() - t0;
    const top = out.results.map((r) => r.path);
    const i = top.findIndex((p) => q.expected.includes(p));
    results.push({
      query: q.query,
      expected: q.expected,
      rank: i < 0 ? null : i + 1,
      top,
      ms,
      bestSimilarity: out.bestSimilarity,
    });
  }
  const positives = results.filter((r) => r.expected.length > 0);
  const negatives = results.filter((r) => r.expected.length === 0);
  return {
    mode,
    recallAt5: positives.filter((r) => r.rank !== null && r.rank <= K).length / positives.length,
    mrr: positives.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / positives.length,
    meanMs: results.reduce((s, r) => s + r.ms, 0) / results.length,
    rejected: negatives.filter((r) => r.top.length === 0).length,
    negatives: negatives.length,
    falseRejects: positives.filter((r) => r.top.length === 0).length,
    misses: positives.filter((r) => r.rank === null || r.rank > K),
    queries: results,
  };
}

// Warm-up: the first inference pays for graph initialisation, not representative of a query.
if (semantic) await semantic.embedder.embed(['warm-up'], 'query');
const reports: ModeReport[] = [];
for (const mode of SEARCH_MODES) reports.push(await runMode(mode));

if (values.json) {
  console.log(JSON.stringify({ root, chunks: loaded.stats.chunks, build, reports }, null, 2));
} else {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  console.log(
    `${root}: ${loaded.stats.files} files, ${loaded.stats.chunks} chunks, ${queries.length} queries${build ? `; semantic index ready in ${build.seconds.toFixed(1)} s` : ''}\n`,
  );
  console.log('mode      recall@5   MRR    ms/query  no-answer rejected  false rejects');
  for (const r of reports) {
    if (r.skipped) {
      console.log(`${r.mode.padEnd(9)} skipped: ${r.skipped}`);
      continue;
    }
    console.log(
      `${r.mode.padEnd(9)} ${pct(r.recallAt5!).padStart(8)}   ${r.mrr!.toFixed(2)}   ${r.meanMs!.toFixed(0).padStart(7)}   ${`${r.rejected}/${r.negatives}`.padStart(8)}           ${r.falseRejects}`,
    );
  }
  const sims = reports.find((r) => r.mode === 'hybrid')?.queries;
  if (sims?.some((q) => q.bestSimilarity !== undefined)) {
    const best = (qs: QueryResult[]) => qs.map((q) => q.bestSimilarity!).sort((a, b) => a - b);
    const pos = best(sims.filter((q) => q.expected.length));
    const neg = best(sims.filter((q) => !q.expected.length));
    console.log(
      `\nbest cosine similarity: answered ${pos[0]?.toFixed(3)}–${pos.at(-1)?.toFixed(3)}, no answer ${neg[0]?.toFixed(3)}–${neg.at(-1)?.toFixed(3)}`,
    );
  }
  for (const r of reports) {
    if (!r.misses?.length) continue;
    console.log(`\n${r.mode}: missed in the top ${K}`);
    for (const m of r.misses)
      console.log(
        `  "${m.query}" → ${m.rank ? `rank ${m.rank}` : `not in top ${DEPTH}`}; expected ${m.expected.join(' | ')}; got ${m.top.slice(0, 3).join(', ') || 'nothing'}`,
      );
  }
}
