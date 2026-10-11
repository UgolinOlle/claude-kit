import type { ProjectContext } from "../core/context.ts";
import type { FilePlan } from "../core/writer.ts";
import { COMMON_PROTECTED, COMMON_PROTECTED_EXCEPTIONS } from "../packs/common.ts";
import { packFor } from "../packs/index.ts";
import preEditTemplate from "../templates/hooks/pre-edit.cjs.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";
import { settingsPlan } from "./settings.ts";

export const PRE_EDIT_PATH = ".claude/hooks/pre-edit.cjs";
const VERSION = 1;

export type HookRuntime = "node" | "bun";

export function protectedRules(ctx: ProjectContext): { pattern: string; reason: string }[] {
  const seen = new Set<string>();
  return [...ctx.stacks.flatMap((s) => packFor(ctx, s.id).protectedPaths), ...COMMON_PROTECTED].filter(
    (r) => !seen.has(r.pattern) && seen.add(r.pattern),
  );
}

export function hooksPlans(ctx: ProjectContext, runtime: HookRuntime): FilePlan[] {
  const script = render(preEditTemplate, {
    rules: JSON.stringify(protectedRules(ctx), null, 2),
    exceptions: JSON.stringify(COMMON_PROTECTED_EXCEPTIONS),
  });
  return [
    { path: PRE_EDIT_PATH, content: script, strategy: "replace", templateId: "hooks/pre-edit", templateVersion: VERSION },
    settingsPlan("hooks", VERSION, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [{ type: "command", command: `${runtime} "\${CLAUDE_PROJECT_DIR}/${PRE_EDIT_PATH}"` }],
          },
        ],
      },
    }),
  ];
}
