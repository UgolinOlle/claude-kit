import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { looksBinary } from '../utils/fsSafe.ts';
import { estimateTokensFromBytes } from '../utils/tokenCount.ts';

/** Above this, the repo can't fit a context window and a RAG index starts paying off (strategy #7). */
export const RAG_THRESHOLD_TOKENS = 200_000;

export interface SizeInfo {
  files: number;
  bytes: number;
  estTokens: number;
  largest: { path: string; tokens: number }[];
  /** Every counted text file, for maps and per-directory rollups. */
  entries: { path: string; tokens: number }[];
  /** "git" when the file list came from `git ls-files` (respects .gitignore), "walk" otherwise. */
  source: 'git' | 'walk';
  needsRag: boolean;
}

/** Used only when there's no git: the usual heavy/generated directories. */
const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  'vendor',
  '.claude-kit',
]);

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp[34]|mov|wasm|so|dylib|dll|exe|lockb|sqlite|db)$/i;

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: root,
        stdout: 'pipe',
        stderr: 'ignore',
      },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function walkFiles(root: string, dir = root, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!DEFAULT_SKIP_DIRS.has(entry.name)) await walkFiles(root, join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, join(dir, entry.name)));
    }
  }
  return acc;
}

export async function measureSize(root: string, opts: { top?: number } = {}): Promise<SizeInfo> {
  const fromGit = await gitFiles(root);
  const paths = fromGit ?? (await walkFiles(root));
  const sized: { path: string; tokens: number; bytes: number }[] = [];

  for (const path of paths) {
    if (BINARY_EXT.test(path)) continue;
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue; // deleted but still in the index
    const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    if (looksBinary(head)) continue;
    sized.push({
      path,
      bytes: file.size,
      tokens: estimateTokensFromBytes(file.size),
    });
  }

  const bytes = sized.reduce((s, f) => s + f.bytes, 0);
  const estTokens = sized.reduce((s, f) => s + f.tokens, 0);
  const largest = [...sized]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, opts.top ?? 10)
    .map(({ path, tokens }) => ({ path, tokens }));

  return {
    files: sized.length,
    bytes,
    estTokens,
    largest,
    entries: sized.map(({ path, tokens }) => ({ path, tokens })),
    source: fromGit ? 'git' : 'walk',
    needsRag: estTokens > RAG_THRESHOLD_TOKENS,
  };
}
