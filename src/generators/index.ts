import { join } from 'node:path';

import type { ProjectContext } from '../core/context.ts';
import type { Manifest } from '../core/manifest.ts';
import { extractRegions } from '../core/merge.ts';
import type { Feature } from '../core/presets.ts';
import { planChanges, type FilePlan } from '../core/writer.ts';
import { readText } from '../utils/fsSafe.ts';

import { claudeignorePlan, denyRulesPlan } from './claudeignore.ts';
import { CLAUDEMD_PATH, claudeMdPlan } from './claudemd.ts';
import { docsPlans, mapPlans } from './docs.ts';
import { agentPlans, budgetPlans, compressPlans, modelPlans, ROUTER_REGION } from './extras.ts';
import { guardrails, hooksPlans, type HookRuntime } from './hooks.ts';
import { searchPlans } from './search.ts';
import { combineSettings } from './settings.ts';
import { memoryPlans, snapshotPlans, TASK_CONTEXT_PATH } from './snapshots.ts';

/** Every feature has a generator now. */
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
  'search',
]);

export interface GenerateInput {
  ctx: ProjectContext;
  manifest: Manifest;
  features: readonly Feature[];
  hookRuntime: HookRuntime;
  /** Include the model-router line in CLAUDE.md; default: keep it if the file has it. */
  modelRouter?: boolean;
}

/**
 * `add model-router` isn't a feature, so the CLAUDE.md it extended is the only record of it.
 * Regenerating an unedited CLAUDE.md replaces it wholesale, which would drop the line otherwise.
 */
async function hasRouterLine(root: string): Promise<boolean> {
  const text = await readText(join(root, CLAUDEMD_PATH));
  return text !== null && extractRegions(text).has(ROUTER_REGION);
}

export async function collectPlans({
  ctx,
  manifest,
  features,
  hookRuntime,
  modelRouter,
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
  const guards = on('hooks') ? await guardrails(ctx) : undefined;
  if (on('claudemd'))
    plans.push(
      claudeMdPlan(ctx, features, {
        hasMap: map.length > 0,
        guardrails: guards,
        modelRouter: modelRouter ?? (await hasRouterLine(ctx.root)),
      }),
    );
  if (guards) plans.push(...hooksPlans(guards, hookRuntime));
  if (on('snapshots')) plans.push(...snapshotPlans(hookRuntime, { memory: on('memory') }));
  if (on('memory')) plans.push(...memoryPlans());
  if (on('docs')) plans.push(...(await docsPlans(ctx)));
  if (on('models')) plans.push(...modelPlans());
  if (on('agents'))
    plans.push(
      ...agentPlans({
        search: on('search'),
        taskContext: on('snapshots') ? TASK_CONTEXT_PATH : undefined,
      }),
    );
  if (on('budget')) plans.push(...budgetPlans(hookRuntime));
  if (on('compress')) plans.push(...compressPlans());
  if (on('search')) plans.push(...(await searchPlans(ctx, hookRuntime)));
  plans.push(...map);

  return combineSettings(plans);
}
