import type { ProjectContext } from '../core/context.ts';
import type { Manifest } from '../core/manifest.ts';
import type { Feature } from '../core/presets.ts';
import { planChanges, type FilePlan } from '../core/writer.ts';

import { claudeignorePlan, denyRulesPlan } from './claudeignore.ts';
import { claudeMdPlan } from './claudemd.ts';
import { docsPlans, mapPlans } from './docs.ts';
import { agentPlans, budgetPlans, modelPlans } from './extras.ts';
import { hooksPlans, type HookRuntime } from './hooks.ts';
import { combineSettings } from './settings.ts';
import { memoryPlans, snapshotPlans } from './snapshots.ts';

/** Every feature has a generator now; `compress` only adds a CLAUDE.md pointer to the CLI command. */
export const IMPLEMENTED: ReadonlySet<Feature> = new Set([
  'claudeignore',
  'claudemd',
  'hooks',
  'snapshots',
  'memory',
  'docs',
  'models',
  'agents',
  'budget',
  'compress',
  'rag',
]);

export interface GenerateInput {
  ctx: ProjectContext;
  manifest: Manifest;
  features: readonly Feature[];
  hookRuntime: HookRuntime;
}

export async function collectPlans({
  ctx,
  manifest,
  features,
  hookRuntime,
}: GenerateInput): Promise<FilePlan[]> {
  const on = (f: Feature) => features.includes(f);
  const plans: FilePlan[] = [];

  if (on('claudeignore')) {
    const ignore = claudeignorePlan(ctx);
    // Deny rules must reflect the user's edits to .claudeignore, so compile from the merged result.
    const [change] = await planChanges(ctx.root, [ignore], manifest);
    const effective =
      change!.action === 'conflict' ? (change!.before ?? ignore.content) : change!.after;
    plans.push(ignore, denyRulesPlan(effective));
  }
  const map = on('rag') ? await mapPlans(ctx) : [];
  if (on('claudemd')) plans.push(claudeMdPlan(ctx, features, { hasMap: map.length > 0 }));
  if (on('hooks')) plans.push(...hooksPlans(ctx, hookRuntime));
  if (on('snapshots')) plans.push(...snapshotPlans(hookRuntime));
  if (on('memory')) plans.push(...memoryPlans());
  if (on('docs')) plans.push(...(await docsPlans(ctx)));
  if (on('models')) plans.push(...modelPlans());
  if (on('agents')) plans.push(...agentPlans());
  if (on('budget')) plans.push(...budgetPlans(hookRuntime));
  plans.push(...map);

  return combineSettings(plans);
}
