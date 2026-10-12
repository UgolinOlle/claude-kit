/**
 * `claude-kit context`: what a cold session loads that this repo (and your ~/.claude) controls.
 * Built-in system prompt and tool definitions are fixed per Claude Code version and aren't
 * estimated here; `/context` inside a session shows them.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { GlobalOptions } from '../cli.ts';
import {
  apiCounter,
  countAll,
  type Counter,
  DEFAULT_COUNT_MODEL,
  describeCountError,
  framedCounter,
} from '../core/exactCount.ts';
import {
  atStart,
  defaultConfigDir,
  discoverMemory,
  frontmatter,
  type DiscoverOptions,
  type MemoryFile,
} from '../core/memory.ts';
import { readJson, readText } from '../utils/fsSafe.ts';
import { c, log } from '../utils/logger.ts';
import { glob } from '../utils/runtime.ts';
import { estimateTokens, formatTokens } from '../utils/tokenCount.ts';

export const CONTEXT_WINDOW = 200_000;
/** Per-entry framing around a skill/agent/command listing. */
const LISTING_OVERHEAD = 12;

export interface ContextItem {
  label: string;
  group: 'memory' | 'skills' | 'agents' | 'commands';
  tokens: number;
  path?: string;
  importedBy?: string;
}

export interface ContextReport {
  root: string;
  window: number;
  items: ContextItem[];
  total: number;
  onDemand: { files: number; tokens: number };
  mcpServers: string[];
  /** How `tokens` were obtained. */
  method: { kind: 'estimate' } | { kind: 'exact'; model: string };
}

export interface ReportOptions extends DiscoverOptions {
  /** With a counter, every item is re-counted exactly (`--exact`). */
  counter?: Counter;
  model?: string;
}

const SCOPE_LABEL: Record<MemoryFile['scope'], string> = {
  project: 'project',
  'project-local': 'local',
  ancestor: 'parent dir',
  user: 'user',
  'user-rules': 'user rule',
  rules: 'rule',
  'agents-md': 'AGENTS.md',
  nested: 'nested',
  import: 'import',
  'auto-memory': 'auto memory',
};

type Counted = { item: ContextItem; text: string };

async function listings(
  dirs: string[],
  pattern: string,
  group: ContextItem['group'],
  kind: string,
): Promise<Counted[]> {
  const items: Counted[] = [];
  for (const dir of dirs) {
    try {
      for (const rel of await glob(pattern, { cwd: dir })) {
        const text = (await readText(join(dir, rel))) ?? '';
        const fm = frontmatter(text) ?? {};
        const name = String(fm.name ?? rel.replace(/(\/SKILL)?\.md$/, ''));
        const body = text.replace(/^---[\s\S]*?\n---\n?/, '');
        const description = String(fm.description ?? body.split('\n').find((l) => l.trim()) ?? '');
        const listing = `${name}: ${description}`;
        items.push({
          item: {
            label: `${kind} ${name}`,
            group,
            tokens: estimateTokens(listing) + LISTING_OVERHEAD,
            path: join(dir, rel),
          },
          text: listing,
        });
      }
    } catch {
      // directory doesn't exist
    }
  }
  return items;
}

export async function buildContextReport(
  rootArg: string,
  opts: ReportOptions = {},
): Promise<ContextReport> {
  const root = resolve(rootArg);
  const configDir = opts.configDir ?? defaultConfigDir(opts.home ?? homedir());
  const memory = await discoverMemory(root, { ...opts, configDir });

  const counted: Counted[] = atStart(memory).map((f) => ({
    item: {
      label: `${f.display} (${SCOPE_LABEL[f.scope]})`,
      group: 'memory',
      tokens: f.tokens,
      path: f.path,
      importedBy: f.importedBy,
    },
    text: f.content,
  }));
  const project = join(root, '.claude');
  counted.push(
    ...(await listings(
      [join(project, 'skills'), join(configDir, 'skills')],
      '*/SKILL.md',
      'skills',
      'skill',
    )),
    ...(await listings(
      [join(project, 'agents'), join(configDir, 'agents')],
      '**/*.md',
      'agents',
      'agent',
    )),
    ...(await listings(
      [join(project, 'commands'), join(configDir, 'commands')],
      '**/*.md',
      'commands',
      'command',
    )),
  );

  const later = memory.filter((f) => !f.loadedAtStart);
  let onDemandTokens = later.reduce((s, f) => s + f.tokens, 0);
  if (opts.counter) {
    const exact = await countAll(
      [...counted.map((c) => c.text), ...later.map((f) => f.content)],
      opts.counter,
    );
    counted.forEach((c, i) => {
      // listings keep the framing estimate on top of their measured text
      c.item.tokens = exact[i]! + (c.item.group === 'memory' ? 0 : LISTING_OVERHEAD);
    });
    onDemandTokens = exact.slice(counted.length).reduce((s, n) => s + n, 0);
  }
  const items = counted.map((c) => c.item);
  const mcp = await readJson<{ mcpServers?: Record<string, unknown> }>(join(root, '.mcp.json'));
  return {
    root,
    window: CONTEXT_WINDOW,
    items,
    total: items.reduce((s, i) => s + i.tokens, 0),
    onDemand: { files: later.length, tokens: onDemandTokens },
    mcpServers: Object.keys(mcp?.mcpServers ?? {}),
    method: opts.counter
      ? { kind: 'exact', model: opts.model ?? DEFAULT_COUNT_MODEL }
      : { kind: 'estimate' },
  };
}

const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`;
const bar = (n: number, max: number, width = 16) =>
  '█'.repeat(Math.max(n > 0 ? 1 : 0, Math.round((width * n) / Math.max(max, 1))));

function delta(now: number, before: number | undefined): string {
  if (before === undefined) return c.dim('  new');
  const d = now - before;
  if (d === 0) return c.dim('  ±0');
  return d < 0 ? c.green(`  −${formatTokens(-d)}`) : c.red(`  +${formatTokens(d)}`);
}

/** Listing groups longer than this collapse into one line unless verbose. */
const COLLAPSE_AFTER = 5;

export function formatReport(r: ContextReport, baseline?: ContextReport, verbose = false): string {
  const before = new Map(baseline?.items.map((i) => [i.label, i.tokens]));
  const max = Math.max(...r.items.map((i) => i.tokens), 1);
  const width = Math.max(30, ...r.items.map((i) => i.label.length + (i.importedBy ? 4 : 0)));
  const groups: [ContextItem['group'], string][] = [
    ['memory', 'Instructions & memory'],
    ['skills', 'Skill listings'],
    ['agents', 'Subagent listings'],
    ['commands', 'Command listings'],
  ];

  const how =
    r.method?.kind === 'exact'
      ? `exact counts (${r.method.model} tokenizer)`
      : 'estimates ±15%, --exact for real counts';
  const out = [`${c.bold('Cold-session context')} ${c.dim(`${r.root} · ${how}`)}`];
  for (const [group, title] of groups) {
    const rows = r.items.filter((i) => i.group === group);
    if (rows.length === 0) continue;
    out.push('', c.bold(title));
    if (group !== 'memory' && rows.length > COLLAPSE_AFTER && !verbose) {
      const sum = rows.reduce((s, i) => s + i.tokens, 0);
      const was = baseline?.items
        .filter((i) => i.group === group)
        .reduce((s, i) => s + i.tokens, 0);
      const label = `${rows.length} ${group} ${c.dim('(--verbose to list)')}`;
      out.push(
        `  ${label.padEnd(width + (label.length - `${rows.length} ${group} (--verbose to list)`.length))} ${formatTokens(sum).padStart(6)}  ${c.cyan(bar(sum, max))}${baseline ? delta(sum, was) : ''}`,
      );
      continue;
    }
    for (const i of rows) {
      const label = i.importedBy ? `  └ ${i.label}` : i.label;
      const d = baseline ? delta(i.tokens, before.get(i.label)) : '';
      out.push(
        `  ${label.padEnd(width)} ${formatTokens(i.tokens).padStart(6)}  ${c.cyan(bar(i.tokens, max))}${d}`,
      );
    }
  }
  if (r.items.length === 0) out.push('', c.dim('  Nothing project-controlled loads at start.'));

  out.push(
    '',
    `${c.bold('Total you control'.padEnd(width + 2))} ${c.bold(formatTokens(r.total).padStart(6))}  ${c.dim(`${pct(r.total, r.window)} of a ${formatTokens(r.window)} window`)}${baseline ? delta(r.total, baseline.total) : ''}`,
  );
  if (baseline) {
    const gone = baseline.items.filter((b) => !r.items.some((i) => i.label === b.label));
    for (const g of gone) out.push(c.green(`  removed: ${g.label} (−${formatTokens(g.tokens)})`));
  }
  if (r.onDemand.files) {
    out.push(
      c.dim(
        `On demand (not at start): ${r.onDemand.files} nested CLAUDE.md / path-scoped rules, ~${formatTokens(r.onDemand.tokens)} tokens.`,
      ),
    );
  }
  if (r.mcpServers.length) {
    out.push(
      c.dim(
        `MCP: ${r.mcpServers.length} project server${r.mcpServers.length === 1 ? '' : 's'} (${r.mcpServers.join(', ')}); their tool definitions aren't measured here.`,
      ),
    );
  }
  out.push(
    c.dim(
      "Not included: Claude Code's built-in system prompt and tools (fixed per version). Run /context in a session for those.",
    ),
  );
  return out.join('\n');
}

export async function runContext(
  opts: GlobalOptions,
  discover: ReportOptions = {},
): Promise<number> {
  let counter = discover.counter;
  const model = opts.model ?? DEFAULT_COUNT_MODEL;
  if (opts.exact && !counter) {
    log.info(
      c.dim(
        `--exact sends the text of each loaded file to the Anthropic API (count_tokens, ${model}).`,
      ),
    );
    try {
      counter = await framedCounter(apiCounter(model));
    } catch (err) {
      log.error(describeCountError(err));
      return 1;
    }
  }
  let report: ContextReport;
  try {
    report = await buildContextReport(opts.cwd, { ...discover, counter, model });
  } catch (err) {
    if (!counter) throw err;
    log.error(describeCountError(err));
    return 1;
  }
  let baseline: ContextReport | undefined;
  if (opts.baseline) {
    const loaded = await readJson<ContextReport>(resolve(opts.baseline));
    if (!loaded || !Array.isArray(loaded.items)) {
      log.error(
        `Can't read a baseline report from ${opts.baseline} (save one with \`claude-kit context --json > file\`).`,
      );
      return 2;
    }
    baseline = loaded;
  }
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else log.info(formatReport(report, baseline, opts.verbose));
  return 0;
}
