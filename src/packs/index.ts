import type { ProjectContext } from '../core/context.ts';
import type { BuiltinStackId, StackId, StackInfo } from '../detect/stack.ts';

import { goPack } from './go.ts';
import { nodePack } from './node.ts';
import { pythonPack } from './python.ts';
import { rustPack } from './rust.ts';
import type { PackCommand, StackPack } from './types.ts';

export const BUILTIN_PACKS: Record<BuiltinStackId, StackPack> = {
  node: nodePack,
  python: pythonPack,
  go: goPack,
  rust: rustPack,
};

/** The pack for a detected stack: built-ins plus the project's external packs. */
export function packFor(ctx: Pick<ProjectContext, 'packs'>, id: StackId): StackPack {
  const pack = ctx.packs.get(id);
  if (!pack) throw new Error(`No stack pack registered for "${id}"`);
  return pack;
}

/** A stack's label, with its directory when it lives in a subdirectory. */
export function stackLabel(ctx: Pick<ProjectContext, 'packs'>, s: StackInfo): string {
  const label = packFor(ctx, s.id).label(s);
  return s.dir ? `${label} in \`${s.dir}/\`` : label;
}

/** A stack's commands, run from its directory when it lives in a subdirectory. */
export function stackCommands(ctx: ProjectContext, s: StackInfo): PackCommand[] {
  const cmds = packFor(ctx, s.id).commands(s, ctx);
  return s.dir ? cmds.map((c) => ({ ...c, cmd: `cd ${s.dir} && ${c.cmd}` })) : cmds;
}

export type { PackCommand, StackPack } from './types.ts';
