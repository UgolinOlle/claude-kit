import { region } from '../core/merge.ts';
import type { FilePlan } from '../core/writer.ts';
import { DEFAULT_MODEL, MODELS_VERSION } from '../data/models.ts';
import { NPX } from '../data/package.ts';
import debuggerTemplate from '../templates/agents/debugger.md.tmpl' with { type: 'text' };
import deepWorkerTemplate from '../templates/agents/deep-worker.md.tmpl' with { type: 'text' };
import explorerTemplate from '../templates/agents/explorer.md.tmpl' with { type: 'text' };
import quickFixerTemplate from '../templates/agents/quick-fixer.md.tmpl' with { type: 'text' };
import reviewerTemplate from '../templates/agents/reviewer.md.tmpl' with { type: 'text' };
import testWriterTemplate from '../templates/agents/test-writer.md.tmpl' with { type: 'text' };
import { render } from '../templates/render.ts';
import compressSkillTemplate from '../templates/skills/compress-doc.md.tmpl' with { type: 'text' };
import fixSkillTemplate from '../templates/skills/fix.md.tmpl' with { type: 'text' };
import routerSkillTemplate from '../templates/skills/model-router.md.tmpl' with { type: 'text' };
import budgetTemplate from '../templates/statusline/token-budget.cjs.tmpl' with { type: 'text' };

import type { HookRuntime } from './hooks.ts';
import { settingsPlan } from './settings.ts';

/** #10: model tiering as a project default. The human cheatsheet lives in CLAUDE.md comments (free). */
export function modelPlans(): FilePlan[] {
  return [settingsPlan('models', MODELS_VERSION, { model: DEFAULT_MODEL })];
}

export const AGENTS: Record<string, string> = {
  explorer: explorerTemplate,
  debugger: debuggerTemplate,
  reviewer: reviewerTemplate,
  'test-writer': testWriterTemplate,
};

export const FIX_SKILL_PATH = '.claude/skills/fix/SKILL.md';

/**
 * #11: subagents (search, analysis, tests, review) plus the `/fix` skill that runs the article's
 * orchestrator loop (find → diagnose → implement → validate → retry) with them. Only names and
 * descriptions cost main-context tokens; bodies load when they run.
 */
export function agentPlans(opts: { search?: boolean; taskContext?: string } = {}): FilePlan[] {
  const agents: FilePlan[] = Object.entries(AGENTS).map(([name, content]) => ({
    path: `.claude/agents/${name}.md`,
    content,
    strategy: 'replace',
    templateId: `agents/${name}`,
    templateVersion: 1,
  }));
  const find = opts.search
    ? 'Call `search_code` with the symptom (error text, names), then `related_files` on the top hit to see its callers and tests.'
    : 'Delegate to the `explorer` agent: which files and functions are involved, with `path:line` references.';
  const taskContext = opts.taskContext
    ? `\n\nFor a fix that spans several steps or sessions, keep \`${opts.taskContext}\` updated after each step.`
    : '';
  return [
    ...agents,
    {
      path: FIX_SKILL_PATH,
      content: render(fixSkillTemplate, { find, taskContext }),
      strategy: 'replace',
      templateId: 'skills/fix',
      templateVersion: 1,
    },
  ];
}

export const BUDGET_PATH = '.claude/statusline/token-budget.cjs';
export const BUDGET_WARN = 60;
export const BUDGET_CRIT = 80;

/** #12: token budget as a live status line (context %, cache health, spend). */
export function budgetPlans(runtime: HookRuntime): FilePlan[] {
  const script = render(budgetTemplate, {
    warn: String(BUDGET_WARN),
    crit: String(BUDGET_CRIT),
  });
  return [
    {
      path: BUDGET_PATH,
      content: script,
      strategy: 'replace',
      templateId: 'statusline/token-budget',
      templateVersion: 2,
    },
    settingsPlan('budget', 1, {
      statusLine: {
        type: 'command',
        command: `${runtime} "\${CLAUDE_PROJECT_DIR:-.}/${BUDGET_PATH}"`,
        padding: 0,
      },
    }),
  ];
}

export const COMPRESS_SKILL_PATH = '.claude/skills/compress-doc/SKILL.md';

/** #14: a skill for long documents. Only its description loads until Claude uses it. */
export function compressPlans(): FilePlan[] {
  return [
    {
      path: COMPRESS_SKILL_PATH,
      content: render(compressSkillTemplate, { npx: NPX }),
      strategy: 'replace',
      templateId: 'skills/compress-doc',
      templateVersion: 1,
    },
  ];
}

/** Subagent `model` values Claude Code accepts as aliases. */
export const ROUTER_MODELS = ['haiku', 'sonnet', 'opus', 'inherit'] as const;
export type RouterModel = (typeof ROUTER_MODELS)[number];
export const isRouterModel = (v: string): v is RouterModel =>
  (ROUTER_MODELS as readonly string[]).includes(v);

export const ROUTER_REGION = 'model-router';
export const ROUTER_CLAUDEMD_LINE = 'For coding tasks, use the model-router skill before starting.';

export interface RouterOptions {
  small?: RouterModel;
  big?: RouterModel;
  /** Where `agents/` and `skills/` live: `.claude/` in a project, empty for ~/.claude. */
  prefix?: string;
}

/**
 * `add model-router`: a skill that sorts each coding request into small or complex and hands it
 * to a subagent pinned to a cheap or a strong model. Same mechanism as the `agents` feature.
 */
export function routerPlans({
  small = 'haiku',
  big = 'opus',
  prefix = '.claude/',
}: RouterOptions = {}): FilePlan[] {
  const agent = (name: string, template: string, model: RouterModel): FilePlan => ({
    path: `${prefix}agents/${name}.md`,
    content: render(template, { model }),
    strategy: 'replace',
    templateId: `agents/${name}`,
    templateVersion: 1,
  });
  return [
    agent('quick-fixer', quickFixerTemplate, small),
    agent('deep-worker', deepWorkerTemplate, big),
    {
      path: `${prefix}skills/model-router/SKILL.md`,
      content: routerSkillTemplate,
      strategy: 'replace',
      templateId: 'skills/model-router',
      templateVersion: 1,
    },
  ];
}

/**
 * The CLAUDE.md line on its own, for a CLAUDE.md that `init` doesn't manage. The regions merge
 * leaves the rest of the file alone and never adds the region twice.
 */
export function routerClaudeMdPlan(path = 'CLAUDE.md'): FilePlan {
  return {
    path,
    content: region(ROUTER_REGION, ROUTER_CLAUDEMD_LINE) + '\n',
    strategy: 'regions',
    templateId: 'claudemd/model-router',
    templateVersion: 1,
  };
}
