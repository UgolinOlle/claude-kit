import { join } from 'node:path';

import { RAG_THRESHOLD_TOKENS } from '../detect/size.ts';
import { estimateTokensFromBytes, formatTokens } from '../utils/tokenCount.ts';

import type { Finding, Rule, RuleContext } from './types.ts';

const LARGE_DOC_TOKENS = 10_000;

/** Hook matchers: exact names joined by `|`, or a regex; "", "*" or absent match everything. */
export function matcherCovers(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === '*') return true;
  if (/^[\w\s,|-]+$/.test(matcher))
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .includes(tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

function hasEditGuard(ctx: RuleContext): boolean {
  const groups = [
    ...(ctx.settings?.hooks?.PreToolUse ?? []),
    ...(ctx.localSettings?.hooks?.PreToolUse ?? []),
  ];
  return groups.some((g) => matcherCovers(g.matcher, 'Edit') && matcherCovers(g.matcher, 'Write'));
}

export const missingGuardrails: Rule = {
  id: 'hooks/missing-guardrails',
  description: 'No PreToolUse hook guards Edit/Write.',
  fixWith: ['hooks'],
  check(ctx) {
    if (ctx.settingsError || hasEditGuard(ctx)) return [];
    return [
      {
        ruleId: this.id,
        severity: 'info',
        message:
          'No PreToolUse hook on Edit/Write: nothing stops edits to lockfiles, build output or .env files.',
        fixable: true,
      },
    ];
  },
};

export const largeDocs: Rule = {
  id: 'docs/oversized',
  description: 'Markdown docs so large that reading one floods the context window.',
  async check(ctx) {
    const findings: Finding[] = [];
    for (const dir of ['docs', '.claude']) {
      const glob = new Bun.Glob('**/*.md');
      try {
        for await (const rel of glob.scan({ cwd: join(ctx.project.root, dir), onlyFiles: true })) {
          const tokens = estimateTokensFromBytes(Bun.file(join(ctx.project.root, dir, rel)).size);
          if (tokens <= LARGE_DOC_TOKENS) continue;
          findings.push({
            ruleId: this.id,
            severity: 'info',
            file: `${dir}/${rel}`,
            message: `${dir}/${rel} is ~${formatTokens(tokens)} tokens; Claude reads files whole, so one lookup costs all of it.`,
            hint: 'Split it by topic or put a short summary and table of contents at the top.',
          });
        }
      } catch {
        // directory doesn't exist
      }
    }
    return findings;
  },
};

export const mcpServers: Rule = {
  id: 'mcp/servers',
  description: 'Project MCP servers add tool definitions to sessions.',
  check(ctx) {
    if (ctx.mcpServers.length === 0) return [];
    return [
      {
        ruleId: this.id,
        severity: 'info',
        file: '.mcp.json',
        message: `${ctx.mcpServers.length} project MCP server${ctx.mcpServers.length === 1 ? '' : 's'} configured (${ctx.mcpServers.join(', ')}).`,
        hint: "Run /context in a session to see what their tools actually cost; remove servers the team doesn't use.",
      },
    ];
  },
};

export const largeRepo: Rule = {
  id: 'size/large-repo',
  description: 'Repos far bigger than the context window benefit from scoped instructions.',
  async check(ctx) {
    const size = await ctx.project.size();
    if (!size.needsRag) return [];
    return [
      {
        ruleId: this.id,
        severity: 'info',
        message: `The repo is ~${formatTokens(size.estTokens)} tokens of text (> ${formatTokens(RAG_THRESHOLD_TOKENS)}): Claude can only ever see a slice of it.`,
        hint: 'Add nested CLAUDE.md files or path-scoped .claude/rules so each area loads its own guidance, and keep a short map of the codebase in CLAUDE.md.',
      },
    ];
  },
};
