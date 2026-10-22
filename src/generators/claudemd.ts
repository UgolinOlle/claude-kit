import { basename } from 'node:path';

import type { ProjectContext } from '../core/context.ts';
import type { Feature } from '../core/presets.ts';
import type { FilePlan } from '../core/writer.ts';
import { MODEL_CHEATSHEET } from '../data/models.ts';
import { stackCommands, stackLabel } from '../packs/index.ts';
import { renderClaudeMd } from '../templates/claudemd.ts';

import { MAP_PATH } from './docs.ts';
import { AGENTS, ROUTER_CLAUDEMD_LINE } from './extras.ts';
import type { Guardrails } from './hooks.ts';
import { MEMORY_PATH, TASK_CONTEXT_PATH } from './snapshots.ts';

export const CLAUDEMD_PATH = 'CLAUDE.md';
const VERSION = 1;

export interface ClaudeMdOptions {
  /** The codebase map is only generated for large repos. */
  hasMap?: boolean;
  /** Resolved pre-edit guardrails, when the hooks feature is on. */
  guardrails?: Guardrails;
  /** Keep the model-router line (added by `add model-router --claude-md`). */
  modelRouter?: boolean;
}

export function claudeMdPlan(
  ctx: ProjectContext,
  features: readonly Feature[],
  opts: ClaudeMdOptions = {},
): FilePlan {
  const on = (f: Feature) => features.includes(f);
  const content = renderClaudeMd({
    name: ctx.primaryStack?.name ?? basename(ctx.root),
    stacks: ctx.stacks.map((s) => ({
      label: stackLabel(ctx, s),
      manager: s.manager,
      deps: s.deps,
    })),
    monorepo: ctx.monorepo.isMonorepo
      ? { tools: ctx.monorepo.tools, packages: ctx.monorepo.packages }
      : undefined,
    commands: ctx.stacks.flatMap((s) => stackCommands(ctx, s)),
    guardrails: {
      claudeignore: on('claudeignore'),
      hooks: on('hooks'),
      migrations: [...new Set(opts.guardrails?.migrations.map((m) => m.tool) ?? [])],
      content: opts.guardrails?.content.map((r) => r.id) ?? [],
    },
    extras: {
      taskContext: on('snapshots') ? TASK_CONTEXT_PATH : undefined,
      memory: on('memory') ? MEMORY_PATH : undefined,
      docs: on('docs'),
      map: on('rag') && opts.hasMap ? MAP_PATH : undefined,
      agents: on('agents') ? Object.keys(AGENTS) : undefined,
      compress: on('compress'),
      search: on('search'),
      modelCheatsheet: on('models') ? MODEL_CHEATSHEET : undefined,
      modelRouter: opts.modelRouter ? ROUTER_CLAUDEMD_LINE : undefined,
    },
  });
  return {
    path: CLAUDEMD_PATH,
    content,
    strategy: 'regions',
    templateId: 'claudemd',
    templateVersion: VERSION,
  };
}
