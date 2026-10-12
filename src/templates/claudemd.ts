import { region } from '../core/merge.ts';
import { NPX } from '../data/package.ts';
import type { PackCommand } from '../packs/index.ts';

export interface ClaudeMdInput {
  name: string;
  stacks: { label: string; manager: string; deps: string[] }[];
  monorepo?: { tools: string[]; packages: string[] };
  commands: PackCommand[];
  guardrails: {
    claudeignore: boolean;
    hooks: boolean;
    /** Migration tools whose committed files are edit-protected. */
    migrations?: string[];
    /** Content rule ids the pre-edit hook enforces. */
    content?: string[];
  };
  /** Optional sections, one per feature; absent = feature off. */
  extras?: {
    taskContext?: string;
    memory?: string;
    docs?: boolean;
    map?: string;
    agents?: string[];
    compress?: boolean;
    search?: boolean;
    modelCheatsheet?: string[];
  };
}

const MAX_LIST = 12;

function list(items: string[], fmt = (s: string) => `\`${s}\``): string {
  const shown = items.slice(0, MAX_LIST).map(fmt).join(', ');
  return items.length > MAX_LIST ? `${shown}, … (+${items.length - MAX_LIST} more)` : shown;
}

function stackRegion(input: ClaudeMdInput): string {
  const lines: string[] = ['## Stack', ''];
  if (input.stacks.length === 0) lines.push('- <!-- Language, framework, runtime. -->');
  for (const s of input.stacks) {
    lines.push(`- ${s.label} (package manager: ${s.manager})`);
    if (s.deps.length) lines.push(`  - Key dependencies: ${list(s.deps)}`);
  }
  if (input.monorepo) {
    const tools = input.monorepo.tools.join(' + ');
    const n = input.monorepo.packages.length;
    lines.push(
      `- Monorepo (${tools}), ${n} package${n === 1 ? '' : 's'}: ${list(input.monorepo.packages)}`,
    );
  }
  return region('stack', lines.join('\n'));
}

function commandsRegion(commands: PackCommand[]): string {
  if (commands.length === 0)
    return region('commands', '## Commands\n\n<!-- How to install, run, test, lint. -->');
  const seen = new Set<string>();
  const unique = commands.filter((c) => !seen.has(c.cmd) && seen.add(c.cmd));
  const width = Math.max(...unique.map((c) => c.cmd.length));
  const body = unique.map((c) => `${c.cmd.padEnd(width)}  # ${c.label}`).join('\n');
  return region('commands', `## Commands\n\n\`\`\`bash\n${body}\n\`\`\``);
}

function workflowRegion(): string {
  return region(
    'workflow',
    `## Workflow

- **Plan first.** For changes touching more than ~3 files, start in Plan Mode (Shift+Tab), agree on the plan, then edit.
- **Decompose.** Split big tasks into steps that each end green (tests/typecheck pass) before starting the next.
- **Search, then read.** Grep/glob for the symbol you need instead of opening whole directories or large files.
- **Verify.** Run the relevant test/lint command before calling a task done.`,
  );
}

function guardrailsRegion(g: ClaudeMdInput['guardrails']): string | null {
  const lines: string[] = [];
  if (g.claudeignore) {
    lines.push(
      "- Paths in `.claudeignore` are blocked from reading via `permissions.deny` in `.claude/settings.json`. Don't work around it with shell commands; ask if you need one of them.",
    );
  }
  if (g.hooks) {
    lines.push(
      '- Lockfiles, build output and `.env*` files are edit-protected by `.claude/hooks/pre-edit.cjs`. Change the source of truth instead (manifest, sources).',
    );
    if (g.migrations?.length)
      lines.push(
        `- Committed migrations (${list(g.migrations, (s) => s)}) are history: never edit them, generate a new migration instead.`,
      );
    if (g.content?.length)
      lines.push(
        `- Added code is checked against: ${list(g.content)}. The hook explains any block.`,
      );
  }
  return lines.length ? region('guardrails', `## Guardrails\n\n${lines.join('\n')}`) : null;
}

type Extras = NonNullable<ClaudeMdInput['extras']>;

function extraRegions(x: Extras): (string | null)[] {
  return [
    x.taskContext
      ? region(
          'task-context',
          `## Task context\n\n- For multi-step work, keep \`${x.taskContext}\` current (goal, status, next steps). Update it before a session ends or when context runs long; it's re-loaded after compaction.\n- When resuming a task, read it first.`,
        )
      : null,
    x.memory
      ? region(
          'memory',
          `## Team memory\n\n- Past decisions, rejected approaches and lessons are in \`${x.memory}\`. Check it before revisiting a decision; append one line when a new one is made.`,
        )
      : null,
    x.docs
      ? region(
          'docs',
          '## Docs\n\n- Before changing an area, read the matching file in `docs/` (architecture, api-contracts, data-models, debugging) and update it in the same change.',
        )
      : null,
    x.map
      ? region(
          'map',
          `## Codebase map\n\n- \`${x.map}\` maps the repo by area and size. Start there instead of listing directories.`,
        )
      : null,
    x.agents?.length
      ? region(
          'agents',
          [
            '## Subagents',
            '',
            x.agents.includes('explorer')
              ? '- Delegate broad searches to `explorer` (Haiku, read-only) so only its findings enter this context.'
              : null,
            x.agents.includes('debugger')
              ? '- For bugs and failing tests, run `/fix <symptom>`: it finds, diagnoses (via `debugger`), fixes, tests and retries.'
              : null,
            x.agents.includes('reviewer')
              ? '- Ask `reviewer` to check the diff before calling a non-trivial change done.'
              : null,
            x.agents.includes('test-writer')
              ? '- Use `test-writer` to add coverage for new behavior.'
              : null,
          ]
            .filter((l) => l !== null)
            .join('\n'),
        )
      : null,
    x.compress
      ? region(
          'compress',
          `## Large files\n\n- To skim a big file, run \`${NPX} compress --outline <path>\` (declarations with line numbers), then read only the ranges you need.`,
        )
      : null,
    x.search
      ? region(
          'search',
          '## Code search\n\n- For "where is X handled / defined / configured", call `search_code` (MCP server `code-search`) before grepping or opening files, then read only the line ranges it returns.\n- Before changing a file, `related_files` lists what imports it and its tests.',
        )
      : null,
    // HTML comments are stripped before CLAUDE.md reaches the model: a free note for humans.
    x.modelCheatsheet?.length
      ? region(
          'models',
          `<!--\nModels (for humans; not loaded into Claude's context):\n${x.modelCheatsheet.map((l) => `- ${l}`).join('\n')}\n-->`,
        )
      : null,
  ];
}

/**
 * Lean CLAUDE.md skeleton (well under the 200-line budget).
 * Managed regions hold facts derived from the repo; the rest belongs to the user.
 * Must stay free of dates and other per-run values: CLAUDE.md sits in the cached prompt prefix.
 */
export function renderClaudeMd(input: ClaudeMdInput): string {
  const parts = [
    `# ${input.name}`,
    '<!-- One or two sentences: what this project is, who uses it, what matters most. -->',
    stackRegion(input),
    commandsRegion(input.commands),
    '## Conventions\n\n<!-- Project rules Claude can\'t infer from the code, one line each. E.g. "Use the Result type for errors, never throw in services." -->',
    workflowRegion(),
    guardrailsRegion(input.guardrails),
    ...extraRegions(input.extras ?? {}),
    '## Gotchas\n\n<!-- Things that have bitten people before: flaky tests, env quirks, ordering constraints. -->',
  ];
  return parts.filter((p): p is string => p !== null).join('\n\n') + '\n';
}
