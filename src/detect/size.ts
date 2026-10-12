import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { looksBinary } from "../utils/fsSafe.ts";
import { fileExists, fileSize, readBytes, run } from "../utils/runtime.ts";
import { estimateTokensFromBytes } from "../utils/tokenCount.ts";

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
  source: "git" | "walk";
  needsRag: boolean;
}

/** Used only when there's no git: the usual heavy/generated directories. */
const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "vendor",
  ".claude-kit",
]);

export const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp[34]|mov|wasm|so|dylib|dll|exe|lockb|sqlite|db)$/i;

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { code, stdout } = await run(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root },
    );
    if (code !== 0) return null;
    return stdout.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

async function walkFiles(
  root: string,
  dir = root,
  acc: string[] = [],
): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!DEFAULT_SKIP_DIRS.has(entry.name))
        await walkFiles(root, join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, join(dir, entry.name)));
    }
  }
  return acc;
}

/** Repo files, relative POSIX paths: git's view (respects .gitignore) or a filtered walk. */
export async function listProjectFiles(
  root: string,
): Promise<{ paths: string[]; source: "git" | "walk" }> {
  const fromGit = await gitFiles(root);
  if (fromGit) return { paths: fromGit, source: "git" };
  return {
    paths: (await walkFiles(root)).map((p) => p.split(sep).join("/")),
    source: "walk",
  };
}

export async function measureSize(
  root: string,
  opts: { top?: number } = {},
): Promise<SizeInfo> {
  const { paths, source } = await listProjectFiles(root);
  const sized: { path: string; tokens: number; bytes: number }[] = [];

  for (const path of paths) {
    if (BINARY_EXT.test(path)) continue;
    const abs = join(root, path);
    if (!(await fileExists(abs))) continue; // deleted but still in the index
    if (looksBinary(await readBytes(abs, 8192))) continue;
    const size = await fileSize(abs);
    sized.push({ path, bytes: size, tokens: estimateTokensFromBytes(size) });
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
    source,
    needsRag: estTokens > RAG_THRESHOLD_TOKENS,
  };
}
