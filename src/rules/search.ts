import { NPX } from '../data/package.ts';
import { SEARCH_SERVER } from '../generators/search.ts';
import { modelDownloaded, runtimeVersion, TRANSFORMERS_VERSION } from '../search/embed.ts';

import type { Finding, Rule } from './types.ts';

export const searchEmbeddings: Rule = {
  id: 'search/embeddings',
  description: 'Semantic code search is enabled but something it needs is missing.',
  async check(ctx) {
    const emb = ctx.config.search.embeddings;
    if (!emb.enabled) return [];
    const findings: Finding[] = [];
    if (!ctx.mcpServers.includes(SEARCH_SERVER))
      findings.push({
        ruleId: this.id,
        severity: 'info',
        file: '.claude-kit/config.json',
        message: `search.embeddings is enabled, but the ${SEARCH_SERVER} MCP server isn't set up: Claude can't use it.`,
        hint: `\`${NPX} init --with search\` adds it.`,
      });
    const runtime = (await runtimeVersion()) === TRANSFORMERS_VERSION;
    if (!runtime || !(await modelDownloaded(emb.model)))
      findings.push({
        ruleId: this.id,
        severity: 'info',
        file: '.claude-kit/config.json',
        message: `search.embeddings is enabled, but the ${runtime ? `${emb.model} model isn't downloaded` : "embeddings runtime isn't installed"} on this machine: search falls back to keywords.`,
        hint: `\`${NPX} search --setup\` installs it (asks before downloading).`,
      });
    return findings;
  },
};
