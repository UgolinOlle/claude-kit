/**
 * Merge strategies used when a target file already exists and the user may have edited it.
 * Every strategy preserves user content; only claude-kit-owned parts change.
 *
 * All strategies take an optional `previous` — what claude-kit generated last time — which
 * turns them into 3-way merges: things the user deleted stay deleted, things claude-kit
 * stopped generating get removed, and user changes always win.
 */

/** `seed`: written once if missing, then owned by the user and never touched again. */
export type MergeStrategy = 'replace' | 'regions' | 'json' | 'lines' | 'seed';

// ── Markdown managed regions ────────────────────────────────────────────────

const REGION_RE = /<!-- claude-kit:begin ([\w-]+) -->\n?([\s\S]*?)<!-- claude-kit:end \1 -->/g;

export function region(id: string, body: string): string {
  return `<!-- claude-kit:begin ${id} -->\n${body.replace(/\n*$/, '\n')}<!-- claude-kit:end ${id} -->`;
}

export function extractRegions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(REGION_RE)) out.set(m[1]!, m[0]);
  return out;
}

/**
 * Replace each managed region in `existing` with its counterpart from `generated`.
 * Text outside regions is never touched. Regions the user deleted stay deleted;
 * regions new to this template version are appended.
 */
export function mergeRegions(existing: string, generated: string, previous?: string): string {
  const fresh = extractRegions(generated);
  const known = previous ? new Set(extractRegions(previous).keys()) : new Set<string>();
  const present = new Set<string>();
  let out = existing.replace(REGION_RE, (whole, id: string) => {
    present.add(id);
    return fresh.get(id) ?? whole;
  });
  const appended = [...fresh].filter(([id]) => !present.has(id) && !known.has(id));
  if (appended.length)
    out = `${out.replace(/\n*$/, '')}\n\n${appended.map(([, block]) => block).join('\n\n')}\n`;
  return out;
}

// ── JSON deep merge ─────────────────────────────────────────────────────────

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const key = (v: Json) => JSON.stringify(v);
const same = (a: Json | undefined, b: Json | undefined) =>
  a !== undefined && b !== undefined && key(a) === key(b);

/**
 * Objects merge per key, arrays merge per item, scalars: the user's value wins unless
 * it is still exactly what claude-kit generated last time (then the new value is taken).
 */
export function deepMergeJson(existing: Json, generated: Json, previous?: Json): Json {
  if (isObject(existing) && isObject(generated)) {
    const prev = isObject(previous) ? previous : undefined;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (!(k in generated) && prev && k in prev && same(v, prev[k])) continue; // we dropped it, user didn't touch it
      out[k] = k in generated ? deepMergeJson(v, generated[k]!, prev?.[k]) : v;
    }
    for (const [k, v] of Object.entries(generated)) {
      if (k in existing) continue;
      if (prev && k in prev) continue; // user deleted it
      out[k] = v;
    }
    return out;
  }
  if (Array.isArray(existing) && Array.isArray(generated)) {
    const gen = new Set(generated.map(key));
    const prev = new Set(Array.isArray(previous) ? previous.map(key) : []);
    const have = new Set(existing.map(key));
    const kept = existing.filter((v) => gen.has(key(v)) || !prev.has(key(v)));
    const added = generated.filter((v) => !have.has(key(v)) && !prev.has(key(v)));
    return [...kept, ...added];
  }
  if (previous !== undefined && same(existing, previous)) return generated;
  return existing;
}

export function mergeJsonText(existing: string, generated: string, previous?: string): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(existing);
  } catch {
    throw new Error('existing file is not valid JSON; refusing to merge');
  }
  const prev = previous === undefined ? undefined : (JSON.parse(previous) as Json);
  return JSON.stringify(deepMergeJson(parsed, JSON.parse(generated), prev), null, 2) + '\n';
}

// ── Line-set merge (ignore files) ───────────────────────────────────────────

export const LINES_HEADER = '# added by claude-kit';

const contentLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

/**
 * Keep the user's file (order, comments) and append generated lines it lacks.
 * With `previous`: lines the user removed aren't re-added, lines claude-kit dropped are removed.
 */
export function mergeLines(existing: string, generated: string, previous?: string): string {
  const gen = new Set(contentLines(generated));
  const prev = new Set(previous ? contentLines(previous) : []);
  const lines = existing.split('\n').filter((l) => {
    const t = l.trim();
    return !(t && prev.has(t) && !gen.has(t));
  });
  const have = new Set(lines.map((l) => l.trim()));
  const missing = [...gen].filter((l) => !have.has(l) && !prev.has(l));

  const base = lines.join('\n').replace(/\n*$/, '');
  if (missing.length === 0) return base === existing.replace(/\n*$/, '') ? existing : `${base}\n`;
  const header = have.has(LINES_HEADER) ? '' : `${LINES_HEADER}\n`;
  return `${base}${base ? '\n\n' : ''}${header}${missing.join('\n')}\n`;
}

export function mergeContent(
  strategy: MergeStrategy,
  existing: string,
  generated: string,
  previous?: string,
): string {
  switch (strategy) {
    case 'regions':
      return mergeRegions(existing, generated, previous);
    case 'json':
      return mergeJsonText(existing, generated, previous);
    case 'lines':
      return mergeLines(existing, generated, previous);
    case 'replace':
      return generated;
    case 'seed':
      return existing;
  }
}
