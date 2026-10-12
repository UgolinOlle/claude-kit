import type { ProjectContext } from '../core/context.ts';
import type { StackId, StackInfo } from '../detect/stack.ts';

export interface PackCommand {
  /** What it does: "install", "test", "lint"… */
  label: string;
  cmd: string;
}

/**
 * A stack plugin. Packs only describe a stack; generators decide where the data goes.
 * External packs (claude-kit-pack-*) will implement this same interface.
 */
export interface StackPack {
  id: StackId;
  /** Human label, e.g. "TypeScript / Node.js". */
  label(stack: StackInfo): string;
  /** gitignore-style patterns Claude shouldn't read (build output, caches, lockfiles). */
  ignore: string[];
  /** gitignore-style patterns Claude must not edit (lockfiles, generated code). */
  protectedPaths: { pattern: string; reason: string }[];
  /** Commands worth listing in CLAUDE.md, in display order. */
  commands(stack: StackInfo, ctx: ProjectContext): PackCommand[];
}
