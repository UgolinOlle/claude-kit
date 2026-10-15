/**
 * The code-search index (#7, `index_codebase`): chunks + term frequencies + import specifiers per
 * file, stored in .claude-kit/index/ (git-ignored). Updates are incremental: only files whose
 * size or mtime changed are re-read, so calling it before every query is cheap.
 */
import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { parseIgnoreFile } from '../core/context.ts';
import { ignoreMatcher } from '../core/ignore.ts';
import { BINARY_EXT, listProjectFiles } from '../detect/size.ts';
import { COMMON_IGNORE } from '../packs/common.ts';
import { looksBinary, readJson, readText, writeAtomic } from '../utils/fsSafe.ts';
import { readBytes } from '../utils/runtime.ts';

import { type Chunk, chunkFile } from './chunk.ts';
import {
  type AliasScope,
  aliasScope,
  importSpecifiers,
  type ResolveContext,
  resolveImport,
} from './imports.ts';

export const INDEX_DIR = '.claude-kit/index';
const INDEX_FILE = 'search.json';
/** Bump when the chunk/term format changes: old indexes are rebuilt. */
const FORMAT = 1;
/** Larger files are generated, vendored or data; skip them. */
const MAX_BYTES = 512 * 1024;
const SKIP =
  /(?:^|\/)(?:\.claude-kit|\.git)\/|\.min\.(?:js|css)$|\.map$|\.(?:lock|lockb|svg|csv|tsv)$/i;

export interface FileEntry {
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
  imports: string[];
}

export interface SearchIndex {
  format: number;
  files: Record<string, FileEntry>;
}

export interface IndexStats {
  files: number;
  chunks: number;
  /** Files (re)indexed by this update. */
  updated: number;
  removed: number;
}

/** The index plus the graph derived from it, ready to query. */
export interface LoadedIndex {
  root: string;
  index: SearchIndex;
  imports: Map<string, string[]>;
  importedBy: Map<string, string[]>;
  stats: IndexStats;
}

async function readIgnore(root: string): Promise<(rel: string) => boolean> {
  const text = await readText(join(root, '.claudeignore'));
  return ignoreMatcher(text !== null ? parseIgnoreFile(text) : COMMON_IGNORE);
}

async function indexable(root: string): Promise<string[]> {
  const [{ paths }, ignored] = await Promise.all([listProjectFiles(root), readIgnore(root)]);
  return paths.filter((p) => !SKIP.test(p) && !BINARY_EXT.test(p) && !ignored(p));
}

async function indexFile(
  root: string,
  rel: string,
  size: number,
  mtimeMs: number,
): Promise<FileEntry | null> {
  if (size > MAX_BYTES) return null;
  const bytes = await readBytes(join(root, rel));
  if (looksBinary(bytes)) return null;
  const text = new TextDecoder().decode(bytes);
  return { mtimeMs, size, chunks: chunkFile(rel, text), imports: importSpecifiers(rel, text) };
}

const TSCONFIG = /(?:^|\/)(?:tsconfig|jsconfig)\.json$/;

/** `paths` aliases of every indexed tsconfig/jsconfig, deepest directory first. */
async function readAliases(root: string, files: string[]): Promise<AliasScope[]> {
  const scopes: AliasScope[] = [];
  for (const f of files.filter((p) => TSCONFIG.test(p))) {
    const text = await readText(join(root, f));
    const scope = text ? aliasScope(f, text) : null;
    if (scope) scopes.push(scope);
  }
  return scopes.sort((a, b) => b.dir.length - a.dir.length);
}

function graph(index: SearchIndex, goModule?: string, aliases: AliasScope[] = []) {
  const files = new Set(Object.keys(index.files));
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const d = posix.dirname(f);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const ctx: ResolveContext = { files, byDir, goModule, aliases };
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  for (const [from, entry] of Object.entries(index.files)) {
    const targets = [...new Set(entry.imports.flatMap((s) => resolveImport(from, s, ctx)))].filter(
      (t) => t !== from,
    );
    imports.set(from, targets);
    for (const t of targets) importedBy.set(t, [...(importedBy.get(t) ?? []), from]);
  }
  return { imports, importedBy };
}

/** Load, bring up to date with the working tree, save if anything changed. */
export async function updateIndex(root: string): Promise<LoadedIndex> {
  const path = join(root, INDEX_DIR, INDEX_FILE);
  const saved = await readJson<SearchIndex>(path);
  const old = saved?.format === FORMAT ? saved.files : {};
  const files: Record<string, FileEntry> = {};
  let updated = 0;

  for (const rel of await indexable(root)) {
    let info;
    try {
      info = await stat(join(root, rel));
    } catch {
      continue; // listed by git but deleted
    }
    if (!info.isFile()) continue;
    const prev = old[rel];
    if (prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs) {
      files[rel] = prev;
      continue;
    }
    const entry = await indexFile(root, rel, info.size, info.mtimeMs);
    if (entry) {
      files[rel] = entry;
      updated++;
    }
  }
  const removed = Object.keys(old).filter((f) => !(f in files)).length;
  const index: SearchIndex = { format: FORMAT, files };
  if (updated || removed || !saved) {
    await writeAtomic(join(root, INDEX_DIR, '.gitignore'), '*\n');
    await writeAtomic(path, JSON.stringify(index));
  }

  const goMod = await readText(join(root, 'go.mod'));
  const goModule = goMod ? /^module\s+(\S+)/m.exec(goMod)?.[1] : undefined;
  return {
    root,
    index,
    ...graph(index, goModule, await readAliases(root, Object.keys(files))),
    stats: {
      files: Object.keys(files).length,
      chunks: Object.values(files).reduce((n, f) => n + f.chunks.length, 0),
      updated,
      removed,
    },
  };
}
