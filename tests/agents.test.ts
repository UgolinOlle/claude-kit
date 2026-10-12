import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { runInit } from '../src/commands/init.ts';
import { frontmatter } from '../src/core/memory.ts';
import { AGENTS, agentPlans, FIX_SKILL_PATH } from '../src/generators/extras.ts';

import { tempProject } from './helpers.ts';

const init = (dir: string, preset: string, extra: string[] = []) =>
  runInit(
    {
      cwd: dir,
      dryRun: false,
      yes: true,
      force: false,
      json: false,
      verbose: false,
      preset,
      with: extra,
      without: [],
    },
    { hookRuntime: 'node', interactive: false },
  );

describe('subagents and /fix', () => {
  test('every agent has valid frontmatter; debugger is read-only', () => {
    for (const [name, body] of Object.entries(AGENTS)) {
      const fm = frontmatter(body)!;
      expect(fm.name).toBe(name);
      expect(String(fm.description).length).toBeGreaterThan(30);
    }
    const debuggerTools = String(frontmatter(AGENTS.debugger!)!.tools);
    expect(debuggerTools).not.toMatch(/Edit|Write/);
  });

  test('the full preset writes the agents, the /fix skill and a CLAUDE.md pointer', async () => {
    const dir = await tempProject('bun-app');
    expect(await init(dir, 'full')).toBe(0);
    for (const name of ['explorer', 'debugger', 'reviewer', 'test-writer'])
      expect(await Bun.file(join(dir, `.claude/agents/${name}.md`)).exists()).toBe(true);
    const skill = await Bun.file(join(dir, FIX_SKILL_PATH)).text();
    expect(frontmatter(skill)!.name).toBe('fix');
    expect(skill).toContain('# Fix: $ARGUMENTS');
    expect(skill).toContain('`explorer` agent');
    expect(skill).toContain('2 failed retries');
    expect(skill).toContain('.claude/context/task_context.md');
    expect(await Bun.file(join(dir, 'CLAUDE.md')).text()).toContain('`/fix <symptom>`');
  });

  test('every generated skill and agent has parseable frontmatter', async () => {
    const { compressPlans } = await import('../src/generators/extras.ts');
    for (const plan of [...agentPlans({ taskContext: 'x.md' }), ...compressPlans()]) {
      const fm = frontmatter(plan.content);
      expect(fm, plan.path).not.toBeNull();
      expect(typeof fm!.name, plan.path).toBe('string');
      expect(typeof fm!.description, plan.path).toBe('string');
    }
  });

  test('/fix uses code search for the find step when the search feature is on', () => {
    const fix = (search: boolean) => agentPlans({ search }).find((p) => p.path === FIX_SKILL_PATH)!;
    expect(fix(true).content).toContain('`search_code`');
    expect(fix(false).content).not.toContain('search_code');
    expect(fix(false).content).not.toContain('{{');
  });
});
