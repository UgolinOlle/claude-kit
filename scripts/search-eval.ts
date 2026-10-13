import { resolve } from 'node:path';
/**
 * Measures code search quality on a real project, per mode:
 *   recall@5  share of queries with at least one expected file in the top 5
 *   MRR       mean of 1 / rank of the first expected file (0 when it isn't in the top 20)
 *   latency   mean time per query, index already up to date
 * Queries with `"expected": []` have no answer in the project: they are left out of recall
 * and MRR, and reported separately (did search say "no relevant match"?).
 *
 * Usage: bun scripts/search-eval.ts --cwd <project> --queries <file.json> [--json]
 */
import { parseArgs } from 'node:util';

import { updateIndex } from '../src/search/index.ts';
import { search } from '../src/search/query.ts';

interface Query {
  query: string;
  expected: string[];
}

type Mode = 'keyword';
const MODES: Mode[] = ['keyword'];
const K = 5;
const DEPTH = 20;

interface QueryResult {
  query: string;
  expected: string[];
  rank: number | null;
  top: string[];
  ms: number;
}

interface ModeReport {
  mode: Mode;
  skipped?: string;
  recallAt5?: number;
  mrr?: number;
  meanMs?: number;
  /** Negative queries answered with "no relevant match". */
  rejected?: number;
  negatives?: number;
  misses?: QueryResult[];
  queries?: QueryResult[];
}

const { values } = parseArgs({
  options: {
    cwd: { type: 'string' },
    queries: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
if (!values.cwd || !values.queries) {
  console.error('Usage: bun scripts/search-eval.ts --cwd <project> --queries <file.json> [--json]');
  process.exit(2);
}
const root = resolve(values.cwd);
const queries = (await Bun.file(resolve(values.queries)).json()) as Query[];
const loaded = await updateIndex(root);

async function runMode(mode: Mode): Promise<ModeReport> {
  const results: QueryResult[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const found = await search(loaded, q.query, { k: DEPTH });
    const ms = performance.now() - t0;
    const top = found.map((r) => r.path);
    const i = top.findIndex((p) => q.expected.includes(p));
    results.push({ query: q.query, expected: q.expected, rank: i < 0 ? null : i + 1, top, ms });
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
    misses: positives.filter((r) => r.rank === null || r.rank > K),
    queries: results,
  };
}

const reports: ModeReport[] = [];
for (const mode of MODES) reports.push(await runMode(mode));

if (values.json) {
  console.log(JSON.stringify({ root, chunks: loaded.stats.chunks, reports }, null, 2));
} else {
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  console.log(
    `${root}: ${loaded.stats.files} files, ${loaded.stats.chunks} chunks, ${queries.length} queries\n`,
  );
  console.log('mode      recall@5   MRR    ms/query  no-answer rejected');
  for (const r of reports) {
    if (r.skipped) {
      console.log(`${r.mode.padEnd(9)} skipped: ${r.skipped}`);
      continue;
    }
    console.log(
      `${r.mode.padEnd(9)} ${pct(r.recallAt5!).padStart(8)}   ${r.mrr!.toFixed(2)}   ${r.meanMs!.toFixed(0).padStart(7)}   ${r.rejected}/${r.negatives}`,
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
