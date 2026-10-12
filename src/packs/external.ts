/**
 * External stack packs, listed in .claude-kit/config.json:
 *   { "packs": ["claude-kit-pack-elixir", "./tools/my-pack.mjs"] }
 * A pack is an ES module whose default export is a StackPack plus a `detect(root)` function.
 * Loading one runs its code, so packs are only ever loaded from the project's own config.
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { StackInfo } from "../detect/stack.ts";

import type { StackPack } from "./types.ts";

import { BUILTIN_PACKS } from "./index.ts";

export interface ExternalPack extends StackPack {
  /** Return null when the stack isn't present. Missing fields get defaults. */
  detect(
    root: string,
  ): Promise<Partial<StackInfo> | null> | Partial<StackInfo> | null;
}

function resolveSpec(root: string, spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/")) return resolve(root, spec);
  return createRequire(join(root, "package.json")).resolve(spec);
}

function validate(spec: string, mod: unknown): ExternalPack {
  const pack = ((mod as { default?: unknown }).default ??
    (mod as { pack?: unknown }).pack) as Partial<ExternalPack> | undefined;
  const problems: string[] = [];
  if (!pack || typeof pack !== "object")
    throw new Error(`Pack "${spec}" has no default export.`);
  if (typeof pack.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(pack.id))
    problems.push("`id` must be a lowercase string");
  if (typeof pack.detect !== "function")
    problems.push("`detect(root)` is required");
  if (typeof pack.label !== "function")
    problems.push("`label(stack)` is required");
  if (typeof pack.commands !== "function")
    problems.push("`commands(stack, ctx)` is required");
  if (!Array.isArray(pack.ignore))
    problems.push("`ignore` must be an array of patterns");
  if (!Array.isArray(pack.protectedPaths))
    problems.push("`protectedPaths` must be an array of { pattern, reason }");
  if (problems.length)
    throw new Error(`Pack "${spec}" is invalid: ${problems.join("; ")}.`);
  if ((pack.id as string) in BUILTIN_PACKS)
    throw new Error(
      `Pack "${spec}" uses the built-in id "${pack.id}"; pick another id.`,
    );
  return pack as ExternalPack;
}

export async function loadExternalPacks(
  root: string,
  specs: readonly string[],
): Promise<ExternalPack[]> {
  const packs: ExternalPack[] = [];
  for (const spec of specs) {
    let path: string;
    try {
      path = resolveSpec(root, spec);
    } catch {
      throw new Error(
        `Can't find pack "${spec}". Install it in the project (e.g. npm i -D ${spec}) or use a ./relative path.`,
      );
    }
    const pack = validate(spec, await import(pathToFileURL(path).href));
    if (packs.some((p) => p.id === pack.id))
      throw new Error(`Two packs declare the id "${pack.id}".`);
    packs.push(pack);
  }
  return packs;
}

/** Turns a pack's partial detection result into a full StackInfo. */
export function detectorFor(pack: ExternalPack) {
  return async (root: string): Promise<StackInfo | null> => {
    const found = await pack.detect(root);
    if (!found) return null;
    return {
      confidence: 1,
      manager: pack.id,
      evidence: [],
      deps: [],
      devDeps: [],
      ...found,
      id: pack.id,
    };
  };
}
