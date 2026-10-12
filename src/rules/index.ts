import type { Feature } from '../core/presets.ts';
import { globMatcher } from '../utils/runtime.ts';

import { volatileContent, volatileImport } from './cache.ts';
import {
  autoMemoryOverflow,
  claudeMdMissing,
  claudeMdTooLong,
  missingImport,
  unscopedRule,
} from './claudemd.ts';
import { gitignoreDrift, ignoreMissing, ignoreNotEnforced, settingsInvalid } from './ignore.ts';
import {
  largeDocs,
  largeRepo,
  mcpServers,
  mcpToolCost,
  missingGuardrails,
  projectRulesBudget,
} from './misc.ts';
import type { Finding, Rule, RuleContext, Severity } from './types.ts';

export const RULES: Rule[] = [
  settingsInvalid,
  ignoreNotEnforced,
  ignoreMissing,
  claudeMdMissing,
  claudeMdTooLong,
  missingImport,
  volatileContent,
  volatileImport,
  autoMemoryOverflow,
  missingGuardrails,
  gitignoreDrift,
  unscopedRule,
  projectRulesBudget,
  largeDocs,
  mcpServers,
  mcpToolCost,
  largeRepo,
];

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
/** Info findings are advice; they don't cost points. */
const PENALTY: Record<Severity, number> = { error: 25, warn: 10, info: 0 };

export interface RuleRun {
  findings: Finding[];
  score: number;
  /** Features `doctor --fix` would (re)generate. */
  fixFeatures: Feature[];
}

export async function runRules(ctx: RuleContext, rules: Rule[] = RULES): Promise<RuleRun> {
  const { rules: levels, exclude } = ctx.config;
  const excluded = exclude.map((g) => globMatcher(g));
  const active = rules.filter((r) => levels[r.id] !== 'off');
  const results = await Promise.all(
    active.map(async (r) => {
      const level = levels[r.id];
      const findings = (await r.check(ctx))
        .filter((f) => !f.file || !excluded.some((matches) => matches(f.file!)))
        .map((f) => (level && level !== 'off' ? { ...f, severity: level } : f));
      return { rule: r, findings };
    }),
  );
  const findings = results
    .flatMap((r) => r.findings)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.tokens ?? 0) - (a.tokens ?? 0));
  const fixFeatures = [
    ...new Set(
      results.filter((r) => r.findings.some((f) => f.fixable)).flatMap((r) => r.rule.fixWith ?? []),
    ),
  ];
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + PENALTY[f.severity], 0));
  return { findings, score, fixFeatures };
}

export const meetsThreshold = (f: Finding, failOn: Severity) => RANK[f.severity] <= RANK[failOn];

export type { Finding, Rule, RuleContext, Severity } from './types.ts';
