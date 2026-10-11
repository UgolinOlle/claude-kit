import { sep } from 'node:path';

import type { MemoryFile } from '../core/memory.ts';
import { formatTokens } from '../utils/tokenCount.ts';

import type { Finding, Rule, RuleContext } from './types.ts';

/** The docs' own guidance: target < 200 lines; the article flags > 500 as a warning sign. */
export const CLAUDEMD_WARN_LINES = 200;
export const CLAUDEMD_ERROR_LINES = 500;
const UNSCOPED_RULE_TOKENS = 1500;
const AUTO_MEMORY_LINES = 200;
const AUTO_MEMORY_BYTES = 25 * 1024;

/** Files this repo controls (doctor doesn't lint ~/.claude, CI can't see it anyway). */
export function inRepo(ctx: RuleContext, f: MemoryFile): boolean {
  return f.path.startsWith(ctx.project.root + sep);
}

const contentLines = (f: MemoryFile) => f.content.trimEnd().split('\n').length;

export const claudeMdMissing: Rule = {
  id: 'claudemd/missing',
  description: 'The project has no CLAUDE.md (or AGENTS.md) for Claude to start from.',
  fixWith: ['claudemd'],
  check(ctx) {
    const has = ctx.memory.some((f) => ['project', 'project-local', 'agents-md'].includes(f.scope));
    if (has) return [];
    return [
      {
        ruleId: this.id,
        severity: 'warn',
        message:
          'No CLAUDE.md: every session starts without project context and rediscovers it by reading files.',
        fixable: true,
      },
    ];
  },
};

export const claudeMdTooLong: Rule = {
  id: 'claudemd/too-long',
  description: `Instruction files over ${CLAUDEMD_WARN_LINES} lines cost context on every session and reduce adherence.`,
  check(ctx) {
    const findings: Finding[] = [];
    for (const f of ctx.memory) {
      if (!inRepo(ctx, f) || f.scope === 'rules') continue;
      const lines = contentLines(f);
      if (lines <= CLAUDEMD_WARN_LINES) continue;
      const when = f.loadedAtStart ? 'every session' : 'whenever Claude works in that directory';
      findings.push({
        ruleId: this.id,
        severity: lines > CLAUDEMD_ERROR_LINES ? 'error' : 'warn',
        file: f.display,
        message: `${f.display} is ${lines} lines (~${formatTokens(f.tokens)} tokens, loaded ${when}); target < ${CLAUDEMD_WARN_LINES}.`,
        hint: 'Move topic-specific sections into .claude/rules/<topic>.md with `paths:` frontmatter (loaded only when relevant) or into docs/ that Claude reads on demand.',
        tokens: f.loadedAtStart ? f.tokens : 0,
      });
    }
    return findings;
  },
};

export const missingImport: Rule = {
  id: 'claudemd/missing-import',
  description: "An `@path` import points at a file that doesn't exist.",
  check(ctx) {
    return ctx.memory
      .filter((f) => inRepo(ctx, f))
      .flatMap((f) =>
        f.missingImports.map((m) => ({
          ruleId: this.id,
          severity: 'warn' as const,
          file: f.display,
          line: m.line,
          message: `${f.display}:${m.line} imports @${m.spec}, which doesn't exist.`,
          hint: "Fix the path, or wrap it in backticks if it isn't meant as an import (e.g. an npm scope like `@types/node`).",
        })),
      );
  },
};

export const unscopedRule: Rule = {
  id: 'rules/unscoped-large',
  description: 'Large .claude/rules files without `paths:` frontmatter load on every session.',
  check(ctx) {
    return ctx.memory
      .filter((f) => f.scope === 'rules' && f.loadedAtStart && f.tokens > UNSCOPED_RULE_TOKENS)
      .map((f) => ({
        ruleId: this.id,
        severity: 'info' as const,
        file: f.display,
        message: `${f.display} (~${formatTokens(f.tokens)} tokens) loads on every session because it has no \`paths:\` frontmatter.`,
        hint: 'If it only applies to part of the codebase, add `paths:` so it loads only when Claude touches matching files.',
        tokens: f.tokens,
      }));
  },
};

export const autoMemoryOverflow: Rule = {
  id: 'memory/auto-memory-truncated',
  description: "Only the first 200 lines / 25KB of auto memory's MEMORY.md load at session start.",
  check(ctx) {
    return ctx.memory
      .filter((f) => f.scope === 'auto-memory')
      .filter((f) => f.lines > AUTO_MEMORY_LINES || Buffer.byteLength(f.raw) > AUTO_MEMORY_BYTES)
      .map((f) => ({
        ruleId: this.id,
        severity: 'warn' as const,
        file: f.display,
        message: `${f.display} is ${f.lines} lines; everything after line ${AUTO_MEMORY_LINES} (or 25KB) is invisible at session start.`,
        hint: 'Keep MEMORY.md as a one-line-per-entry index and move details into topic files.',
      }));
  },
};
