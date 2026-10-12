import { inRepo } from './claudemd.ts';
import type { Finding, Rule } from './types.ts';

/**
 * Prompt caching reuses the session prefix (system prompt, tools, CLAUDE.md…) only while it
 * is byte-identical. Content that changes between sessions invalidates it every time.
 */

const VOLATILE_PATTERNS: { re: RegExp; what: string }[] = [
  {
    re: /\b(?:19|20)\d\d-[01]\d-[0-3]\d(?:[T ][0-2]\d:[0-5]\d)?/,
    what: 'a date',
  },
  { re: /\b[0-2]\d:[0-5]\d:[0-5]\d\b/, what: 'a timestamp' },
  {
    re: /\b(?:last (?:updated|modified|generated|run)|generated (?:at|on)|as of)\b/i,
    what: 'a freshness marker',
  },
];

/** Files that by nature change between sessions. */
const VOLATILE_FILE =
  /(?:^|\/)(?:task_context|conversation_memory|session[\w-]*|scratch[\w-]*|progress|todo|notes)\.md$|\.log$/i;

export const volatileContent: Rule = {
  id: 'cache/volatile-content',
  description:
    'Dates or freshness markers in always-loaded instructions suggest the file is rewritten regularly.',
  check(ctx) {
    const findings: Finding[] = [];
    for (const f of ctx.memory) {
      if (!f.loadedAtStart || !inRepo(ctx, f) || f.scope === 'auto-memory') continue;
      const lines = f.content.split('\n');
      for (const { re, what } of VOLATILE_PATTERNS) {
        const idx = lines.findIndex((l) => re.test(l));
        if (idx === -1) continue;
        // f.content has comments stripped; map back to the raw line for the report
        const rawLine = f.raw.split('\n').findIndex((l) => l === lines[idx]) + 1 || undefined;
        findings.push({
          ruleId: this.id,
          severity: 'warn',
          file: f.display,
          line: rawLine,
          message: `${f.display}${rawLine ? `:${rawLine}` : ''} contains ${what} in always-loaded context. If a script or hook rewrites it, every rewrite invalidates the prompt cache for the session prefix.`,
          hint: "Keep CLAUDE.md static. Put changing state in a file Claude reads on demand, and if it's only a note, use an HTML comment (stripped before loading).",
        });
        break; // one finding per file is enough
      }
    }
    return findings;
  },
};

export const volatileImport: Rule = {
  id: 'cache/volatile-import',
  description: 'Always-loaded instructions import a file that changes between sessions.',
  check(ctx) {
    return ctx.memory
      .filter((f) => f.scope === 'import' && f.loadedAtStart && VOLATILE_FILE.test(f.path))
      .map((f) => ({
        ruleId: this.id,
        severity: 'warn' as const,
        file: f.importedBy,
        message: `${f.importedBy} imports ${f.display}, which changes between sessions; each change invalidates the cached prompt prefix.`,
        hint: 'Remove the @import and tell Claude to read the file when it needs it (e.g. "see task_context.md for current state").',
      }));
  },
};
