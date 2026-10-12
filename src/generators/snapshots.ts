import type { FilePlan } from "../core/writer.ts";
import memoryTemplate from "../templates/context/conversation_memory.md.tmpl" with { type: "text" };
import taskTemplate from "../templates/context/task_context.md.tmpl" with { type: "text" };
import guardTemplate from "../templates/hooks/context-guard.cjs.tmpl" with { type: "text" };
import snapshotTemplate from "../templates/hooks/context-snapshot.cjs.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";

import type { HookRuntime } from "./hooks.ts";
import { settingsPlan } from "./settings.ts";

export const TASK_CONTEXT_PATH = ".claude/context/task_context.md";
export const MEMORY_PATH = ".claude/context/conversation_memory.md";
export const SNAPSHOT_DIR = ".claude/context/snapshots";
export const SNAPSHOT_HOOK_PATH = ".claude/hooks/context-snapshot.cjs";
export const GUARD_HOOK_PATH = ".claude/hooks/context-guard.cjs";
/** Context-window % at which the guard asks for a task_context.md update, then for /compact. */
export const GUARD_WARN = 60;
export const GUARD_CRIT = 80;
/** Prompts between team-memory reminders (the article's SUMMARY_INTERVAL). */
export const MEMORY_INTERVAL = 10;
const VERSION = 1;
const KEEP_SNAPSHOTS = 10;

/**
 * #6 + #16: task_context.md (seeded), a PostCompact snapshot / SessionStart re-injection hook,
 * and a UserPromptSubmit guard that asks for a task_context.md update before compaction hits
 * (and, with the memory feature, for a conversation_memory.md entry every few prompts).
 */
export function snapshotPlans(
  runtime: HookRuntime,
  opts: { memory?: boolean } = {},
): FilePlan[] {
  const hook = render(snapshotTemplate, {
    snapshotDir: SNAPSHOT_DIR,
    taskContext: TASK_CONTEXT_PATH,
    snapshotDirJson: JSON.stringify(SNAPSHOT_DIR),
    taskContextJson: JSON.stringify(TASK_CONTEXT_PATH),
    keep: String(KEEP_SNAPSHOTS),
  });
  const guard = render(guardTemplate, {
    warn: String(GUARD_WARN),
    crit: String(GUARD_CRIT),
    taskContext: TASK_CONTEXT_PATH,
    taskContextJson: JSON.stringify(TASK_CONTEXT_PATH),
    memoryJson: JSON.stringify(opts.memory ? MEMORY_PATH : null),
    interval: String(MEMORY_INTERVAL),
  });
  const command = {
    type: "command",
    command: `${runtime} "\${CLAUDE_PROJECT_DIR}/${SNAPSHOT_HOOK_PATH}"`,
  };
  const guardCommand = {
    type: "command",
    command: `${runtime} "\${CLAUDE_PROJECT_DIR}/${GUARD_HOOK_PATH}"`,
  };
  return [
    {
      path: TASK_CONTEXT_PATH,
      content: taskTemplate,
      strategy: "seed",
      templateId: "context/task",
      templateVersion: VERSION,
    },
    {
      path: SNAPSHOT_HOOK_PATH,
      content: hook,
      strategy: "replace",
      templateId: "hooks/context-snapshot",
      templateVersion: VERSION,
    },
    {
      path: GUARD_HOOK_PATH,
      content: guard,
      strategy: "replace",
      templateId: "hooks/context-guard",
      templateVersion: VERSION,
    },
    settingsPlan("snapshots", 2, {
      hooks: {
        PostCompact: [{ hooks: [command] }],
        SessionStart: [{ matcher: "compact", hooks: [command] }],
        UserPromptSubmit: [{ hooks: [guardCommand] }],
      },
    }),
  ];
}

/** #16: team-shared conversation memory, read on demand (never @imported: it changes often). */
export function memoryPlans(): FilePlan[] {
  return [
    {
      path: MEMORY_PATH,
      content: memoryTemplate,
      strategy: "seed",
      templateId: "context/memory",
      templateVersion: VERSION,
    },
  ];
}
