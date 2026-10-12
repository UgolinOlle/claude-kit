import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { GlobalOptions } from '../src/cli.ts';
import { runAdd } from '../src/commands/add.ts';
import { runInit } from '../src/commands/init.ts';
import { compressText, outlineText } from '../src/core/compress.ts';
import { buildRuleContext } from '../src/rules/context.ts';
import { runRules } from '../src/rules/index.ts';
import { exists, readJson, readText } from '../src/utils/fsSafe.ts';
import { configureLogger } from '../src/utils/logger.ts';

import { tempProject } from './helpers.ts';

beforeAll(() => configureLogger({ silent: true }));

const opts = (cwd: string, extra: Partial<GlobalOptions> = {}): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: true,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
  ...extra,
});
const init = (dir: string, extra: Partial<GlobalOptions> = {}) =>
  runInit(opts(dir, extra), { hookRuntime: 'node', interactive: false });
const read = async (dir: string, p: string) => (await readText(join(dir, p)))!;

async function runScript(path: string, input: unknown, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, path], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return { code: await proc.exited, stdout: await new Response(proc.stdout).text() };
}

describe('full preset', () => {
  test('generates everything, is idempotent, and audits clean', async () => {
    const dir = await tempProject('pnpm-monorepo');
    expect(await init(dir, { preset: 'full' })).toBe(0);
    for (const f of [
      '.claude/context/task_context.md',
      '.claude/context/conversation_memory.md',
      '.claude/hooks/context-snapshot.cjs',
      '.claude/hooks/context-guard.cjs',
      '.claude/statusline/token-budget.cjs',
      '.claude/agents/explorer.md',
      '.claude/agents/reviewer.md',
      '.claude/agents/test-writer.md',
      'docs/architecture.md',
      'docs/debugging.md',
    ]) {
      expect(await exists(join(dir, f))).toBe(true);
    }
    expect(await exists(join(dir, 'docs/INDEX.md'))).toBe(false); // small repo: no map

    const s = (await readJson<Record<string, any>>(join(dir, '.claude/settings.json')))!;
    expect(s.model).toBe('opusplan');
    expect(s.statusLine.command).toContain('token-budget.cjs');
    expect(Object.keys(s.hooks).sort()).toEqual([
      'PostCompact',
      'PreToolUse',
      'SessionStart',
      'UserPromptSubmit',
    ]);
    expect(s.hooks.SessionStart[0].matcher).toBe('compact');

    const md = await read(dir, 'CLAUDE.md');
    expect(md).toContain('task_context.md');
    expect(md).toContain('`explorer`');
    expect(md).not.toContain('INDEX.md');
    expect(await read(dir, 'docs/architecture.md')).toContain('`packages/ui/`');

    const snapshot = await Promise.all(
      ['.claude/settings.json', 'CLAUDE.md', 'docs/architecture.md'].map((f) => read(dir, f)),
    );
    await init(dir);
    expect(
      await Promise.all(
        ['.claude/settings.json', 'CLAUDE.md', 'docs/architecture.md'].map((f) => read(dir, f)),
      ),
    ).toEqual(snapshot);

    const run = await runRules(
      await buildRuleContext(dir, {
        hookRuntime: 'node',
        memory: { configDir: join(dir, '.cfg') },
      }),
    );
    expect(run.findings).toEqual([]);
  });

  test("the models cheatsheet costs no tokens (it's an HTML comment)", async () => {
    const dir = await tempProject('bun-app');
    await init(dir, { preset: 'standard' });
    const ctx = await buildRuleContext(dir, {
      hookRuntime: 'node',
      memory: { configDir: join(dir, '.cfg') },
    });
    const claudeMd = ctx.memory.find((f) => f.display === 'CLAUDE.md')!;
    expect(claudeMd.raw).toContain('Models (for humans');
    expect(claudeMd.content).not.toContain('Models (for humans');
  });

  test('seeded docs are never overwritten, even after edits', async () => {
    const dir = await tempProject('bun-app');
    await init(dir, { preset: 'standard' });
    await Bun.write(join(dir, 'docs/architecture.md'), '# Mine\n');
    await init(dir, { force: true });
    expect(await read(dir, 'docs/architecture.md')).toBe('# Mine\n');
  });

  test('removing a feature drops its CLAUDE.md section', async () => {
    const dir = await tempProject('bun-app');
    await init(dir, { preset: 'full' });
    await init(dir, { preset: 'full', without: ['agents'] });
    expect(await read(dir, 'CLAUDE.md')).not.toContain('## Subagents');
  });

  test('large repos get a codebase map and a pointer to it', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, 'src/generated/huge.ts'), 'x'.repeat(800_000));
    await init(dir, { preset: 'full' });
    const map = await read(dir, 'docs/INDEX.md');
    expect(map).toContain('<!-- claude-kit:begin map -->');
    expect(map).toContain('`src/generated/huge.ts`');
    expect(await read(dir, 'CLAUDE.md')).toContain('docs/INDEX.md');
  });
});

describe('snapshot hook', () => {
  async function setup() {
    const dir = await tempProject('bun-app');
    await init(dir, { preset: 'standard' });
    return { dir, hook: join(dir, '.claude/hooks/context-snapshot.cjs') };
  }

  test('PostCompact saves the summary, git-ignored, keeping the last 10', async () => {
    const { dir, hook } = await setup();
    for (let i = 0; i < 12; i++) {
      const r = await runScript(
        hook,
        {
          hook_event_name: 'PostCompact',
          session_id: `s${i}`,
          trigger: 'auto',
          compact_summary: `summary ${i}`,
        },
        { CLAUDE_PROJECT_DIR: dir },
      );
      expect(r.code).toBe(0);
      await Bun.sleep(2); // distinct timestamps
    }
    const snapDir = join(dir, '.claude/context/snapshots');
    const files = (await readdir(snapDir)).filter((f) => f.endsWith('.md') && f !== 'latest.md');
    expect(files).toHaveLength(10);
    expect(await read(snapDir, 'latest.md')).toContain('summary 11');
    expect(await read(snapDir, '.gitignore')).toBe('*\n');
  });

  test('SessionStart(compact) re-injects task context only when it has real content', async () => {
    const { dir, hook } = await setup();
    const input = { hook_event_name: 'SessionStart', source: 'compact' };
    expect((await runScript(hook, input, { CLAUDE_PROJECT_DIR: dir })).stdout).toBe('');
    await Bun.write(
      join(dir, '.claude/context/task_context.md'),
      '# Task context\n\n## Goal\n\nShip the export button.\n',
    );
    const out = (await runScript(hook, input, { CLAUDE_PROJECT_DIR: dir })).stdout;
    expect(out).toContain('Ship the export button.');
  });
});

describe('budget status line', () => {
  test('renders context, cache, cost and budget colors', async () => {
    const dir = await tempProject('bun-app');
    await init(dir, { preset: 'full' });
    const script = join(dir, '.claude/statusline/token-budget.cjs');
    const input = {
      model: { display_name: 'Sonnet' },
      context_window: {
        used_percentage: 85,
        total_input_tokens: 160000,
        total_output_tokens: 10000,
        context_window_size: 200000,
      },
      prompt_cache: { caching_observed: true, hit_ratio: 0.91, warm: true, misses: 1 },
      cost: { total_cost_usd: 1.9 },
    };
    const { stdout } = await runScript(script, input, {
      NO_COLOR: '1',
      CLAUDE_KIT_BUDGET_USD: '2',
    });
    expect(stdout.trim()).toBe(
      'ctx 85% ▓▓▓▓▓▓▓▓▓░ 170K/200K → /compact · cache 91% warm (1 miss) · $1.90/$2.00 · Sonnet',
    );
    expect((await runScript(script, {}, { NO_COLOR: '1' })).stdout.trim()).toBe('');
  });
});

describe('add mcp', () => {
  test('scaffolds a server and keeps existing .mcp.json servers', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { github: { command: 'gh' } } }),
    );
    expect(
      await runAdd(opts(dir), ['mcp', 'tools'], { hookRuntime: 'node', interactive: false }),
    ).toBe(0);
    expect(
      await runAdd(opts(dir), ['mcp', 'db'], { hookRuntime: 'node', interactive: false }),
    ).toBe(0);
    const mcp = (await readJson<{ mcpServers: Record<string, { args?: string[] }> }>(
      join(dir, '.mcp.json'),
    ))!;
    expect(Object.keys(mcp.mcpServers)).toEqual(['github', 'tools', 'db']);
    expect(mcp.mcpServers.tools!.args).toEqual(['${CLAUDE_PROJECT_DIR:-.}/mcp/tools/server.mjs']);
    expect(await read(dir, 'mcp/tools/server.mjs')).toContain('new McpServer({ name: "tools"');
  });

  test('validates names and refuses duplicates', async () => {
    const dir = await tempProject('bun-app');
    const add = (args: string[]) =>
      runAdd(opts(dir), args, { hookRuntime: 'node', interactive: false });
    expect(await add(['mcp', 'Bad_Name'])).toBe(2);
    expect(await add(['widget', 'x'])).toBe(2);
    expect(await add(['mcp', 'x'])).toBe(0);
    expect(await add(['mcp', 'x'])).toBe(1);
  });
});

describe('compress', () => {
  test('strips comments but not comment-like text inside strings', () => {
    const src = `const url = "http://x.dev"; // trailing\n/* block\n comment */\nconst s = '/* not a comment */';\n\n\nfn(); // done\n`;
    expect(compressText('a.ts', src)).toBe(
      `const url = "http://x.dev";\nconst s = '/* not a comment */';\nfn();`,
    );
  });

  test('hash languages: keeps shebang and # inside strings, YAML colors', () => {
    expect(compressText('a.py', `#!/usr/bin/env python\n# comment\nx = "#not"  # real\n`)).toBe(
      `#!/usr/bin/env python\nx = "#not"`,
    );
    expect(compressText('a.yaml', `color: "#fff" # c\nbg: x#y\n`)).toBe(`color: "#fff"\nbg: x#y`);
  });

  test('json is minified, markdown loses comments', () => {
    expect(compressText('a.json', '{\n  "a": [1, 2]\n}\n')).toBe('{"a":[1,2]}');
    expect(compressText('a.md', '# T\n<!-- note -->\n\n\n\ntext\n')).toBe('# T\n\ntext');
  });

  test('outline lists declarations with line numbers', () => {
    const ts = `import x from "y";\n\nexport function a() {\n  return 1;\n}\n\nexport class B {\n  async run(input: string): Promise<void> {\n    if (x) {\n    }\n  }\n}\nconst c = () => 1;\n`;
    expect(outlineText('a.ts', ts)).toBe(
      ` 3: export function a()\n 7: export class B\n 8:   async run(input: string): Promise<void>\n13: const c = () => 1;`,
    );
    expect(outlineText('a.py', 'class A:\n    def f(self):\n        pass\n')).toBe(
      '1: class A:\n2:     def f(self):',
    );
    expect(outlineText('a.txt', 'x')).toBeNull();
  });
});
