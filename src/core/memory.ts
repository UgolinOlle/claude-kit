/**
 * Discovers the instruction files Claude Code loads, following the documented rules:
 * - CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md in the working dir and every ancestor (launch)
 * - ~/.claude/CLAUDE.md and ~/.claude/rules (launch)
 * - .claude/rules/**.md: at launch unless `paths:` frontmatter scopes them (on demand)
 * - AGENTS.md only when no CLAUDE.md exists at or above the working dir
 * - nested CLAUDE.md in subdirectories (on demand)
 * - `@path` imports, up to 4 hops, skipping code spans and fenced blocks
 * - auto memory: first 200 lines / 25KB of ~/.claude/projects/<project>/memory/MEMORY.md
 * Block-level HTML comments are stripped before injection, so they cost no tokens.
 */
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { exists, readText } from '../utils/fsSafe.ts';
import { glob, parseYaml } from '../utils/runtime.ts';
import { estimateTokens } from '../utils/tokenCount.ts';

export type MemoryScope =
  | 'project'
  | 'project-local'
  | 'ancestor'
  | 'user'
  | 'user-rules'
  | 'rules'
  | 'agents-md'
  | 'nested'
  | 'import'
  | 'auto-memory';

export interface MissingImport {
  spec: string;
  line: number;
}

export interface MemoryFile {
  path: string;
  /** Short path for display: relative to root, or ~-prefixed. */
  display: string;
  scope: MemoryScope;
  loadedAtStart: boolean;
  raw: string;
  /** What actually reaches the model (comments stripped, auto-memory truncated). */
  content: string;
  lines: number;
  tokens: number;
  importedBy?: string;
  missingImports: MissingImport[];
}

export const MAX_IMPORT_HOPS = 4;
const AUTO_MEMORY_MAX_LINES = 200;
const AUTO_MEMORY_MAX_BYTES = 25 * 1024;
const NESTED_SKIP = /(^|\/)(node_modules|\.git|dist|build|target|vendor|\.venv|venv)(\/|$)/;

// ── text helpers ────────────────────────────────────────────────────────────

const FENCE = /^\s*(```|~~~)/;

/** Remove block-level `<!-- -->` comments outside fenced code blocks. */
export function stripBlockComments(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let inComment = false;
  for (const line of text.split('\n')) {
    if (inComment) {
      if (line.includes('-->')) {
        inComment = false;
        const rest = line.slice(line.indexOf('-->') + 3);
        if (rest.trim()) out.push(rest);
      }
      continue;
    }
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.trimStart().startsWith('<!--')) {
      const end = line.indexOf('-->');
      if (end === -1) {
        inComment = true;
        continue;
      }
      const rest = line.slice(end + 3);
      if (rest.trim()) out.push(rest);
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** `@path` imports outside fenced blocks and inline code spans, with 1-based line numbers. */
export function parseImports(text: string): { spec: string; line: number }[] {
  const found: { spec: string; line: number }[] = [];
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const m of bare.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/~]+)/g)) {
      const spec = m[1]!.replace(/[.,;:)]+$/, '');
      if (spec) found.push({ spec, line: i + 1 });
    }
  });
  return found;
}

function parseFrontmatter(text: string): Record<string, unknown> | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const data = parseYaml(m[1]!);
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hasPathsFrontmatter(text: string): boolean {
  const fm = parseFrontmatter(text);
  return Boolean(fm && fm.paths !== undefined && fm.paths !== null);
}

export function frontmatter(text: string): Record<string, unknown> | null {
  return parseFrontmatter(text);
}

// ── discovery ───────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** Defaults to $CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string;
  home?: string;
  /** Include CLAUDE.md files in directories above the root (default true). */
  ancestors?: boolean;
}

export function defaultConfigDir(home = homedir()): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
}

/** Claude Code names the per-project dir after the absolute path with separators → "-". */
export function projectDirName(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function discoverMemory(
  rootArg: string,
  opts: DiscoverOptions = {},
): Promise<MemoryFile[]> {
  const root = resolve(rootArg);
  const home = opts.home ?? homedir();
  const configDir = opts.configDir ?? defaultConfigDir(home);
  const files: MemoryFile[] = [];
  const seen = new Set<string>();

  const display = (p: string) => {
    if (p === root || p.startsWith(root + sep)) return relative(root, p) || '.';
    if (p.startsWith(home + sep)) return '~/' + relative(home, p);
    return p;
  };

  async function add(
    path: string,
    scope: MemoryScope,
    loadedAtStart: boolean,
    importedBy?: string,
    hops = 0,
  ) {
    if (seen.has(path)) return;
    const raw = await readText(path);
    if (raw === null) return;
    seen.add(path);

    let content = stripBlockComments(raw);
    if (scope === 'auto-memory') {
      content = content.split('\n').slice(0, AUTO_MEMORY_MAX_LINES).join('\n');
      if (content.length > AUTO_MEMORY_MAX_BYTES) content = content.slice(0, AUTO_MEMORY_MAX_BYTES);
    }
    const file: MemoryFile = {
      path,
      display: display(path),
      scope,
      loadedAtStart,
      raw,
      content,
      lines: raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0),
      tokens: estimateTokens(content),
      importedBy,
      missingImports: [],
    };
    files.push(file);

    if (scope === 'auto-memory' || hops >= MAX_IMPORT_HOPS) return;
    for (const { spec, line } of parseImports(raw)) {
      const target = spec.startsWith('~/')
        ? join(home, spec.slice(2))
        : resolve(dirname(path), spec);
      if (await exists(target)) await add(target, 'import', loadedAtStart, file.display, hops + 1);
      else file.missingImports.push({ spec, line });
    }
  }

  // user scope
  await add(join(configDir, 'CLAUDE.md'), 'user', true);
  await addRules(join(configDir, 'rules'), 'user-rules');

  // ancestors, filesystem root first
  if (opts.ancestors !== false) {
    const chain: string[] = [];
    for (let d = dirname(root); d !== dirname(d); d = dirname(d)) chain.unshift(d);
    for (const d of chain) {
      if (d === configDir) continue;
      await add(join(d, 'CLAUDE.md'), 'ancestor', true);
      await add(join(d, 'CLAUDE.local.md'), 'ancestor', true);
    }
  }

  // project
  await add(join(root, 'CLAUDE.md'), 'project', true);
  await add(join(root, '.claude', 'CLAUDE.md'), 'project', true);
  await add(join(root, 'CLAUDE.local.md'), 'project-local', true);
  const hasClaudeMd = files.some((f) => ['project', 'project-local', 'ancestor'].includes(f.scope));
  if (!hasClaudeMd) await add(join(root, 'AGENTS.md'), 'agents-md', true);
  await addRules(join(root, '.claude', 'rules'), 'rules');

  // auto memory
  await add(
    join(configDir, 'projects', projectDirName(root), 'memory', 'MEMORY.md'),
    'auto-memory',
    true,
  );

  // nested, on demand
  for (const rel of await glob('**/{CLAUDE,CLAUDE.local}.md', {
    cwd: root,
    ignore: ['**/node_modules/**', '**/.git/**'],
  })) {
    if (!rel.includes('/') || NESTED_SKIP.test(rel)) continue;
    await add(join(root, rel), 'nested', false);
  }

  return files;

  async function addRules(dir: string, scope: 'rules' | 'user-rules') {
    if (!(await exists(dir))) return;
    const rels: string[] = [];
    rels.push(...(await glob('**/*.md', { cwd: dir })));
    for (const rel of rels.sort()) {
      const path = join(dir, rel);
      const text = (await readText(path)) ?? '';
      await add(path, scope, !hasPathsFrontmatter(text));
    }
  }
}

export const atStart = (files: MemoryFile[]) => files.filter((f) => f.loadedAtStart);
