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
}

function firstExisting(ctx: ResolveContext, candidates: string[]): string[] {
  const hit = candidates.find((c) => ctx.files.has(c));
  return hit ? [hit] : [];
}

function resolveJs(from: string, spec: string, ctx: ResolveContext): string[] {
  let base: string;
  if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec);
  else if (/^[@~]\//.test(spec)) base = posix.join('src', spec.slice(2)); // common "@/x" alias
  else return [];
  const noJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/, ''); // TS ESM imports "./x.js" for x.ts
  return firstExisting(ctx, [
    base,
    ...JS_EXT.map((e) => noJs + e),
    ...JS_EXT.map((e) => `${base}/index${e}`),
  ]);
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
