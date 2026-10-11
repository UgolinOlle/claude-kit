import { join, resolve } from "node:path";
import { detectMonorepo, type MonorepoInfo } from "../detect/monorepo.ts";
import { measureSize, type SizeInfo } from "../detect/size.ts";
import { detectStacks, type StackInfo } from "../detect/stack.ts";
import { exists, isDir, readText } from "../utils/fsSafe.ts";

export interface ExistingSetup {
  claudeMd: boolean;
  claudeignore: boolean;
  settings: boolean;
  mcpJson: boolean;
  docsDir: boolean;
}

export interface ProjectContext {
  root: string;
  isGitRepo: boolean;
  stacks: StackInfo[];
  /** Highest-confidence stack, if any. */
  primaryStack: StackInfo | undefined;
  monorepo: MonorepoInfo;
  /** Non-empty, non-comment lines of the root .gitignore. */
  gitignore: string[];
  existing: ExistingSetup;
  /** Repo size scan — the only slow part, so it's computed on first call and cached. */
  size(): Promise<SizeInfo>;
}

export function parseIgnoreFile(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export async function buildContext(rootArg: string): Promise<ProjectContext> {
  const root = resolve(rootArg);
  if (!(await isDir(root))) throw new Error(`Not a directory: ${root}`);

  const [stacks, monorepo, gitignoreText, isGitRepo, existing] = await Promise.all([
    detectStacks(root),
    detectMonorepo(root),
    readText(join(root, ".gitignore")),
    exists(join(root, ".git")),
    detectExisting(root),
  ]);

  let sizePromise: Promise<SizeInfo> | undefined;
  return {
    root,
    isGitRepo,
    stacks,
    primaryStack: stacks[0],
    monorepo,
    gitignore: gitignoreText ? parseIgnoreFile(gitignoreText) : [],
    existing,
    size: () => (sizePromise ??= measureSize(root)),
  };
}

async function detectExisting(root: string): Promise<ExistingSetup> {
  const [claudeMd, claudeignore, settings, mcpJson, docsDir] = await Promise.all([
    exists(join(root, "CLAUDE.md")),
    exists(join(root, ".claudeignore")),
    exists(join(root, ".claude", "settings.json")),
    exists(join(root, ".mcp.json")),
    isDir(join(root, "docs")),
  ]);
  return { claudeMd, claudeignore, settings, mcpJson, docsDir };
}
