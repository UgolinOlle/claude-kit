/**
 * `.claudeignore` → `permissions.deny` compiler.
 *
 * Claude Code does not read `.claudeignore`; it enforces `Read(...)` deny rules in
 * `.claude/settings.json`. Those rules use gitignore-style patterns where:
 *   bare `name`  → matches at any depth (relative to cwd)
 *   `/path`      → anchored at the project root (for project settings)
 *   `!pattern`   → carves an exception out of earlier rules in the same list
 * so gitignore lines translate almost 1:1 — the only gap is directories, which need `/**`
 * to cover their contents.
 */

import { globMatcher } from '../utils/runtime.ts';

const GLOB_CHARS = /[*?[]/;

/** "package-lock.json", "app.min.js" → file-like; ".env", "dist", ".next" → could be a dir. */
const looksLikeFile = (segment: string) => /.\.[^.]+$/.test(segment);

function contents(base: string): string {
  return base.startsWith('/') || base.startsWith('**/') ? `${base}/**` : `**/${base}/**`;
}

export function ignoreToDenyRules(
  lines: readonly string[],
  tool: 'Read' | 'Edit' = 'Read',
): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    let p = raw.trim();
    if (!p || p.startsWith('#')) continue;

    const negated = p.startsWith('!');
    if (negated) p = p.slice(1);
    if (p.startsWith('\\')) p = p.slice(1); // escaped leading # or !

    const dirOnly = p.endsWith('/');
    p = p.replace(/\/+$/, '');
    if (!p || p === '/') continue;

    // gitignore: a slash at the start or in the middle anchors the pattern to the root.
    let base: string;
    if (p.startsWith('**/') || p.startsWith('/')) base = p;
    else if (p.includes('/')) base = `/${p}`;
    else base = p;

    const last = p.split('/').pop()!;
    const variants: string[] = [];
    if (dirOnly) {
      variants.push(contents(base));
    } else {
      variants.push(base);
      if (!GLOB_CHARS.test(last) && !looksLikeFile(last)) variants.push(contents(base));
    }
    for (const v of variants) out.push(`${tool}(${negated ? '!' : ''}${v})`);
  }
  return [...new Set(out)];
}

/** Assemble a `.claudeignore` body from labelled sections, de-duplicating across sections. */
export function buildIgnoreFile(
  header: string,
  sections: { title: string; patterns: readonly string[] }[],
): string {
  const seen = new Set<string>();
  const blocks: string[] = [header.trimEnd()];
  for (const { title, patterns } of sections) {
    const fresh = patterns
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('#') && !seen.has(p));
    if (fresh.length === 0) continue;
    fresh.forEach((p) => seen.add(p));
    blocks.push(`# ${title}\n${fresh.join('\n')}`);
  }
  return blocks.join('\n\n') + '\n';
}

/**
 * Matcher with the semantics the deny rules get: gitignore lines, last match wins, `!` re-includes.
 * Used to keep tools (e.g. code search) from surfacing files Claude isn't allowed to read.
 */
export function ignoreMatcher(lines: readonly string[]): (relPath: string) => boolean {
  const rules = ignoreToDenyRules(lines).map((rule) => {
    const body = rule.slice('Read('.length, -1);
    const negated = body.startsWith('!');
    const pattern = (negated ? body.slice(1) : body).replace(/^\//, '');
    return { negated, matches: globMatcher(pattern, { basename: !pattern.includes('/') }) };
  });
  return (relPath) => {
    let ignored = false;
    for (const r of rules) if (r.matches(relPath)) ignored = !r.negated;
    return ignored;
  };
}
