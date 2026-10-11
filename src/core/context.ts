import { join, resolve } from 'node:path';

import { detectMonorepo, type MonorepoInfo } from '../detect/monorepo.ts';
import { measureSize, type SizeInfo } from '../detect/size.ts';
import { detectStacks, type StackId, type StackInfo } from '../detect/stack.ts';
import { detectorFor, loadExternalPacks } from '../packs/external.ts';
import { BUILTIN_PACKS, type StackPack } from '../packs/index.ts';
import { exists, isDir, readText } from '../utils/fsSafe.ts';

import { loadConfig } from './config.ts';

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
  /** Built-in packs plus external ones from .claude-kit/config.json. */
  packs: ReadonlyMap<StackId, StackPack>;
  /** Repo size scan — the only slow part, so it's computed on first call and cached. */
  size(): Promise<SizeInfo>;
}

export function parseIgnoreFile(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export async function buildContext(rootArg: string): Promise<ProjectContext> {
  const root = resolve(rootArg);
  if (!(await isDir(root))) throw new Error(`Not a directory: ${root}`);

  const config = await loadConfig(root);
  const external = await loadExternalPacks(root, config.packs);
  const packs = new Map<StackId, StackPack>([
    ...Object.entries(BUILTIN_PACKS),
    ...external.map((p) => [p.id, p] as const),
  ]);

  const [stacks, monorepo, gitignoreText, isGitRepo, existing] = await Promise.all([
    detectStacks(root, external.map(detectorFor)),
    detectMonorepo(root),
    readText(join(root, '.gitignore')),
    exists(join(root, '.git')),
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
    packs,
    size: () => (sizePromise ??= measureSize(root)),
  };
}

async function detectExisting(root: string): Promise<ExistingSetup> {
  const [claudeMd, claudeignore, settings, mcpJson, docsDir] = await Promise.all([
    exists(join(root, 'CLAUDE.md')),
    exists(join(root, '.claudeignore')),
    exists(join(root, '.claude', 'settings.json')),
    exists(join(root, '.mcp.json')),
    isDir(join(root, 'docs')),
  ]);
  return { claudeMd, claudeignore, settings, mcpJson, docsDir };
}
