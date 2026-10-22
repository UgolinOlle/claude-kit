import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GlobalOptions } from '../src/cli.ts';
import { runAdd } from '../src/commands/add.ts';
import { runInit } from '../src/commands/init.ts';
import { loadManifest } from '../src/core/manifest.ts';
import { frontmatter } from '../src/core/memory.ts';
import { ROUTER_CLAUDEMD_LINE, routerPlans } from '../src/generators/extras.ts';
import { exists, readText } from '../src/utils/fsSafe.ts';
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
const add = (dir: string, extra: Partial<GlobalOptions> = {}, userDir?: string) =>
  runAdd(opts(dir, extra), ['model-router'], { hookRuntime: 'node', interactive: false, userDir });
const read = async (dir: string, p: string) => (await readText(join(dir, p)))!;
const fm = async (dir: string, p: string) => frontmatter(await read(dir, p))!;
const count = (text: string, needle: string) => text.split(needle).length - 1;

const QUICK = '.claude/agents/quick-fixer.md';
const DEEP = '.claude/agents/deep-worker.md';
const SKILL = '.claude/skills/model-router/SKILL.md';

describe('add model-router', () => {
  test('installs both agents and the skill with their frontmatter', async () => {
    const dir = await tempProject('bun-app');
    expect(await add(dir)).toBe(0);
    expect(await fm(dir, QUICK)).toMatchObject({
      name: 'quick-fixer',
      model: 'haiku',
      tools: 'Read, Edit, Grep, Glob, Bash',
    });
    const deep = await fm(dir, DEEP);
    expect(deep).toMatchObject({ name: 'deep-worker', model: 'opus' });
    expect(deep.tools).toBeUndefined(); // inherits every tool
    expect(await fm(dir, SKILL)).toMatchObject({ name: 'model-router' });
    const skill = await read(dir, SKILL);
    expect(skill).toContain('`quick-fixer`');
    expect(skill).toContain('**Unsure → `deep-worker`.**');
    expect(skill).toContain('TOO BIG:');
    expect(await read(dir, QUICK)).toContain('TOO BIG:');
    expect(await exists(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  test('re-running is idempotent', async () => {
    const dir = await tempProject('bun-app');
    expect(await add(dir, { claudeMd: true })).toBe(0);
    const before = await Promise.all([QUICK, DEEP, SKILL, 'CLAUDE.md'].map((p) => read(dir, p)));
    expect(await add(dir, { claudeMd: true })).toBe(0);
    const after = await Promise.all([QUICK, DEEP, SKILL, 'CLAUDE.md'].map((p) => read(dir, p)));
    expect(after).toEqual(before);
  });

  test('keeps edited files unless --force', async () => {
    const dir = await tempProject('bun-app');
    expect(await add(dir)).toBe(0);
    const edited = (await read(dir, QUICK)) + '\nAlways run the linter.\n';
    await writeFile(join(dir, QUICK), edited);

    expect(await add(dir, { smallModel: 'sonnet' })).toBe(0);
    expect(await read(dir, QUICK)).toBe(edited);
    expect(await add(dir, { smallModel: 'sonnet', force: true })).toBe(0);
    expect((await fm(dir, QUICK)).model).toBe('sonnet');
  });

  test('does not touch existing files it did not create', async () => {
    const dir = await tempProject('bun-app');
    await mkdir(join(dir, '.claude/agents'), { recursive: true });
    await writeFile(join(dir, QUICK), 'mine\n');
    expect(await add(dir)).toBe(0);
    expect(await read(dir, QUICK)).toBe('mine\n');
    expect(await exists(join(dir, DEEP))).toBe(true);
  });

  test('--dry-run writes nothing', async () => {
    const dir = await tempProject('bun-app');
    expect(await add(dir, { dryRun: true, claudeMd: true })).toBe(0);
    for (const p of [QUICK, DEEP, SKILL, 'CLAUDE.md'])
      expect(await exists(join(dir, p))).toBe(false);
  });

  test('model overrides, validated', async () => {
    const dir = await tempProject('bun-app');
    expect(await add(dir, { smallModel: 'sonnet', bigModel: 'inherit' })).toBe(0);
    expect((await fm(dir, QUICK)).model).toBe('sonnet');
    expect((await fm(dir, DEEP)).model).toBe('inherit');
    expect(await add(dir, { smallModel: 'gpt-4' })).toBe(2);
    expect(await add(dir, { bigModel: 'claude-opus-5-5' })).toBe(2);
    for (const plan of routerPlans({ small: 'haiku', big: 'opus' }))
      expect(plan.content).not.toContain('{{');
  });

  test('--claude-md appends one line to a hand-written CLAUDE.md, once', async () => {
    const dir = await tempProject('bun-app');
    await writeFile(join(dir, 'CLAUDE.md'), '# Mine\n\nKeep this.\n');
    expect(await add(dir, { claudeMd: true })).toBe(0);
    expect(await add(dir, { claudeMd: true })).toBe(0);
    const text = await read(dir, 'CLAUDE.md');
    expect(text.startsWith('# Mine\n\nKeep this.\n')).toBe(true);
    expect(count(text, ROUTER_CLAUDEMD_LINE)).toBe(1);
  });

  test('--claude-md on a CLAUDE.md that init manages survives sync', async () => {
    const dir = await tempProject('bun-app');
    expect(await runInit(opts(dir), { hookRuntime: 'node', interactive: false })).toBe(0);
    const generated = await read(dir, 'CLAUDE.md');
    expect(await add(dir, { claudeMd: true })).toBe(0);
    const text = await read(dir, 'CLAUDE.md');
    expect(count(text, ROUTER_CLAUDEMD_LINE)).toBe(1);
    expect(text).toContain(generated.split('\n')[0]!); // the rest of the file is still there
    expect((await loadManifest(dir)).files['CLAUDE.md']!.templateId).toBe('claudemd');

    expect(await runInit(opts(dir), { sync: true, hookRuntime: 'node', interactive: false })).toBe(
      0,
    );
    expect(count(await read(dir, 'CLAUDE.md'), ROUTER_CLAUDEMD_LINE)).toBe(1);
  });

  test('--global installs into the Claude Code user directory', async () => {
    const dir = await tempProject('bun-app');
    const home = await tempProject();
    expect(await add(dir, { global: true, claudeMd: true }, home)).toBe(0);
    expect((await fm(home, 'agents/quick-fixer.md')).name).toBe('quick-fixer');
    expect((await fm(home, 'agents/deep-worker.md')).name).toBe('deep-worker');
    expect((await fm(home, 'skills/model-router/SKILL.md')).name).toBe('model-router');
    expect(await read(home, 'CLAUDE.md')).toContain(ROUTER_CLAUDEMD_LINE);
    expect(await exists(join(dir, '.claude'))).toBe(false);
    expect(await add(dir, { global: true }, join(home, 'missing'))).toBe(1);
  });
});
