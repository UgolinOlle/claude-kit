/**
 * Reads Claude Code session transcripts (~/.claude/projects/<project>/*.jsonl) and measures what
 * sessions actually cost: tokens by kind, prompt-cache hit ratio, cache breaks and their likely
 * causes, and the files Claude reads most. Everything stays local; nothing is sent anywhere.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { CACHE_WRITE_1H, CACHE_WRITE_5M, priceFor, shortModel } from '../data/pricing.ts';
import { glob } from '../utils/runtime.ts';
import { CHARS_PER_TOKEN } from '../utils/tokenCount.ts';

import { defaultConfigDir, projectDirName } from './memory.ts';

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Why the cache had to be rebuilt between two consecutive requests. */
export type BreakCause = 'idle' | 'model-switch' | 'prefix-changed';

export interface CacheBreak {
  session: string;
  at: string;
  cause: BreakCause;
  /** Tokens re-written to the cache that a warm cache would have read. */
  tokens: number;
  /** Extra cost versus a cache read, USD. */
  cost: number;
  /** For idle breaks: minutes since the previous request. */
  idleMinutes?: number;
}

export interface FileReads {
  path: string;
  reads: number;
  /** Rough tokens the reads returned (estimated from the tool result text). */
  tokens: number;
}

export interface SessionUsage {
  id: string;
  start: string;
  end: string;
  /** API requests (assistant messages), subagents included. */
  requests: number;
  /** Requests made by subagents. */
  subagentRequests: number;
  tokens: Tokens;
  cost: number;
  /** Tokens per model, by cost. */
  models: Record<string, { cost: number; requests: number }>;
  /** Cache reads / all input-side tokens. */
  hitRatio: number;
  breaks: CacheBreak[];
  compactions: number;
  /** Largest context seen in one main-thread request. */
  peakContext: number;
  /** True when a model had no known price (cost is then a lower bound). */
  unpriced: boolean;
}

export interface UsageReport {
  root: string;
  transcriptDir: string;
  sinceDays: number;
  sessions: SessionUsage[];
  totals: { tokens: Tokens; cost: number; hitRatio: number; requests: number };
  models: Record<string, { cost: number; requests: number }>;
  breaks: { cause: BreakCause; count: number; tokens: number; cost: number }[];
  files: FileReads[];
}

interface Call {
  id: string;
  ts: number;
  model: string;
  sidechain: boolean;
  tokens: Tokens;
  /** A compaction happened right before this request. */
  afterCompact: boolean;
}

const emptyTokens = (): Tokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
});

function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

const written = (t: Tokens) => t.cacheWrite5m + t.cacheWrite1h;
const promptSize = (t: Tokens) => t.input + t.cacheRead + written(t);
export const hitRatio = (t: Tokens) => (promptSize(t) ? t.cacheRead / promptSize(t) : 0);

export function costOf(model: string, t: Tokens): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  return (
    (t.input * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite5m * p.input * CACHE_WRITE_5M +
      t.cacheWrite1h * p.input * CACHE_WRITE_1H) /
    1e6
  );
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export function tokensFromUsage(u: RawUsage): Tokens {
  const total = u.cache_creation_input_tokens ?? 0;
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite1h: oneHour,
    cacheWrite5m: Math.max(0, total - oneHour),
  };
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: { file_path?: string };
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

interface Entry {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  sessionId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
    content?: unknown;
  };
}

function textLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content))
    return content.reduce(
      (n: number, b: ContentBlock) => n + (typeof b?.text === 'string' ? b.text.length : 0),
      0,
    );
  return 0;
}

interface ParsedFile {
  sessionId: string;
  calls: Call[];
  compactions: number;
  /** file path → [reads, result chars] */
  reads: Map<string, [number, number]>;
}

async function parseTranscript(file: string, fallbackId: string): Promise<ParsedFile> {
  const calls = new Map<string, Call>();
  const readIds = new Map<string, string>();
  const reads = new Map<string, [number, number]>();
  let sessionId = fallbackId;
  let compactions = 0;
  let pendingCompact = false;

  const lines = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (e.sessionId) sessionId = e.sessionId;
    if ((e.type === 'system' && e.subtype === 'compact_boundary') || e.isCompactSummary) {
      if (!pendingCompact) compactions++;
      pendingCompact = true;
      continue;
    }
    const content = Array.isArray(e.message?.content) ? (e.message!.content as ContentBlock[]) : [];
    if (e.type === 'assistant' && e.message?.usage) {
      const key = e.message.id ?? `${e.timestamp}-${calls.size}`;
      const prev = calls.get(key);
      calls.set(key, {
        id: key,
        ts: Date.parse(e.timestamp ?? '') || prev?.ts || 0,
        model: e.message.model ?? prev?.model ?? 'unknown',
        sidechain: Boolean(e.isSidechain),
        tokens: tokensFromUsage(e.message.usage),
        afterCompact: prev?.afterCompact ?? pendingCompact,
      });
      if (!e.isSidechain) pendingCompact = false;
      for (const b of content)
        if (b.type === 'tool_use' && b.name === 'Read' && b.id && b.input?.file_path)
          readIds.set(b.id, b.input.file_path);
    } else if (e.type === 'user') {
      for (const b of content) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        const path = readIds.get(b.tool_use_id);
        if (!path) continue;
        readIds.delete(b.tool_use_id);
        const [n, chars] = reads.get(path) ?? [0, 0];
        reads.set(path, [n + 1, chars + textLength(b.content)]);
      }
    }
  }
  return { sessionId, calls: [...calls.values()], compactions, reads };
}

/** Requests whose cache read collapsed although the previous request had just written it. */
export function findBreaks(session: string, calls: Call[]): CacheBreak[] {
  const main = calls
    .filter((c) => !c.sidechain && c.model !== '<synthetic>')
    .sort((a, b) => a.ts - b.ts);
  const out: CacheBreak[] = [];
  for (let i = 1; i < main.length; i++) {
    const prev = main[i - 1]!;
    const cur = main[i]!;
    if (cur.afterCompact) continue; // compaction rebuilds the prompt by design
    const warm = prev.tokens.cacheRead + written(prev.tokens);
    const rewritten = written(cur.tokens);
    if (warm < 2048 || cur.tokens.cacheRead >= warm * 0.5 || rewritten < 1024) continue;
    const gapMin = (cur.ts - prev.ts) / 60_000;
    const ttl = prev.tokens.cacheWrite1h > 0 || cur.tokens.cacheWrite1h > 0 ? 60 : 5;
    const cause: BreakCause =
      normalizeId(cur.model) !== normalizeId(prev.model)
        ? 'model-switch'
        : gapMin >= ttl
          ? 'idle'
          : 'prefix-changed';
    const p = priceFor(cur.model);
    const writeRate = cur.tokens.cacheWrite1h > 0 ? CACHE_WRITE_1H : CACHE_WRITE_5M;
    out.push({
      session,
      at: new Date(cur.ts).toISOString(),
      cause,
      tokens: rewritten,
      cost: p ? (rewritten * (p.input * writeRate - p.cacheRead)) / 1e6 : 0,
      idleMinutes: cause === 'idle' ? Math.round(gapMin) : undefined,
    });
  }
  return out;
}

const normalizeId = (m: string) => shortModel(m);

function summarize(id: string, calls: Call[], compactions: number): SessionUsage {
  let tokens = emptyTokens();
  let cost = 0;
  let unpriced = false;
  const models: SessionUsage['models'] = {};
  let peakContext = 0;
  for (const c of calls) {
    if (c.model === '<synthetic>') continue;
    tokens = addTokens(tokens, c.tokens);
    const callCost = costOf(c.model, c.tokens);
    if (callCost === undefined) unpriced = true;
    cost += callCost ?? 0;
    const name = shortModel(c.model);
    const m = (models[name] ??= { cost: 0, requests: 0 });
    m.cost += callCost ?? 0;
    m.requests++;
    if (!c.sidechain) peakContext = Math.max(peakContext, promptSize(c.tokens) + c.tokens.output);
  }
  const ts = calls.map((c) => c.ts).filter(Boolean);
  return {
    id,
    start: ts.length ? new Date(Math.min(...ts)).toISOString() : '',
    end: ts.length ? new Date(Math.max(...ts)).toISOString() : '',
    requests: calls.length,
    subagentRequests: calls.filter((c) => c.sidechain).length,
    tokens,
    cost,
    models,
    hitRatio: hitRatio(tokens),
    breaks: findBreaks(id, calls),
    compactions,
    peakContext,
    unpriced,
  };
}

export function transcriptDir(root: string, configDir = defaultConfigDir()): string {
  return join(configDir, 'projects', projectDirName(root));
}

function displayPath(root: string, p: string, home?: string): string {
  if (isAbsolute(p) && (p === root || p.startsWith(root + sep)))
    return relative(root, p).split(sep).join('/');
  if (home && p.startsWith(home + sep)) return '~/' + relative(home, p).split(sep).join('/');
  return p;
}

export interface UsageOptions {
  configDir?: string;
  home?: string;
  /** Only sessions active in the last N days (0 = all). */
  days?: number;
  /** Session id or id prefix. */
  session?: string;
  now?: number;
}

export async function analyzeUsage(root: string, opts: UsageOptions = {}): Promise<UsageReport> {
  const dir = transcriptDir(root, opts.configDir);
  const days = opts.days ?? 30;
  const since = days > 0 ? (opts.now ?? Date.now()) - days * 86_400_000 : 0;

  // Main transcripts sit at the top level; subagent ones in <session>/subagents/.
  const files = await glob('**/*.jsonl', { cwd: dir, dot: false });
  const bySession = new Map<string, { calls: Call[]; compactions: number }>();
  const reads = new Map<string, [number, number]>();

  for (const rel of files.sort()) {
    const abs = join(dir, rel);
    try {
      if ((await stat(abs)).mtimeMs < since) continue;
    } catch {
      continue;
    }
    const fallbackId = rel.split('/')[0]!.replace(/\.jsonl$/, '');
    if (opts.session && !fallbackId.startsWith(opts.session)) continue;
    const parsed = await parseTranscript(abs, fallbackId);
    const isSubagentFile = rel.includes('/');
    const s = bySession.get(parsed.sessionId) ?? { calls: [], compactions: 0 };
    // Subagent files are sidechains even when entries don't say so.
    s.calls.push(...parsed.calls.map((c) => (isSubagentFile ? { ...c, sidechain: true } : c)));
    s.compactions += parsed.compactions;
    bySession.set(parsed.sessionId, s);
    for (const [path, [n, chars]] of parsed.reads) {
      const key = displayPath(root, path, opts.home);
      const [rn, rc] = reads.get(key) ?? [0, 0];
      reads.set(key, [rn + n, rc + chars]);
    }
  }

  const sessions = [...bySession.entries()]
    .map(([id, s]) => summarize(id, s.calls, s.compactions))
    .filter((s) => s.requests > 0 && (!since || Date.parse(s.end) >= since))
    .sort((a, b) => b.end.localeCompare(a.end));

  let tokens = emptyTokens();
  let cost = 0;
  let requests = 0;
  const models: UsageReport['models'] = {};
  const causes = new Map<BreakCause, { count: number; tokens: number; cost: number }>();
  for (const s of sessions) {
    tokens = addTokens(tokens, s.tokens);
    cost += s.cost;
    requests += s.requests;
    for (const [name, m] of Object.entries(s.models)) {
      const t = (models[name] ??= { cost: 0, requests: 0 });
      t.cost += m.cost;
      t.requests += m.requests;
    }
    for (const b of s.breaks) {
      const c = causes.get(b.cause) ?? { count: 0, tokens: 0, cost: 0 };
      c.count++;
      c.tokens += b.tokens;
      c.cost += b.cost;
      causes.set(b.cause, c);
    }
  }

  return {
    root,
    transcriptDir: dir,
    sinceDays: days,
    sessions,
    totals: { tokens, cost, hitRatio: hitRatio(tokens), requests },
    models,
    breaks: [...causes.entries()]
      .map(([cause, c]) => ({ cause, ...c }))
      .sort((a, b) => b.cost - a.cost || b.count - a.count),
    files: [...reads.entries()]
      .map(([path, [n, chars]]) => ({
        path,
        reads: n,
        tokens: Math.round(chars / CHARS_PER_TOKEN),
      }))
      .sort((a, b) => b.tokens - a.tokens || b.reads - a.reads),
  };
}
