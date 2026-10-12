import { join } from 'node:path';

import type { ProjectContext } from '../core/context.ts';
import { deepMergeJson, type Json } from '../core/merge.ts';
import type { FilePlan } from '../core/writer.ts';
import { NPX } from '../data/package.ts';
import dataServer from '../templates/mcp/data/server.mjs.tmpl' with { type: 'text' };
import dataTools from '../templates/mcp/data/tools.mjs.tmpl' with { type: 'text' };
import dbServer from '../templates/mcp/db/server.mjs.tmpl' with { type: 'text' };
import dbTools from '../templates/mcp/db/tools.mjs.tmpl' with { type: 'text' };
import logsServer from '../templates/mcp/logs/server.mjs.tmpl' with { type: 'text' };
import logsTools from '../templates/mcp/logs/tools.mjs.tmpl' with { type: 'text' };
import serverTemplate from '../templates/mcp/server.mjs.tmpl' with { type: 'text' };
import { render } from '../templates/render.ts';
import { readText } from '../utils/fsSafe.ts';

import type { HookRuntime } from './hooks.ts';

export const MCP_JSON = '.mcp.json';
export const SDK_VERSION = '^1.32.1';
export const ZOD_VERSION = '^4.0.0';
export const PG_VERSION = '^8.16.0';

/**
 * #15 tool-first servers. `basic` shows the patterns on project files; the others are the
 * article's examples made generic: data (analyze_transactions → analyze_csv), db
 * (query_database → query + describe_schema), logs (search_logs + get_errors).
 * Logic sits in tools.mjs (no MCP imports) so it can be tested and reused on its own.
 */
const TEMPLATES = {
  basic: {
    files: { 'server.mjs': serverTemplate },
    deps: {},
    summary: 'package_scripts + todos examples',
  },
  data: {
    files: { 'server.mjs': dataServer, 'tools.mjs': dataTools },
    deps: {},
    summary: 'analyze_csv: stats, outliers and a sample instead of the whole file',
  },
  db: {
    files: { 'server.mjs': dbServer, 'tools.mjs': dbTools },
    deps: { pg: PG_VERSION },
    summary: 'describe_schema + read-only query (Postgres or SQLite) answered with summaries',
  },
  logs: {
    files: { 'server.mjs': logsServer, 'tools.mjs': logsTools },
    deps: {},
    summary: 'search_logs (filtered, paginated) + get_errors (grouped by message)',
  },
} as const satisfies Record<
  string,
  { files: Record<string, string>; deps: Record<string, string>; summary: string }
>;

export type McpTemplate = keyof typeof TEMPLATES;
export const MCP_TEMPLATES = Object.keys(TEMPLATES) as McpTemplate[];
export const isMcpTemplate = (v: string): v is McpTemplate => v in TEMPLATES;
export const mcpTemplateSummary = (t: McpTemplate) => TEMPLATES[t].summary;
const VERSION = 2;

export const validMcpName = (name: string) => /^[a-z][a-z0-9-]{0,62}$/.test(name);

/**
 * The *whole* desired .mcp.json (existing servers + this one): the writer treats each plan as
 * the full file, so a fragment would drop the other servers.
 */
export async function mcpRegistryPlan(
  ctx: ProjectContext,
  name: string,
  entry: Json,
  templateId = 'mcp/registry',
): Promise<FilePlan> {
  const existingText = await readText(join(ctx.root, MCP_JSON));
  let existing: Json = {};
  if (existingText !== null) {
    try {
      existing = JSON.parse(existingText) as Json;
    } catch {
      throw new Error(`${MCP_JSON} is not valid JSON; fix it before adding a server.`);
    }
  }
  return {
    path: MCP_JSON,
    content:
      JSON.stringify(deepMergeJson(existing, { mcpServers: { [name]: entry } }), null, 2) + '\n',
    strategy: 'json',
    templateId,
    templateVersion: VERSION,
  };
}

/** #15: scaffold a stdio MCP server from a template and register it in .mcp.json. */
export async function mcpPlans(
  ctx: ProjectContext,
  name: string,
  runtime: HookRuntime,
  template: McpTemplate = 'basic',
): Promise<FilePlan[]> {
  const dir = `mcp/${name}`;
  const t = TEMPLATES[template];
  const entry = { command: runtime, args: [`\${CLAUDE_PROJECT_DIR:-.}/${dir}/server.mjs`] };
  const pkg = {
    name: `mcp-${name}`,
    private: true,
    type: 'module',
    dependencies: { '@modelcontextprotocol/sdk': SDK_VERSION, zod: ZOD_VERSION, ...t.deps },
  };
  const files: FilePlan[] = Object.entries(t.files).map(([file, body]) => ({
    path: `${dir}/${file}`,
    content: render(body, { name, dir, npx: NPX }),
    strategy: 'replace',
    // the basic template keeps its original id so existing scaffolds stay recognised
    templateId:
      template === 'basic' ? 'mcp/server' : `mcp/${template}/${file.replace(/\.mjs$/, '')}`,
    templateVersion: VERSION,
  }));
  return [
    ...files,
    {
      path: `${dir}/package.json`,
      content: JSON.stringify(pkg, null, 2) + '\n',
      strategy: 'seed',
      templateId: 'mcp/package',
      templateVersion: VERSION,
    },
    await mcpRegistryPlan(ctx, name, entry),
  ];
}

export async function existingServer(ctx: ProjectContext, name: string): Promise<unknown> {
  const text = await readText(join(ctx.root, MCP_JSON));
  if (!text) return undefined;
  try {
    return (JSON.parse(text) as { mcpServers?: Record<string, unknown> }).mcpServers?.[name];
  } catch {
    return undefined;
  }
}
