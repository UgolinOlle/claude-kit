import type { ProjectContext } from '../core/context.ts';
import type { FilePlan } from '../core/writer.ts';
import { PACKAGE_NAME, VERSION } from '../data/package.ts';

import type { HookRuntime } from './hooks.ts';
import { mcpRegistryPlan } from './mcp.ts';
import { settingsPlan } from './settings.ts';

export const SEARCH_SERVER = 'code-search';

/**
 * #7: the `code-search` MCP server. It ships inside claude-kit (`claude-kit serve search`), so
 * there's no generated code to maintain: .mcp.json pins this version and `upgrade` moves the pin.
 * `enabledMcpjsonServers` pre-approves it, so the team isn't prompted on first use.
 */
export async function searchPlans(ctx: ProjectContext, runtime: HookRuntime): Promise<FilePlan[]> {
  const pkg = `${PACKAGE_NAME}@${VERSION}`;
  const entry =
    runtime === 'bun'
      ? { command: 'bunx', args: [pkg, 'serve', 'search'] }
      : { command: 'npx', args: ['-y', pkg, 'serve', 'search'] };
  return [
    await mcpRegistryPlan(ctx, SEARCH_SERVER, entry, 'search/registry'),
    settingsPlan('search', 1, { enabledMcpjsonServers: [SEARCH_SERVER] }),
  ];
}
