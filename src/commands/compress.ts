import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { GlobalOptions } from '../cli.ts';
import { compressText, outlineText } from '../core/compress.ts';
import { describeCountError } from '../core/exactCount.ts';
import { extractKeyInfo, formatExtracted } from '../core/extract.ts';
import { type Summarizer, summarizeDocument, summaryRequest } from '../core/summarize.ts';
import { apiSummarizer, DEFAULT_SUMMARY_MODEL } from '../core/summarizeApi.ts';
import { priceFor } from '../data/pricing.ts';
import { looksBinary } from '../utils/fsSafe.ts';
import { c, log } from '../utils/logger.ts';
import { readBytes } from '../utils/runtime.ts';
import { estimateTokens, formatTokens } from '../utils/tokenCount.ts';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'vendor',
]);

async function expand(path: string, acc: string[] = []): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    acc.push(path);
    return acc;
  }
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      await expand(join(path, entry.name), acc);
    else if (entry.isFile()) acc.push(join(path, entry.name));
  }
  return acc;
}

/** Prose formats `--extract` and `--summarize` understand; code has `--outline` instead. */
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
/** The article's rule: below this, summarising costs more attention than it saves. */
export const MIN_SUMMARY_TOKENS = 5_000;
const PROMPT_OVERHEAD = 300;

export interface CompressDeps {
  /** Overrides the API summarizer (tests). */
  summarizer?: Summarizer;
  /** Answers the consent question (tests); default asks on the terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

export async function askOnTerminal(question: string): Promise<boolean> {
  // stderr, so `compress --summarize doc.md > doc.summary.md` still shows the question.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function runSummarize(
  opts: GlobalOptions,
  files: string[],
  d: CompressDeps,
): Promise<number> {
  const ratio = opts.ratio === undefined ? 0.2 : Number(opts.ratio);
  if (!(ratio >= 0.05 && ratio <= 0.9)) {
    log.error(`--ratio must be between 0.05 and 0.9, got "${opts.ratio}".`);
    return 2;
  }
  const model = opts.model ?? DEFAULT_SUMMARY_MODEL;
  const docs: { rel: string; text: string }[] = [];
  for (const file of files) {
    const rel = relative(opts.cwd, file) || file;
    if (!PROSE.test(file)) {
      log.info(c.dim(`skip ${rel}: not a prose document (use --outline for code)`));
      continue;
    }
    const text = new TextDecoder().decode(await readBytes(file));
    if (estimateTokens(text) < MIN_SUMMARY_TOKENS && !opts.force) {
      log.info(
        c.dim(
          `skip ${rel}: ~${formatTokens(estimateTokens(text))} tokens is small enough to read whole (--force to summarise anyway)`,
        ),
      );
      continue;
    }
    docs.push({ rel, text });
  }
  if (docs.length === 0) {
    log.error('Nothing to summarise.');
    return 1;
  }

  // What leaves the machine, and roughly what it costs, before anything is sent.
  let sendTokens = 0;
  let outTokens = 0;
  for (const doc of docs) {
    const { request } = summaryRequest(doc.text, doc.rel, ratio);
    if (request.sections.length === 0) continue;
    sendTokens +=
      PROMPT_OVERHEAD + request.sections.reduce((n, s) => n + Math.ceil(s.text.length / 3.5), 0);
    outTokens += request.sections.reduce((n, s) => n + s.target, 0);
  }
  if (sendTokens > 0 && !d.summarizer) {
    const price = priceFor(model);
    const cost = price
      ? (sendTokens * price.input + outTokens * price.output * 1.5) / 1e6
      : undefined;
    const question = `Send ~${formatTokens(sendTokens)} tokens from ${docs.length} document${docs.length === 1 ? '' : 's'} to the Anthropic API (${model}${cost !== undefined ? `, ~$${cost.toFixed(2)}` : ''}) to summarise them?`;
    const confirm = d.confirm ?? (process.stdin.isTTY ? askOnTerminal : undefined);
    if (!opts.yes) {
      if (!confirm) {
        log.error(`${question}\nNot a terminal: pass --yes to confirm.`);
        return 2;
      }
      if (!(await confirm(question))) {
        log.info('Cancelled; nothing was sent.');
        return 1;
      }
    }
  }

  const summarizer = d.summarizer ?? apiSummarizer(model);
  for (const doc of docs) {
    let result;
    try {
      result = await summarizeDocument(doc.text, doc.rel, ratio, summarizer);
    } catch (err) {
      log.error(`${doc.rel}: ${describeCountError(err)}`);
      return 1;
    }
    if (docs.length > 1) console.log(`=== ${doc.rel} ===`);
    console.log(result.text);
    if (!opts.json)
      console.error(
        c.dim(
          `${doc.rel}: ~${formatTokens(result.before)} → ~${formatTokens(result.after)} tokens · ${result.kept} kept, ${result.summarized} summarised, ${result.omitted} omitted`,
        ),
      );
  }
  return 0;
}

/**
 * `claude-kit compress [--outline | --extract | --summarize] <path…>`: prints the result to
 * stdout, stats to stderr.
 */
export async function runCompress(
  opts: GlobalOptions,
  paths: string[],
  d: CompressDeps = {},
): Promise<number> {
  if (paths.length === 0) {
    log.error('Usage: claude-kit compress [--outline | --extract | --summarize] <file or dir>…');
    return 2;
  }
  if ([opts.outline, opts.extract, opts.summarize].filter(Boolean).length > 1) {
    log.error('--outline, --extract and --summarize are different views; pick one.');
    return 2;
  }
  if (opts.summarize) {
    const files: string[] = [];
    for (const p of paths) {
      try {
        files.push(...(await expand(resolve(opts.cwd, p))));
      } catch {
        log.error(`Not found: ${p}`);
        return 1;
      }
    }
    return runSummarize(opts, files, d);
  }
  let skipped = 0;
  let before = 0;
  let after = 0;
  let count = 0;
  for (const p of paths) {
    let files: string[];
    try {
      files = await expand(resolve(opts.cwd, p));
    } catch {
      log.error(`Not found: ${p}`);
      return 1;
    }
    for (const file of files) {
      const bytes = await readBytes(file);
      if (looksBinary(bytes)) continue;
      const text = new TextDecoder().decode(bytes);
      const rel = relative(opts.cwd, file) || file;
      if (opts.extract && !PROSE.test(file)) {
        skipped++;
        continue;
      }
      const out = opts.extract
        ? formatExtracted(rel, extractKeyInfo(text))
        : ((opts.outline ? outlineText(file, text) : null) ?? compressText(file, text));
      const tIn = estimateTokens(text);
      const tOut = estimateTokens(out);
      before += tIn;
      after += tOut;
      count++;
      if (files.length > 1 || paths.length > 1)
        console.log(`=== ${rel} (${formatTokens(tIn)} → ${formatTokens(tOut)} tokens) ===`);
      console.log(out);
    }
  }
  const saved = before ? Math.round(100 * (1 - after / before)) : 0;
  const change = saved >= 0 ? `−${saved}%` : `+${-saved}%`;
  if (!opts.json)
    console.error(
      c.dim(
        `${count} file${count === 1 ? '' : 's'}: ~${formatTokens(before)} → ~${formatTokens(after)} tokens (${change})` +
          (skipped
            ? `; skipped ${skipped} non-prose file${skipped === 1 ? '' : 's'} (use --outline for code)`
            : ''),
      ),
    );
  return 0;
}
