import type { FilePlan } from "../core/writer.ts";
import memoryTemplate from "../templates/context/conversation_memory.md.tmpl" with { type: "text" };
import taskTemplate from "../templates/context/task_context.md.tmpl" with { type: "text" };
import snapshotTemplate from "../templates/hooks/context-snapshot.cjs.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";
import type { HookRuntime } from "./hooks.ts";
import { settingsPlan } from "./settings.ts";

export const TASK_CONTEXT_PATH = ".claude/context/task_context.md";
export const MEMORY_PATH = ".claude/context/conversation_memory.md";
export const SNAPSHOT_DIR = ".claude/context/snapshots";
export const SNAPSHOT_HOOK_PATH = ".claude/hooks/context-snapshot.cjs";
const VERSION = 1;
const KEEP_SNAPSHOTS = 10;

/** #6: task_context.md (seeded) + PostCompact snapshot / SessionStart re-injection hook. */
export function snapshotPlans(runtime: HookRuntime): FilePlan[] {
  const hook = render(snapshotTemplate, {
    snapshotDir: SNAPSHOT_DIR,
    taskContext: TASK_CONTEXT_PATH,
    snapshotDirJson: JSON.stringify(SNAPSHOT_DIR),
    taskContextJson: JSON.stringify(TASK_CONTEXT_PATH),
    keep: String(KEEP_SNAPSHOTS),
  });
  const command = { type: "command", command: `${runtime} "\${CLAUDE_PROJECT_DIR}/${SNAPSHOT_HOOK_PATH}"` };
  return [
    { path: TASK_CONTEXT_PATH, content: taskTemplate, strategy: "seed", templateId: "context/task", templateVersion: VERSION },
    { path: SNAPSHOT_HOOK_PATH, content: hook, strategy: "replace", templateId: "hooks/context-snapshot", templateVersion: VERSION },
    settingsPlan("snapshots", VERSION, {
      hooks: {
        PostCompact: [{ hooks: [command] }],
        SessionStart: [{ matcher: "compact", hooks: [command] }],
      },
    }),
  ];
}

/** #16: team-shared conversation memory, read on demand (never @imported: it changes often). */
export function memoryPlans(): FilePlan[] {
  return [{ path: MEMORY_PATH, content: memoryTemplate, strategy: "seed", templateId: "context/memory", templateVersion: VERSION }];
}
