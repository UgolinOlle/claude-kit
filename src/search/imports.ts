/**
 * Import graph for `related_files` and search results (#7: "add dependency-graph neighbours").
 * Specifiers are parsed per file when it's indexed; resolving them to project files happens at
 * query time, because it depends on which files exist.
 */
import { extname, posix } from 'node:path';

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_FROM =
  /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const GO_SINGLE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const GO_BLOCK = /^\s*import\s*\(([\s\S]*?)\)/gm;

export function importSpecifiers(path: string, text: string): string[] {
  const ext = extname(path).toLowerCase();
  const out = new Set<string>();
  if (JS_EXT.includes(ext) || ext === '.vue' || ext === '.svelte') {
    for (const m of text.matchAll(JS_FROM)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec) out.add(spec);
    }
  } else if (ext === '.py' || ext === '.pyi') {
    for (const m of text.matchAll(PY_FROM)) out.add(m[1]!);
    for (const m of text.matchAll(PY_IMPORT))
      for (const mod of m[1]!.split(',')) out.add(mod.trim());
  } else if (ext === '.go') {
    for (const m of text.matchAll(GO_SINGLE)) out.add(m[1]!);
    for (const m of text.matchAll(GO_BLOCK))
      for (const q of m[1]!.matchAll(/"([^"]+)"/g)) out.add(q[1]!);
  }
  return [...out];
}

export interface ResolveContext {
  /** Every indexed path. */
  files: ReadonlySet<string>;
  /** Directory → files directly in it (for Go packages). */
  byDir: ReadonlyMap<string, string[]>;
  /** Module path from go.mod, if any. */
  goModule?: string;
  /** tsconfig/jsconfig `paths` per project directory, deepest first. */
  aliases?: AliasScope[];
}

/** `compilerOptions.paths` of one tsconfig, with targets made project-relative. */
export interface AliasScope {
  /** Directory the tsconfig applies to ("" for the root). */
  dir: string;
  rules: { pattern: string; targets: string[] }[];
}

/** JSONC (comments, trailing commas) → value; null if it still isn't JSON. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/** Alias rules from a tsconfig/jsconfig at `path` (project-relative). `extends` isn't followed. */
export function aliasScope(path: string, text: string): AliasScope | null {
  const config = parseJsonc(text) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  } | null;
  const paths = config?.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object') return null;
  const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const base = posix.join(dir, config!.compilerOptions!.baseUrl ?? '.');
  const rules = Object.entries(paths)
    .filter(([, targets]) => Array.isArray(targets))
    .map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((t) => posix.normalize(posix.join(base, t)).replace(/^\.\//, '')),
    }));
  return rules.length ? { dir, rules } : null;
}

/** "~/lib/x" against "~/*" → ["apps/web/src/lib/x"]; exact patterns match whole specifiers. */
function expandAlias(spec: string, scope: AliasScope): string[] {
  const out: string[] = [];
  for (const { pattern, targets } of scope.rules) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (spec === pattern) out.push(...targets);
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      !spec.startsWith(prefix) ||
      !spec.endsWith(suffix) ||
      spec.length < prefix.length + suffix.length
    )
      continue;
    const middle = spec.slice(prefix.length, spec.length - suffix.length);
    out.push(...targets.map((t) => t.replace('*', middle)));
  }
  return out;
}

function firstExisting(ctx: ResolveContext, candidates: string[]): string[] {
  const hit = candidates.find((c) => ctx.files.has(c));
  return hit ? [hit] : [];
}

function withExtensions(base: string): string[] {
  const noJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/, ''); // TS ESM imports "./x.js" for x.ts
  return [base, ...JS_EXT.map((e) => noJs + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
}

function resolveJs(from: string, spec: string, ctx: ResolveContext): string[] {
  if (spec.startsWith('.'))
    return firstExisting(ctx, withExtensions(posix.join(posix.dirname(from), spec)));
  // The nearest tsconfig/jsconfig above the importing file decides what an alias means.
  const scope = ctx.aliases?.find((a) => a.dir === '' || from.startsWith(a.dir + '/'));
  const bases = scope ? expandAlias(spec, scope) : [];
  if (bases.length === 0 && /^[@~]\//.test(spec)) bases.push(posix.join('src', spec.slice(2))); // common default
  for (const base of bases) {
    const hit = firstExisting(ctx, withExtensions(base));
    if (hit.length) return hit;
  }
  return [];
}

function resolvePy(from: string, spec: string, ctx: ResolveContext): string[] {
  const dots = /^\.*/.exec(spec)![0].length;
  const mod = spec.slice(dots).replace(/\./g, '/');
  const roots = dots
    ? [posix.join(posix.dirname(from), ...Array<string>(dots - 1).fill('..'))]
    : ['', 'src'];
  const candidates: string[] = [];
  for (const root of roots) {
    const p = posix.join(root, mod);
    if (mod) candidates.push(`${p}.py`, `${p}/__init__.py`);
    else candidates.push(posix.join(root, '__init__.py'));
  }
  return firstExisting(
    ctx,
    candidates.map((c) => c.replace(/^\.\//, '')),
  );
}

function resolveGo(spec: string, ctx: ResolveContext): string[] {
  if (!ctx.goModule || !(spec === ctx.goModule || spec.startsWith(ctx.goModule + '/'))) return [];
  const dir = spec.slice(ctx.goModule.length + 1) || '.';
  return (ctx.byDir.get(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
}

/** Project files a specifier points at; external packages resolve to nothing. */
export function resolveImport(from: string, spec: string, ctx: ResolveContext): string[] {
  const ext = extname(from).toLowerCase();
  if (ext === '.py' || ext === '.pyi') return resolvePy(from, spec, ctx);
  if (ext === '.go') return resolveGo(spec, ctx);
  return resolveJs(from, spec, ctx);
}
