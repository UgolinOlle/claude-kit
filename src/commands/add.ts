import { homedir } from 'node:os';
import { join } from 'node:path';

import type { GlobalOptions } from '../cli.ts';
import { buildContext } from '../core/context.ts';
import { loadManifest } from '../core/manifest.ts';
import { isFeature } from '../core/presets.ts';
import type { FilePlan } from '../core/writer.ts';
import { CLAUDEMD_PATH } from '../generators/claudemd.ts';
import {
  isRouterModel,
  ROUTER_MODELS,
  routerClaudeMdPlan,
  routerPlans,
} from '../generators/extras.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { collectPlans } from '../generators/index.ts';
import {
  existingServer,
  isMcpTemplate,
  MCP_TEMPLATES,
  mcpPlans,
  mcpTemplateSummary,
  validMcpName,
} from '../generators/mcp.ts';
import { isDir } from '../utils/fsSafe.ts';
import { c, log } from '../utils/logger.ts';

import { generateAndApply } from './apply.ts';
import { detectHookRuntime, isInteractive } from './init.ts';

const USAGE = `Usage: claude-kit add mcp <name> [--template ${MCP_TEMPLATES.join('|')}]   (name: lowercase letters, digits and dashes)
       claude-kit add model-router [--global] [--small-model <m>] [--big-model <m>] [--claude-md]`;

export interface AddOptions {
  hookRuntime?: HookRuntime;
  interactive?: boolean;
  /** Claude Code's user directory for --global (default: $CLAUDE_CONFIG_DIR or ~/.claude). */
  userDir?: string;
}

export async function runAdd(
  opts: GlobalOptions,
  args: string[],
  o: AddOptions = {},
): Promise<number> {
  const [kind, name] = args;
  if (kind === 'model-router') return addModelRouter(opts, o);
  if (kind !== 'mcp' || !name) {
    log.error(USAGE);
    return 2;
  }
  if (!validMcpName(name)) {
    log.error(`Invalid server name "${name}". ${USAGE}`);
    return 2;
  }
  const template = opts.template ?? 'basic';
  if (!isMcpTemplate(template)) {
    log.error(
      `Unknown template "${template}". Templates:\n${MCP_TEMPLATES.map((t) => `  ${t.padEnd(6)} ${mcpTemplateSummary(t)}`).join('\n')}`,
    );
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
    plans: await mcpPlans(ctx, name, runtime, template),
  });
  if (outcome.status === 'cancelled') return 1;
  if (outcome.status === 'applied') {
    log.info(
      `\nNext:\n  ${c.bold(`cd mcp/${name} && npm install`)}\n  ${template === 'basic' ? `Edit mcp/${name}/server.mjs` : `Adapt mcp/${name}/tools.mjs (logic) and server.mjs (tool definitions)`}, then restart Claude Code and approve the "${name}" server.${template === 'db' ? '\n  Set DATABASE_URL in .mcp.json → mcpServers.' + name + '.env (use a read-only database user).' : ''}`,
    );
  }
  return 0;
}

async function addModelRouter(opts: GlobalOptions, o: AddOptions): Promise<number> {
  const model = (flag: string, value: string) => {
    if (isRouterModel(value)) return value;
    log.error(`Invalid ${flag} "${value}". Models: ${ROUTER_MODELS.join(', ')}`);
    return undefined;
  };
  const small = model('--small-model', opts.smallModel ?? 'haiku');
  const big = model('--big-model', opts.bigModel ?? 'opus');
  if (!small || !big) return 2;

  // --global writes into Claude Code's user directory itself: agents/, skills/, CLAUDE.md.
  const userDir = o.userDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (opts.global && !(await isDir(userDir))) {
    log.error(`${userDir} not found. Start Claude Code once to create it, then re-run.`);
    return 1;
  }
  const ctx = await buildContext(opts.global ? userDir : opts.cwd);
  const manifest = await loadManifest(ctx.root);
  const runtime = o.hookRuntime ?? detectHookRuntime();
  const features = opts.global ? [] : (manifest.features ?? []).filter(isFeature);
  const plans: FilePlan[] = routerPlans({ small, big, prefix: opts.global ? '' : '.claude/' });

  if (opts.claudeMd) {
    // A CLAUDE.md that init manages gets the line from its own generator: two plans for one file
    // would overwrite each other's manifest entry, and an unedited file is replaced wholesale.
    const managed =
      manifest.files[CLAUDEMD_PATH]?.templateId === 'claudemd' && features.includes('claudemd');
    const claudeMd = managed
      ? (
          await collectPlans({ ctx, manifest, features, hookRuntime: runtime, modelRouter: true })
        ).find((p) => p.path === CLAUDEMD_PATH)
      : undefined;
    plans.push(claudeMd ?? routerClaudeMdPlan(CLAUDEMD_PATH));
  }

  const outcome = await generateAndApply({
    ctx,
    manifest,
    features,
    opts,
    interactive: o.interactive ?? isInteractive(opts),
    hookRuntime: runtime,
    plans,
  });
  if (outcome.status === 'cancelled') return 1;
  if (outcome.status === 'applied') {
    const where = opts.global ? `${userDir}/` : '';
    log.info(
      `\nNext:\n  Restart Claude Code (or run /agents) to load quick-fixer (${small}) and deep-worker (${big}).${opts.claudeMd ? '' : `\n  Coding requests are routed when Claude picks the model-router skill; add ${c.bold('--claude-md')} to ask for it in CLAUDE.md.`}\n  To remove: delete ${plans
        .filter((p) => p.path !== CLAUDEMD_PATH)
        .map((p) => where + p.path)
        .join(
          ', ',
        )}${opts.claudeMd ? ` and the model-router block in ${where}${CLAUDEMD_PATH}` : ''}.`,
    );
  }
  return 0;
}
