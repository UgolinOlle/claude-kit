/**
 * Code search (#7) for humans and for Claude:
 *   claude-kit search <query…> [--limit 5] [--path dir] [--code]   ranked results in the terminal
 *   claude-kit search --related <file>                               imports, importers, tests
 *   claude-kit serve search                                          the `code-search` MCP server
 */
import { resolve } from 'node:path';

import type { GlobalOptions } from '../cli.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../data/package.ts';
import { SEARCH_SERVER } from '../generators/search.ts';
import { type McpTool, serveStdio } from '../mcp/stdioServer.ts';
import { type LoadedIndex, updateIndex } from '../search/index.ts';
import { related, search, type SearchResult } from '../search/query.ts';
import { c, configureLogger, log } from '../utils/logger.ts';

function formatResults(results: SearchResult[], loaded: LoadedIndex): string {
  if (results.length === 0)
    return 'No matches. Try other words (identifiers, error text) or a broader path.';
  const out = results.map((r, i) => {
    const chunks = r.chunks
      .map((h) => `L${h.lines}${h.symbols.length ? ` ${h.symbols.join(', ')}` : ''}`)
      .join(' · ');
    const lines = [`${i + 1}. ${r.path} (${r.score.toFixed(2)})`, `   ${chunks}`];
    if (r.related.length) lines.push(`   related: ${r.related.join(', ')}`);
    if (r.code) lines.push('```', r.code, '```');
    return lines.join('\n');
  });
  const s = loaded.stats;
  out.push(`(${s.files} files indexed${s.updated ? `, ${s.updated} updated` : ''})`);
  return out.join('\n');
}

function formatRelated(loaded: LoadedIndex, path: string): string {
  const r = related(loaded, path);
  if (!r.indexed)
    return `${r.path} isn't in the index (missing, binary, too large or excluded by .claudeignore).`;
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : '—');
  return [
    r.path,
    `imports:     ${list(r.imports)}`,
    `imported by: ${list(r.importedBy)}`,
    `tests:       ${list(r.tests)}`,
  ].join('\n');
}

const int = (v: unknown, def: number, min: number, max: number) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** Tool definitions are loaded into every session: keep descriptions short and exact. */
export function searchTools(root: string): McpTool[] {
  return [
    {
      name: 'search_code',
      description:
        'Ranked search over this project\'s code and docs, by function, class and section. Use it for "where is X handled / defined / configured" before grepping or opening files. Returns files with the matching line ranges and symbols, plus import-graph neighbours; then read only those ranges. Never returns files excluded by .claudeignore.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to find: identifiers, concepts, error text',
          },
          k: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            default: 5,
            description: 'Number of files',
          },
          path: {
            type: 'string',
            description: 'Only under this directory or glob',
          },
          include_code: {
            type: 'boolean',
            default: false,
            description: 'Also return the best-matching chunk of each file (numbered lines)',
          },
          max_tokens: {
            type: 'integer',
            default: 4000,
            description: 'Budget for include_code; lower-ranked chunks are dropped first',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async handler(args) {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query is required');
        const loaded = await updateIndex(root);
        const results = await search(loaded, query, {
          k: int(args.k, 5, 1, 20),
          path: typeof args.path === 'string' ? args.path : undefined,
          includeCode: args.include_code === true,
          // The project's retrieved_context budget (#12) caps what one call can pull in.
          maxTokens: int(
            args.max_tokens,
            4000,
            200,
            (await loadConfig(root)).budgets.retrieved_context,
          ),
        });
        return formatResults(results, loaded);
      },
    },
    {
      name: 'related_files',
      description:
        'For one project file: what it imports, what imports it, and tests that look like they cover it. Use before changing a file to find its callers and tests.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file path' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async handler(args) {
        if (typeof args.path !== 'string' || !args.path) throw new Error('path is required');
        return formatRelated(await updateIndex(root), args.path);
      },
    },
  ];
}

export async function runServe(opts: GlobalOptions, args: string[]): Promise<number> {
  if (args[0] !== 'search') {
    log.error('Usage: claude-kit serve search   (MCP server over stdio; started by Claude Code)');
    return 2;
  }
  configureLogger({ silent: true }); // stdout belongs to the protocol
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || opts.cwd);
  await serveStdio({ name: SEARCH_SERVER, version: VERSION }, searchTools(root));
  return 0;
}

export async function runSearch(opts: GlobalOptions, words: string[]): Promise<number> {
  const root = resolve(opts.cwd);
  if (opts.related) {
    const loaded = await updateIndex(root);
    if (opts.json) console.log(JSON.stringify(related(loaded, opts.related), null, 2));
    else log.info(formatRelated(loaded, opts.related));
    return 0;
  }
  const query = words.join(' ').trim();
  if (!query) {
    log.error(
      'Usage: claude-kit search <query…> [--limit 5] [--path dir] [--code]  |  --related <file>',
    );
    return 2;
  }
  const limit = opts.limit === undefined ? 5 : Number(opts.limit);
  const loaded = await updateIndex(root);
  const results = await search(loaded, query, {
    k: Number.isFinite(limit) && limit > 0 ? limit : 5,
    path: opts.path,
    includeCode: opts.code,
  });
  if (opts.json) console.log(JSON.stringify({ stats: loaded.stats, results }, null, 2));
  else
    log.info(
      formatResults(results, loaded).replace(/^(\d+\. )(\S+)/gm, (_, n, p) => n + c.bold(p)),
    );
  return 0;
}
