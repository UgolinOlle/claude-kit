import type { ProjectContext } from "../core/context.ts";
import type { BuiltinStackId, StackId } from "../detect/stack.ts";

import { goPack } from "./go.ts";
import { nodePack } from "./node.ts";
import { pythonPack } from "./python.ts";
import { rustPack } from "./rust.ts";
import type { StackPack } from "./types.ts";

export const BUILTIN_PACKS: Record<BuiltinStackId, StackPack> = {
  node: nodePack,
  python: pythonPack,
  go: goPack,
  rust: rustPack,
};

/** The pack for a detected stack: built-ins plus the project's external packs. */
export function packFor(
  ctx: Pick<ProjectContext, "packs">,
  id: StackId,
): StackPack {
  const pack = ctx.packs.get(id);
  if (!pack) throw new Error(`No stack pack registered for "${id}"`);
  return pack;
}

export type { PackCommand, StackPack } from "./types.ts";
