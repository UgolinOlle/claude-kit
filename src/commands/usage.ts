/**
 * `claude-kit usage`: what past sessions in this project actually cost, from the local
 * transcripts. Where `context` measures the static cost of a cold start, `usage` measures the
 * running cost: cache health, cache breaks and their causes, and the files Claude keeps reading.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { GlobalOptions } from "../cli.ts";
import {
  analyzeUsage,
  type BreakCause,
  type UsageOptions,
  type UsageReport,
} from "../core/usage.ts";
import { NPX } from "../data/package.ts";
import { c, log } from "../utils/logger.ts";
import { formatTokens } from "../utils/tokenCount.ts";

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const day = (iso: string) => iso.slice(0, 10);

const CAUSE: Record<BreakCause, { label: string; hint: string }> = {
  idle: {
    label: "idle past cache TTL",
    hint: "The cache expired during a pause. After a long break, a fresh session that reads task_context.md is often cheaper than resuming a huge one.",
  },
  "model-switch": {
    label: "model switch",
    hint: "Caches are per model; each /model change (or opusplan entering/leaving Plan Mode) re-reads the whole context at write price.",
  },
  "prefix-changed": {
    label: "prompt prefix changed",
    hint: `Something early in the prompt changed mid-session: CLAUDE.md or rules edited, settings/MCP tools changed, or effort switched. \`${NPX} doctor\` flags volatile content.`,
  },
};

const ratioColor = (r: number) =>
  r >= 0.8 ? c.green : r >= 0.5 ? c.yellow : c.red;

export function formatUsage(r: UsageReport, limit = 10): string {
  const window = r.sinceDays > 0 ? `last ${r.sinceDays} days` : "all time";
  const out = [
    `${c.bold("Session usage")} ${c.dim(`${r.root} · ${window} · from ${r.transcriptDir}`)}`,
  ];
  if (r.sessions.length === 0) {
    out.push(
      "",
      c.dim("  No Claude Code sessions found for this project in that period."),
    );
    return out.join("\n");
  }
  const t = r.totals.tokens;
  const unpriced = r.sessions.some((s) => s.unpriced);
  out.push(
    "",
    `  ${c.bold(usd(r.totals.cost))} ${c.dim(`est. at API prices${unpriced ? ", some models unpriced" : ""}`)} · ${r.sessions.length} session${r.sessions.length === 1 ? "" : "s"} · ${r.totals.requests} requests`,
    `  cache hit ${ratioColor(r.totals.hitRatio)(pct(r.totals.hitRatio))} · read ${formatTokens(t.cacheRead)} · written ${formatTokens(t.cacheWrite5m + t.cacheWrite1h)} · uncached ${formatTokens(t.input)} · output ${formatTokens(t.output)}`,
  );
  const models = Object.entries(r.models).sort((a, b) => b[1].cost - a[1].cost);
  if (models.length)
    out.push(
      `  models ${models.map(([m, v]) => `${m} ${r.totals.cost ? pct(v.cost / r.totals.cost) : `${v.requests} req`}`).join(c.dim(" · "))}`,
    );

  out.push("", c.bold("Sessions") + c.dim(" (newest first)"));
  out.push(
    c.dim(
      `  ${"date".padEnd(10)}  ${"session".padEnd(8)}  ${"requests".padStart(8)}  ${"cost".padStart(7)}  ${"cache".padStart(5)}  ${"peak ctx".padStart(8)}  breaks`,
    ),
  );
  for (const s of r.sessions.slice(0, limit)) {
    const sub = s.subagentRequests ? c.dim(` (${s.subagentRequests} sub)`) : "";
    const compacted = s.compactions
      ? c.dim(` · ${s.compactions} compaction${s.compactions === 1 ? "" : "s"}`)
      : "";
    out.push(
      `  ${day(s.end)}  ${s.id.slice(0, 8)}  ${String(s.requests).padStart(8)}  ${usd(s.cost).padStart(7)}  ${ratioColor(s.hitRatio)(pct(s.hitRatio).padStart(5))}  ${formatTokens(s.peakContext).padStart(8)}  ${String(s.breaks.length).padStart(6)}${sub}${compacted}`,
    );
  }
  if (r.sessions.length > limit)
    out.push(c.dim(`  … ${r.sessions.length - limit} more (--limit to show)`));

  if (r.breaks.length) {
    out.push(
      "",
      c.bold("Cache breaks") + c.dim(" (context re-written instead of read)"),
    );
    for (const b of r.breaks)
      out.push(
        `  ${CAUSE[b.cause].label.padEnd(22)} ${String(b.count).padStart(4)}×  ${formatTokens(b.tokens).padStart(6)} tokens  ${c.dim(`~${usd(b.cost)} extra`)}`,
      );
  }

  const heavy = r.files.slice(0, limit);
  if (heavy.length) {
    out.push("", c.bold("Most-read files") + c.dim(" (by tokens returned)"));
    const width = Math.min(60, Math.max(...heavy.map((f) => f.path.length)));
    for (const f of heavy)
      out.push(
        `  ${f.path.length > width ? "…" + f.path.slice(-(width - 1)) : f.path.padEnd(width)}  ${String(f.reads).padStart(4)}×  ~${formatTokens(f.tokens)}`,
      );
  }

  const tips = suggestions(r);
  if (tips.length)
    out.push("", c.bold("Suggestions"), ...tips.map((s) => `  → ${s}`));
  return out.join("\n");
}

export function suggestions(r: UsageReport): string[] {
  const tips: string[] = [];
  if (r.totals.hitRatio < 0.7 && r.totals.requests >= 20)
    tips.push(
      `Cache hit ratio is ${pct(r.totals.hitRatio)}; healthy sessions sit above 80%. See the break causes above.`,
    );
  for (const b of r.breaks) if (b.count >= 3) tips.push(CAUSE[b.cause].hint);
  const reread = r.files
    .filter((f) => f.reads >= 4 && f.tokens >= 20_000)
    .slice(0, 3);
  if (reread.length)
    tips.push(
      `Re-read often: ${reread.map((f) => `\`${f.path}\``).join(", ")}. Point to them from CLAUDE.md with a one-line summary, skim with \`${NPX} compress --outline\`, or add generated ones to .claudeignore.`,
    );
  const subagent = r.sessions.reduce((n, s) => n + s.subagentRequests, 0);
  if (r.totals.requests >= 50 && subagent === 0)
    tips.push(
      "No subagent use: delegating broad searches (e.g. the `explorer` agent from `--preset full`) keeps file dumps out of the main context.",
    );
  return tips;
}

export async function runUsage(
  opts: GlobalOptions,
  extra: UsageOptions = {},
): Promise<number> {
  const days = opts.days === undefined ? 30 : Number(opts.days);
  if (!Number.isFinite(days) || days < 0) {
    log.error(
      `--days must be a number of days (0 for all time), got "${opts.days}".`,
    );
    return 2;
  }
  const limit = opts.limit === undefined ? 10 : Number(opts.limit);
  const report = await analyzeUsage(resolve(opts.cwd), {
    home: homedir(),
    ...extra,
    days,
    session: opts.session,
  });
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else
    log.info(
      formatUsage(report, Number.isFinite(limit) && limit > 0 ? limit : 10),
    );
  return 0;
}
