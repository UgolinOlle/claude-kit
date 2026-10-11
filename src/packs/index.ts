import type { StackId } from "../detect/stack.ts";
import { goPack } from "./go.ts";
import { nodePack } from "./node.ts";
import { pythonPack } from "./python.ts";
import { rustPack } from "./rust.ts";
import type { StackPack } from "./types.ts";

export const PACKS: Record<StackId, StackPack> = {
  node: nodePack,
  python: pythonPack,
  go: goPack,
  rust: rustPack,
};

export function packFor(id: StackId): StackPack {
  return PACKS[id];
}

export type { PackCommand, StackPack } from "./types.ts";
