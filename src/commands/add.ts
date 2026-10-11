import type { GlobalOptions } from '../cli.ts';
import { buildContext } from '../core/context.ts';
import { loadManifest } from '../core/manifest.ts';
import { isFeature } from '../core/presets.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { existingServer, mcpPlans, validMcpName } from '../generators/mcp.ts';
import { c, log } from '../utils/logger.ts';

import { generateAndApply } from './apply.ts';
import { detectHookRuntime, isInteractive } from './init.ts';

const USAGE = 'Usage: claude-kit add mcp <name>   (lowercase letters, digits and dashes)';

export async function runAdd(
  opts: GlobalOptions,
  args: string[],
  o: { hookRuntime?: HookRuntime; interactive?: boolean } = {},
): Promise<number> {
  const [kind, name] = args;
  if (kind !== 'mcp' || !name) {
    log.error(USAGE);
    return 2;
  }
  if (!validMcpName(name)) {
    log.error(`Invalid server name "${name}". ${USAGE}`);
    return 2;
  }
  const ctx = await buildContext(opts.cwd);
  if ((await existingServer(ctx, name)) !== undefined && !opts.force) {
    log.error(
      `.mcp.json already defines a server named "${name}". Pick another name or pass --force.`,
    );
    return 1;
  }
  const manifest = await loadManifest(ctx.root);
  const runtime = o.hookRuntime ?? detectHookRuntime();
  const outcome = await generateAndApply({
    ctx,
    manifest,
    features: (manifest.features ?? []).filter(isFeature),
    opts,
    interactive: o.interactive ?? isInteractive(opts),
    hookRuntime: runtime,
    plans: await mcpPlans(ctx, name, runtime),
  });
  if (outcome.status === 'cancelled') return 1;
  if (outcome.status === 'applied') {
    log.info(
      `\nNext:\n  ${c.bold(`cd mcp/${name} && npm install`)}\n  Edit mcp/${name}/server.mjs, then restart Claude Code and approve the "${name}" server.`,
    );
  }
  return 0;
}
