import type { ProjectContext } from "../core/context.ts";
import { buildIgnoreFile, ignoreToDenyRules } from "../core/ignore.ts";
import type { FilePlan } from "../core/writer.ts";
import { COMMON_IGNORE } from "../packs/common.ts";
import { packFor } from "../packs/index.ts";
import { settingsPlan } from "./settings.ts";

export const CLAUDEIGNORE_PATH = ".claudeignore";
const VERSION = 1;

const HEADER = `# .claudeignore: paths Claude Code should not read (saves context, keeps secrets out).
# Claude Code doesn't read this file directly: claude-kit compiles it into
# permissions.deny Read(...) rules in .claude/settings.json. After editing, run: claude-kit sync
# Syntax: gitignore. Remove a line to let Claude read that path again.`;

export function claudeignorePlan(ctx: ProjectContext): FilePlan {
  const sections = [
    ...ctx.stacks.map((s) => ({ title: packFor(ctx, s.id).label(s), patterns: packFor(ctx, s.id).ignore })),
    { title: "secrets & editor noise", patterns: COMMON_IGNORE },
    { title: "from .gitignore", patterns: ctx.gitignore },
  ];
  return {
    path: CLAUDEIGNORE_PATH,
    content: buildIgnoreFile(HEADER, sections),
    strategy: "lines",
    templateId: "claudeignore",
    templateVersion: VERSION,
  };
}

/** Deny rules come from the *effective* ignore file (after merging user edits), not the template. */
export function denyRulesPlan(effectiveIgnore: string): FilePlan {
  return settingsPlan("claudeignore", VERSION, { permissions: { deny: ignoreToDenyRules(effectiveIgnore.split("\n")) } });
}
