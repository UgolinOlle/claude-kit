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
/**
 * Generated code and test data match many queries and answer none (a router's route tree, API
 * stubs, captured HTML pages), so they are left out of the index; Claude can still read them.
 */
const GENERATED_PATH =
  /(?:^|\/)(?:@generated|__generated__|generated)\/|\.(?:gen|generated)\.[^/]+$|_pb2(?:_grpc)?\.py$|\.pb(?:\.gw)?\.go$|\.(?:g|freezed)\.dart$|\.snap$/i;
/** Marker comments generators put at the top of a file (checked in its first KB). */
const GENERATED_HEADER =
  /@generated\b|\bauto-?generated\b|\bautomatically generated\b|\bDO NOT EDIT\b/i;
/** Under fixture directories, only code is indexed: the rest is sample data. */
const TEST_DATA_DIR = /(?:^|\/)(?:fixtures|__fixtures__|testdata|__snapshots__)\//i;
const CODE_EXT =
  /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kts?|swift|php|cs|c|h|cc|cpp|hpp|scala|exs?|dart|lua|sh)$/i;

/** Left out of the index by path alone (no read needed). */
export function isNoise(rel: string): boolean {
  return GENERATED_PATH.test(rel) || (TEST_DATA_DIR.test(rel) && !CODE_EXT.test(rel));
}

export const looksGenerated = (text: string) => GENERATED_HEADER.test(text.slice(0, 1024));

export interface FileEntry {
  mtimeMs: number;
  size: number;
  chunks: Chunk[];
  imports: string[];
}

export interface SearchIndex {
  format: number;
  files: Record<string, FileEntry>;
  /** Files read and left out (binary, too large, generated), so unchanged ones aren't re-read. */
  skipped?: Record<string, { size: number; mtimeMs: number }>;
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
  return paths.filter((p) => !SKIP.test(p) && !BINARY_EXT.test(p) && !isNoise(p) && !ignored(p));
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
  if (looksGenerated(text)) return null;
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
  const oldSkipped = (saved?.format === FORMAT && saved.skipped) || {};
  const skipped: NonNullable<SearchIndex['skipped']> = {};
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
    const was = oldSkipped[rel];
    if (was && was.size === info.size && was.mtimeMs === info.mtimeMs) {
      skipped[rel] = was;
      continue;
    }
    const entry = await indexFile(root, rel, info.size, info.mtimeMs);
    if (entry) {
      files[rel] = entry;
      updated++;
    } else skipped[rel] = { size: info.size, mtimeMs: info.mtimeMs };
  }
  const removed = Object.keys(old).filter((f) => !(f in files)).length;
  const skipChanged =
    Object.keys(skipped).length !== Object.keys(oldSkipped).length ||
    Object.keys(skipped).some((f) => skipped[f] !== oldSkipped[f]);
  const index: SearchIndex = { format: FORMAT, files, skipped };
  if (updated || removed || skipChanged || !saved) {
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
