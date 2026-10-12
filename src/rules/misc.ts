import { join, sep } from 'node:path';

import { probeServers, similarTools } from '../core/mcpProbe.ts';
import { NPX } from '../data/package.ts';
import { RAG_THRESHOLD_TOKENS } from '../detect/size.ts';
import { fileSize, glob } from '../utils/runtime.ts';
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
      try {
        for (const rel of await glob('**/*.md', {
          cwd: join(ctx.project.root, dir),
        })) {
          const tokens = estimateTokensFromBytes(await fileSize(join(ctx.project.root, dir, rel)));
          if (tokens <= LARGE_DOC_TOKENS) continue;
          findings.push({
            ruleId: this.id,
            severity: 'info',
            file: `${dir}/${rel}`,
            message: `${dir}/${rel} is ~${formatTokens(tokens)} tokens; Claude reads files whole, so one lookup costs all of it.`,
            hint: `Split it by topic or put a short summary and table of contents at the top; \`${NPX} compress ${dir}/${rel}\` shows how much is padding (badges, images, table alignment).`,
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

/** Tool definitions above this share of a 200K window make Claude Code defer them to tool search. */
const MCP_TOTAL_WARN = 20_000;
const MCP_SERVER_INFO = 5_000;

export const mcpToolCost: Rule = {
  id: 'mcp/tool-cost',
  description: 'Measured tool-definition tokens per MCP server (doctor --probe-mcp).',
  async check(ctx) {
    if (!ctx.probeMcp || ctx.mcpServers.length === 0) return [];
    const results = await probeServers(ctx.mcpConfigs, ctx.project.root);
    const findings: Finding[] = [];
    const total = results.reduce((n, r) => n + r.tokens, 0);
    for (const r of results) {
      if (r.status !== 'ok') {
        findings.push({
          ruleId: this.id,
          severity: 'info',
          file: '.mcp.json',
          message: `MCP server "${r.server}" ${r.status === 'skipped' ? 'not probed' : "couldn't be probed"}: ${r.detail}.`,
        });
        continue;
      }
      const similar = similarTools(r.tools.map((t) => t.name));
      const heaviest = [...r.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
      findings.push({
        ruleId: this.id,
        severity: 'info',
        file: '.mcp.json',
        tokens: r.tokens,
        message: `MCP server "${r.server}": ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}, ~${formatTokens(r.tokens)} tokens of definitions${heaviest.length ? ` (largest: ${heaviest.map((t) => `${t.name} ~${formatTokens(t.tokens)}`).join(', ')})` : ''}.`,
        hint:
          similar.length > 0
            ? `Merge look-alike tools into one parameterised tool: ${similar.map((g) => `${g.tools.length}× ${g.prefix}_*`).join(', ')}.`
            : r.tokens >= MCP_SERVER_INFO
              ? 'Trim long descriptions and schemas; return summaries and paginate (limit / has_more) instead of exposing many narrow tools.'
              : undefined,
      });
    }
    const budget = ctx.config.budgets.tool_definitions;
    if (total > budget) {
      const chosen = ctx.config.budgetsSet.includes('tool_definitions');
      findings.push({
        ruleId: this.id,
        // Past ~10% of a 200K window Claude Code defers tools to tool search: always worth a warning.
        severity: chosen || total >= MCP_TOTAL_WARN ? 'warn' : 'info',
        file: '.mcp.json',
        tokens: total,
        message: `Project MCP servers define ~${formatTokens(total)} tokens of tools, over the ${formatTokens(budget)} tool_definitions budget${chosen ? '' : " (the article's default)"}.`,
        hint:
          total >= MCP_TOTAL_WARN
            ? 'Over 10% of a 200K window, Claude Code loads them through tool search instead of upfront, which costs a search step per use. Remove servers the team rarely uses, or move them to personal (~/.claude.json) config.'
            : 'Remove servers the team rarely uses, merge look-alike tools, or raise budgets.tool_definitions in .claude-kit/config.json.',
      });
    }
    return findings;
  },
};

export const projectRulesBudget: Rule = {
  id: 'budget/project-rules',
  description: 'Always-loaded project instructions over the project_rules token budget.',
  check(ctx) {
    const loaded = ctx.memory.filter(
      (f) =>
        f.loadedAtStart && f.path.startsWith(ctx.project.root + sep) && f.scope !== 'project-local',
    );
    const total = loaded.reduce((n, f) => n + f.tokens, 0);
    const budget = ctx.config.budgets.project_rules;
    if (total <= budget) return [];
    const chosen = ctx.config.budgetsSet.includes('project_rules');
    const largest = [...loaded].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    return [
      {
        ruleId: this.id,
        severity: chosen ? 'warn' : 'info',
        file: largest[0]?.display,
        tokens: total - budget,
        message: `Always-loaded project instructions are ~${formatTokens(total)} tokens, over the ${formatTokens(budget)} project_rules budget${chosen ? '' : " (the article's default)"}: ${largest.map((f) => `${f.display} ~${formatTokens(f.tokens)}`).join(', ')}.`,
        hint: chosen
          ? 'Move rarely needed detail to docs/ (read on demand), scope rules with `paths:` frontmatter, or turn notes for humans into HTML comments (stripped before loading).'
          : 'Move rarely needed detail to docs/ (read on demand) or scope rules with `paths:` frontmatter. To choose your own limit, set budgets.project_rules in .claude-kit/config.json.',
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
        hint: `Add nested CLAUDE.md files or path-scoped .claude/rules so each area loads its own guidance, keep a short map of the codebase in CLAUDE.md, and consider ranked code search: \`${NPX} init --with search\`.`,
      },
    ];
  },
};
