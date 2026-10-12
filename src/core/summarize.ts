import { estimateTokens } from '../utils/tokenCount.ts';

/**
 * `compress --summarize` (#14): shrink a long document to a token budget.
 *   hierarchical_compress: split by headings, rank sections by how many facts they carry, keep
 *     critical ones whole, ask the model to summarise the rest to ~30%, omit what doesn't fit.
 *   hierarchical_trim: if the result is still over budget, omit the least important sections
 *     one at a time, re-measuring after each (the article's loop never re-measured).
 * Every summarised or omitted section keeps its heading and source line range, so Claude can
 * open the original when it needs the detail. One model call per document.
 */
import { compressMarkdown } from './compress.ts';
import { extractKeyInfo } from './extract.ts';

export interface Section {
  id: number;
  heading: string | null;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
  tokens: number;
  /** Facts per 100 tokens: API references, constraints, numbers, tables, code. */
  importance: number;
  /** Carries code, tables, API references or several constraints: keep verbatim when it fits. */
  critical: boolean;
}

export type Action = { kind: 'keep' } | { kind: 'summarize'; target: number } | { kind: 'omit' };

export interface SummaryRequest {
  source: string;
  sections: { id: number; heading: string | null; text: string; target: number }[];
}

/** Returns section id → summary text. Injected so tests don't call the API. */
export type Summarizer = (req: SummaryRequest) => Promise<Map<number, string>>;

const SUMMARY_RATIO = 0.3;
/** Sections this small cost less kept whole than summarised. */
const SMALL = 60;
/** Allowed overshoot before trimming kicks in. */
const SLACK = 1.15;
const FENCE = /^\s*(```|~~~)/;
const SPLIT_HEADING = /^#{1,3}\s+\S/;

export function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let start = 0;
  let fence: string | null = null;
  const flush = (end: number) => {
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) {
      const first = lines[start]!;
      const facts = extractKeyInfo(body);
      const count =
        facts.api.length * 2 +
        facts.constraints.length +
        facts.numbers.length * 0.5 +
        facts.tables.length * 2 +
        facts.code.length * 3;
      const tokens = estimateTokens(body);
      sections.push({
        id: sections.length,
        heading: SPLIT_HEADING.test(first) ? first.trim() : null,
        start: start + 1,
        end,
        text: body,
        tokens,
        importance: count / Math.max(1, tokens / 100),
        critical:
          facts.code.length > 0 ||
          facts.tables.length > 0 ||
          facts.api.length > 0 ||
          facts.constraints.length >= 2,
      });
    }
    start = end;
  };
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
      return;
    }
    if (marker) fence = marker;
    else if (i > start && SPLIT_HEADING.test(line)) flush(i);
  });
  flush(lines.length);
  return sections;
}

/** hierarchical_compress: decide each section's fate within `target` tokens. */
export function planSections(sections: Section[], target: number): Map<number, Action> {
  const plan = new Map<number, Action>();
  let budget = target;
  const ranked = [...sections].sort(
    (a, b) => Number(b.critical) - Number(a.critical) || b.importance - a.importance || a.id - b.id,
  );
  for (const s of ranked) {
    const want = Math.max(20, Math.ceil(s.tokens * SUMMARY_RATIO));
    if ((s.critical || s.tokens <= SMALL) && s.tokens <= budget) {
      plan.set(s.id, { kind: 'keep' });
      budget -= s.tokens;
    } else if (s.tokens > SMALL && want <= budget) {
      plan.set(s.id, { kind: 'summarize', target: want });
      budget -= want;
    } else plan.set(s.id, { kind: 'omit' });
  }
  return plan;
}

const pointer = (s: Section, source: string) =>
  `_(${s.heading ? 'omitted' : 'intro omitted'}: ${source} L${s.start}-${s.end})_`;

export function assemble(
  sections: Section[],
  plan: Map<number, Action>,
  summaries: Map<number, string>,
  source: string,
): string {
  return sections
    .map((s) => {
      const action = plan.get(s.id)!;
      if (action.kind === 'keep') return compressMarkdown(s.text);
      const summary = action.kind === 'summarize' ? summaries.get(s.id)?.trim() : undefined;
      const body = summary || pointer(s, source);
      return s.heading ? `${s.heading}\n${body}` : body;
    })
    .join('\n\n');
}

/** hierarchical_trim: omit the least important sections until the result fits. */
export function trimToBudget(
  sections: Section[],
  plan: Map<number, Action>,
  summaries: Map<number, string>,
  source: string,
  target: number,
): string {
  const order = [...sections].sort(
    (a, b) => Number(a.critical) - Number(b.critical) || a.importance - b.importance || b.id - a.id,
  );
  let text = assemble(sections, plan, summaries, source);
  for (const s of order) {
    if (estimateTokens(text) <= target * SLACK) break;
    if (plan.get(s.id)!.kind === 'omit') continue;
    plan.set(s.id, { kind: 'omit' });
    text = assemble(sections, plan, summaries, source); // re-measure every pass
  }
  return text;
}

export interface SummarizeResult {
  text: string;
  before: number;
  after: number;
  kept: number;
  summarized: number;
  omitted: number;
}

/** Sections that would be sent, for the consent prompt and cost estimate. */
export function summaryRequest(text: string, source: string, ratio: number) {
  const sections = splitSections(text);
  const before = sections.reduce((n, s) => n + s.tokens, 0);
  const target = Math.max(200, Math.round(before * ratio));
  const plan = planSections(sections, target);
  const request: SummaryRequest = {
    source,
    sections: sections
      .filter((s) => plan.get(s.id)!.kind === 'summarize')
      .map((s) => ({
        id: s.id,
        heading: s.heading,
        text: s.text,
        target: (plan.get(s.id) as { target: number }).target,
      })),
  };
  return { sections, plan, request, before, target };
}

export async function summarizeDocument(
  text: string,
  source: string,
  ratio: number,
  summarizer: Summarizer,
): Promise<SummarizeResult> {
  const { sections, plan, request, before, target } = summaryRequest(text, source, ratio);
  const summaries = request.sections.length ? await summarizer(request) : new Map<number, string>();
  const body = trimToBudget(sections, plan, summaries, source, target);
  const after = estimateTokens(body);
  const kinds = [...plan.values()].map((a) => a.kind);
  const count = (k: Action['kind']) => kinds.filter((x) => x === k).length;
  return {
    text: `<!-- claude-kit summary of ${source}: ~${before} → ~${after} tokens. Omitted sections point to their lines in the source. -->\n\n${body}`,
    before,
    after,
    kept: count('keep'),
    summarized: count('summarize'),
    omitted: count('omit'),
  };
}

// ── prompt + parsing (the API call itself lives in the command) ─────────────

export const SUMMARY_SYSTEM = `You compress technical documentation for an AI coding assistant's context window.
Keep: specifications, API contracts, constraints and limits, exact names, numbers, error messages, short code.
Remove: narrative, history, motivation, repetition, transitions, rhetorical questions, marketing.
Prefer terse bullets and tables. Never add facts that aren't in the text.`;

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function summaryPrompt(req: SummaryRequest): string {
  const sections = req.sections
    .map(
      (s) =>
        `<section id="${s.id}" heading="${escapeAttr(s.heading ?? '(intro)')}" target_tokens="${s.target}">\n${s.text}\n</section>`,
    )
    .join('\n\n');
  return `Document: ${req.source}

Summarise each section below to roughly its target_tokens. Don't repeat the heading.
Answer with one <summary id="N">…</summary> per section, in order, and nothing else.

${sections}`;
}

export function parseSummaries(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of text.matchAll(/<summary id="(\d+)">([\s\S]*?)<\/summary>/g))
    out.set(Number(m[1]), m[2]!.trim());
  return out;
}
