import type { FilePlan } from "../core/writer.ts";
import { DEFAULT_MODEL, MODELS_VERSION } from "../data/models.ts";
import { NPX } from "../data/package.ts";
import debuggerTemplate from "../templates/agents/debugger.md.tmpl" with { type: "text" };
import explorerTemplate from "../templates/agents/explorer.md.tmpl" with { type: "text" };
import reviewerTemplate from "../templates/agents/reviewer.md.tmpl" with { type: "text" };
import testWriterTemplate from "../templates/agents/test-writer.md.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";
import compressSkillTemplate from "../templates/skills/compress-doc.md.tmpl" with { type: "text" };
import fixSkillTemplate from "../templates/skills/fix.md.tmpl" with { type: "text" };
import budgetTemplate from "../templates/statusline/token-budget.cjs.tmpl" with { type: "text" };

import type { HookRuntime } from "./hooks.ts";
import { settingsPlan } from "./settings.ts";

/** #10: model tiering as a project default. The human cheatsheet lives in CLAUDE.md comments (free). */
export function modelPlans(): FilePlan[] {
  return [settingsPlan("models", MODELS_VERSION, { model: DEFAULT_MODEL })];
}

export const AGENTS: Record<string, string> = {
  explorer: explorerTemplate,
  debugger: debuggerTemplate,
  reviewer: reviewerTemplate,
  "test-writer": testWriterTemplate,
};

export const FIX_SKILL_PATH = ".claude/skills/fix/SKILL.md";

/**
 * #11: subagents (search, analysis, tests, review) plus the `/fix` skill that runs the article's
 * orchestrator loop (find → diagnose → implement → validate → retry) with them. Only names and
 * descriptions cost main-context tokens; bodies load when they run.
 */
export function agentPlans(
  opts: { search?: boolean; taskContext?: string } = {},
): FilePlan[] {
  const agents: FilePlan[] = Object.entries(AGENTS).map(([name, content]) => ({
    path: `.claude/agents/${name}.md`,
    content,
    strategy: "replace",
    templateId: `agents/${name}`,
    templateVersion: 1,
  }));
  const find = opts.search
    ? "Call `search_code` with the symptom (error text, names), then `related_files` on the top hit to see its callers and tests."
    : "Delegate to the `explorer` agent: which files and functions are involved, with `path:line` references.";
  const taskContext = opts.taskContext
    ? `\n\nFor a fix that spans several steps or sessions, keep \`${opts.taskContext}\` updated after each step.`
    : "";
  return [
    ...agents,
    {
      path: FIX_SKILL_PATH,
      content: render(fixSkillTemplate, { find, taskContext }),
      strategy: "replace",
      templateId: "skills/fix",
      templateVersion: 1,
    },
  ];
}

export const BUDGET_PATH = ".claude/statusline/token-budget.cjs";
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
      strategy: "replace",
      templateId: "statusline/token-budget",
      templateVersion: 2,
    },
    settingsPlan("budget", 1, {
      statusLine: {
        type: "command",
        command: `${runtime} "\${CLAUDE_PROJECT_DIR:-.}/${BUDGET_PATH}"`,
        padding: 0,
      },
    }),
  ];
}

export const COMPRESS_SKILL_PATH = ".claude/skills/compress-doc/SKILL.md";

/** #14: a skill for long documents. Only its description loads until Claude uses it. */
export function compressPlans(): FilePlan[] {
  return [
    {
      path: COMPRESS_SKILL_PATH,
      content: render(compressSkillTemplate, { npx: NPX }),
      strategy: "replace",
      templateId: "skills/compress-doc",
      templateVersion: 1,
    },
  ];
}
