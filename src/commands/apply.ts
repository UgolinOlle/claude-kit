import * as p from '@clack/prompts';

import type { GlobalOptions } from '../cli.ts';
import type { ProjectContext } from '../core/context.ts';
import { saveManifest, type Manifest } from '../core/manifest.ts';
import type { Feature } from '../core/presets.ts';
import {
  applyChanges,
  type ApplyResult,
  type FilePlan,
  type Change,
  keepAll,
  overwriteAll,
  planChanges,
  type Resolver,
} from '../core/writer.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { collectPlans, IMPLEMENTED } from '../generators/index.ts';
import { interactiveResolver } from '../prompts/conflict.ts';
import { confirmApply } from '../prompts/questionnaire.ts';
import { formatDiff } from '../utils/diff.ts';
import { c, log } from '../utils/logger.ts';

const SYMBOL: Record<Change['action'], string> = {
  create: c.green('+ create   '),
  update: c.blue('~ update   '),
  merge: c.cyan('⇄ merge    '),
  unchanged: c.dim('= unchanged'),
  conflict: c.yellow('! conflict '),
};

export interface GenerateArgs {
  ctx: ProjectContext;
  manifest: Manifest;
  features: Feature[];
  preset?: string;
  opts: GlobalOptions;
  interactive: boolean;
  hookRuntime: HookRuntime;
  /** Apply these instead of generating from `features` (e.g. `add mcp`). */
  plans?: FilePlan[];
}

export interface GenerateOutcome {
  /** "cancelled" when the user declined at the confirm prompt. */
  status: 'dry-run' | 'up-to-date' | 'applied' | 'cancelled';
  active: Feature[];
  changes: Change[];
  result: ApplyResult | null;
}

export function summarize(changes: Change[]) {
  return changes.map((ch) => ({ path: ch.plan.path, action: ch.action, reason: ch.reason }));
}

/** Shared by init, sync and doctor --fix: generate → show → confirm → apply → save manifest. */
export async function generateAndApply(args: GenerateArgs): Promise<GenerateOutcome> {
  const { ctx, manifest, features, opts, interactive } = args;

  const pending = features.filter((f) => !IMPLEMENTED.has(f));
  if (pending.length) log.warn(`Not available yet, skipped: ${pending.join(', ')}`);
  const active = features.filter((f) => IMPLEMENTED.has(f));

  const plans =
    args.plans ??
    (await collectPlans({ ctx, manifest, features: active, hookRuntime: args.hookRuntime }));
  const changes = await planChanges(ctx.root, plans, manifest);
  const writes = changes.filter((ch) => ch.action !== 'unchanged');

  for (const ch of changes) log.info(`${SYMBOL[ch.action]}  ${ch.plan.path}  ${c.dim(ch.reason)}`);
  if (opts.dryRun || opts.verbose) {
    for (const ch of changes.filter(
      (x) => x.action === 'update' || x.action === 'merge' || x.action === 'conflict',
    )) {
      log.info(`\n${c.bold(ch.plan.path)}\n${formatDiff(ch.before ?? '', ch.after)}`);
    }
  }

  const record = async () => {
    if (args.preset) manifest.preset = args.preset;
    if (!args.plans) manifest.features = features;
    await saveManifest(ctx.root, manifest);
  };

  if (opts.dryRun) return { status: 'dry-run', active, changes, result: null };
  if (writes.length === 0) {
    await record();
    return { status: 'up-to-date', active, changes, result: null };
  }
  if (interactive && !(await confirmApply(writes.length))) {
    p.cancel('Nothing written.');
    return { status: 'cancelled', active, changes, result: null };
  }

  const resolver: Resolver = opts.force
    ? overwriteAll
    : interactive
      ? interactiveResolver
      : keepAll;
  const result = await applyChanges(ctx.root, changes, manifest, resolver);
  await record();

  log.success(`Wrote ${result.written.length} file${result.written.length === 1 ? '' : 's'}.`);
  if (result.kept.length)
    log.warn(`Kept your version of: ${result.kept.join(', ')} (re-run with --force to overwrite)`);
  if (result.sidecars.length) log.info(`Review and merge: ${result.sidecars.join(', ')}`);
  return { status: 'applied', active, changes, result };
}
