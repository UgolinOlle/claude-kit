import { parseIgnoreFile } from '../core/context.ts';
import { ignoreToDenyRules } from '../core/ignore.ts';

import type { Rule, RuleContext } from './types.ts';

const denyRules = (ctx: RuleContext) =>
  new Set([
    ...(ctx.settings?.permissions?.deny ?? []),
    ...(ctx.localSettings?.permissions?.deny ?? []),
  ]);

const preview = (items: string[], n = 5) =>
  items.slice(0, n).join(', ') + (items.length > n ? `, … (+${items.length - n})` : '');

export const ignoreNotEnforced: Rule = {
  id: 'ignore/not-enforced',
  description:
    "Claude Code doesn't read .claudeignore; only permissions.deny Read(...) rules block reads.",
  fixWith: ['claudeignore'],
  check(ctx) {
    if (ctx.claudeignore === null || ctx.settingsError) return [];
    const wanted = ignoreToDenyRules(ctx.claudeignore.split('\n'));
    const have = denyRules(ctx);
    const missing = wanted.filter((r) => !have.has(r));
    if (missing.length === 0) return [];
    return [
      {
        ruleId: this.id,
        severity: 'error',
        file: '.claudeignore',
        message: `${missing.length} of ${wanted.length} .claudeignore patterns aren't enforced: Claude Code ignores .claudeignore and only applies permissions.deny. Missing: ${preview(missing)}`,
        hint: 'Run `claude-kit doctor --fix` (or `claude-kit sync` once set up) to compile it into deny rules.',
        fixable: true,
      },
    ];
  },
};

export const ignoreMissing: Rule = {
  id: 'ignore/missing',
  description: 'Nothing stops Claude from reading build output, lockfiles or secrets.',
  fixWith: ['claudeignore'],
  check(ctx) {
    if (ctx.claudeignore !== null || ctx.settingsError) return [];
    if ([...denyRules(ctx)].some((r) => r.startsWith('Read('))) return [];
    return [
      {
        ruleId: this.id,
        severity: 'warn',
        message:
          'No read exclusions: Claude can read node_modules, build output, lockfiles and .env files into context.',
        fixable: true,
      },
    ];
  },
};

export const gitignoreDrift: Rule = {
  id: 'ignore/gitignore-drift',
  description: ".gitignore patterns that .claudeignore doesn't cover.",
  fixWith: ['claudeignore'],
  check(ctx) {
    if (ctx.claudeignore === null) return [];
    const have = new Set(parseIgnoreFile(ctx.claudeignore).map((l) => l.replace(/\/$/, '')));
    const missing = ctx.project.gitignore.filter((l) => !have.has(l.replace(/\/$/, '')));
    if (missing.length === 0) return [];
    return [
      {
        ruleId: this.id,
        severity: 'info',
        file: '.claudeignore',
        message: `${missing.length} .gitignore pattern${missing.length === 1 ? " isn't" : "s aren't"} in .claudeignore: ${preview(missing)}`,
        hint: "Usually generated or local files Claude doesn't need; add them unless Claude should read them.",
        fixable: true,
      },
    ];
  },
};

export const settingsInvalid: Rule = {
  id: 'settings/invalid-json',
  description: '.claude/settings.json must be valid JSON or Claude Code ignores it.',
  check(ctx) {
    if (!ctx.settingsError) return [];
    return [
      {
        ruleId: this.id,
        severity: 'error',
        file: '.claude/settings.json',
        message: `.claude/settings.json is not valid JSON (${ctx.settingsError}); its permissions and hooks don't apply.`,
      },
    ];
  },
};
