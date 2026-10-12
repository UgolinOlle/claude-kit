import type { ContentRule } from "../core/config.ts";
import type { ProjectContext } from "../core/context.ts";
import type { FilePlan } from "../core/writer.ts";
import { detectMigrations, type MigrationRule } from "../detect/migrations.ts";
import {
  COMMON_PROTECTED,
  COMMON_PROTECTED_EXCEPTIONS,
} from "../packs/common.ts";
import { packFor } from "../packs/index.ts";
import preEditTemplate from "../templates/hooks/pre-edit.cjs.tmpl" with { type: "text" };
import { render } from "../templates/render.ts";

import { settingsPlan } from "./settings.ts";

export const PRE_EDIT_PATH = ".claude/hooks/pre-edit.cjs";
const VERSION = 2;

export type HookRuntime = "node" | "bun";

export interface PathRule {
  pattern: string;
  reason: string;
  /** Block only files already tracked by git (migrations). */
  committedOnly?: boolean;
}

/** Everything the pre-edit hook enforces, resolved from packs, the repo and the config. */
export interface Guardrails {
  paths: PathRule[];
  migrations: MigrationRule[];
  content: ContentRule[];
}

export async function guardrails(ctx: ProjectContext): Promise<Guardrails> {
  const seen = new Set<string>();
  const paths: PathRule[] = [
    ...ctx.stacks.flatMap((s) => packFor(ctx, s.id).protectedPaths),
    ...COMMON_PROTECTED,
  ].filter((r) => !seen.has(r.pattern) && seen.add(r.pattern));
  const migrations = ctx.config.guardrails.migrations
    ? (await detectMigrations(ctx.root, ctx.stacks)).filter(
        (m) => !seen.has(m.pattern),
      )
    : [];
  return { paths, migrations, content: ctx.config.guardrails.content };
}

export function hooksPlans(g: Guardrails, runtime: HookRuntime): FilePlan[] {
  const rules: PathRule[] = [
    ...g.paths,
    ...g.migrations.map(({ pattern, reason }) => ({
      pattern,
      reason,
      committedOnly: true,
    })),
  ];
  const script = render(preEditTemplate, {
    rules: JSON.stringify(rules, null, 2),
    exceptions: JSON.stringify(COMMON_PROTECTED_EXCEPTIONS),
    contentRules: JSON.stringify(g.content, null, 2),
  });
  return [
    {
      path: PRE_EDIT_PATH,
      content: script,
      strategy: "replace",
      templateId: "hooks/pre-edit",
      templateVersion: VERSION,
    },
    settingsPlan("hooks", VERSION, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write|MultiEdit|NotebookEdit",
            hooks: [
              {
                type: "command",
                command: `${runtime} "\${CLAUDE_PROJECT_DIR}/${PRE_EDIT_PATH}"`,
              },
            ],
          },
        ],
      },
    }),
  ];
}
