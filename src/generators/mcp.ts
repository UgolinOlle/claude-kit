import { join } from "node:path";
import type { ProjectContext } from "../core/context.ts";
import { deepMergeJson, type Json } from "../core/merge.ts";
import type { FilePlan } from "../core/writer.ts";
import serverTemplate from "../templates/mcp/server.mjs.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";
import { readText } from "../utils/fsSafe.ts";
import type { HookRuntime } from "./hooks.ts";

export const MCP_JSON = ".mcp.json";
export const SDK_VERSION = "^1.32.1";
export const ZOD_VERSION = "^4.0.0";
const VERSION = 1;

export const validMcpName = (name: string) => /^[a-z][a-z0-9-]{0,62}$/.test(name);

/**
 * #15: scaffold a stdio MCP server stub and register it in .mcp.json.
 * The .mcp.json plan carries the *whole* desired file (existing servers + this one), because
 * the writer treats each plan as the full file; a fragment would drop the other servers.
 */
export async function mcpPlans(ctx: ProjectContext, name: string, runtime: HookRuntime): Promise<FilePlan[]> {
  const dir = `mcp/${name}`;
  const existingText = await readText(join(ctx.root, MCP_JSON));
  let existing: Json = {};
  if (existingText !== null) {
    try {
      existing = JSON.parse(existingText) as Json;
    } catch {
      throw new Error(`${MCP_JSON} is not valid JSON; fix it before adding a server.`);
    }
  }
  const entry = { command: runtime, args: [`\${CLAUDE_PROJECT_DIR:-.}/${dir}/server.mjs`] };
  const desired = deepMergeJson(existing, { mcpServers: { [name]: entry } });

  const pkg = {
    name: `mcp-${name}`,
    private: true,
    type: "module",
    dependencies: { "@modelcontextprotocol/sdk": SDK_VERSION, zod: ZOD_VERSION },
  };
  return [
    { path: `${dir}/server.mjs`, content: render(serverTemplate, { name, dir }), strategy: "replace", templateId: "mcp/server", templateVersion: VERSION },
    { path: `${dir}/package.json`, content: JSON.stringify(pkg, null, 2) + "\n", strategy: "seed", templateId: "mcp/package", templateVersion: VERSION },
    { path: MCP_JSON, content: JSON.stringify(desired, null, 2) + "\n", strategy: "json", templateId: "mcp/registry", templateVersion: VERSION },
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
