import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import type { GlobalOptions } from '../src/cli.ts';
import { formatGithub, runDoctor } from '../src/commands/doctor.ts';
import { runInit } from '../src/commands/init.ts';
import { buildRuleContext } from '../src/rules/context.ts';
import { runRules } from '../src/rules/index.ts';
import { matcherCovers } from '../src/rules/misc.ts';
import { readJson } from '../src/utils/fsSafe.ts';
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

const fakeConfig = (dir: string) => ({ configDir: join(dir, '.fake-config') });

async function audit(dir: string) {
  return runRules(await buildRuleContext(dir, { hookRuntime: 'node', memory: fakeConfig(dir) }));
}
const ids = async (dir: string) => (await audit(dir)).findings.map((f) => f.ruleId);
const doctor = (dir: string, extra: Partial<GlobalOptions> = {}) =>
  runDoctor(opts(dir, extra), { hookRuntime: 'node', memory: fakeConfig(dir), interactive: false });
const init = (dir: string) => runInit(opts(dir), { hookRuntime: 'node', interactive: false });

describe('rules', () => {
  test('a fresh claude-kit setup is clean', async () => {
    const dir = await tempProject('bun-app');
    await init(dir);
    const run = await audit(dir);
    expect(run.findings).toEqual([]);
    expect(run.score).toBe(100);
  });

  test.each(['python-app', 'pnpm-monorepo', 'polyglot'])(
    'init → clean audit: %s',
    async (fixture) => {
      const dir = await tempProject(fixture);
      await init(dir);
      expect((await audit(dir)).findings).toEqual([]);
    },
  );

  test('an empty project gets the three quick wins, all fixable', async () => {
    const dir = await tempProject('bun-app');
    const run = await audit(dir);
    expect(run.findings.map((f) => f.ruleId).sort()).toEqual([
      'claudemd/missing',
      'hooks/missing-guardrails',
      'ignore/missing',
    ]);
    expect(run.fixFeatures.sort()).toEqual(['claudeignore', 'claudemd', 'hooks']);
  });

  test('hand-written .claudeignore without deny rules is an error', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, '.claudeignore'), 'node_modules/\nsecrets/\n');
    const f = (await audit(dir)).findings.find((x) => x.ruleId === 'ignore/not-enforced');
    expect(f?.severity).toBe('error');
    expect(f?.message).toContain('2 of 2');
  });

  test("CLAUDE.md length: warn > 200, error > 500, HTML comments don't count", async () => {
    const dir = await tempProject('bun-app');
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `- rule ${i}`).join('\n');
    await Bun.write(join(dir, 'CLAUDE.md'), lines(250));
    expect(
      (await audit(dir)).findings.find((f) => f.ruleId === 'claudemd/too-long')?.severity,
    ).toBe('warn');
    await Bun.write(join(dir, 'CLAUDE.md'), lines(600));
    expect(
      (await audit(dir)).findings.find((f) => f.ruleId === 'claudemd/too-long')?.severity,
    ).toBe('error');
    await Bun.write(join(dir, 'CLAUDE.md'), `${lines(150)}\n<!--\n${lines(400)}\n-->\n`);
    expect(await ids(dir)).not.toContain('claudemd/too-long');
  });

  test('cache: dates flagged in content but not in comments; volatile imports flagged', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, 'CLAUDE.md'), '# x\n\nLast updated: 2026-01-02\n');
    const f = (await audit(dir)).findings.find((x) => x.ruleId === 'cache/volatile-content');
    expect(f?.line).toBe(3);
    await Bun.write(
      join(dir, 'CLAUDE.md'),
      '# x\n<!-- reviewed 2026-01-02 -->\nSee @task_context.md\n',
    );
    await Bun.write(join(dir, 'task_context.md'), 'current task');
    const found = await ids(dir);
    expect(found).not.toContain('cache/volatile-content');
    expect(found).toContain('cache/volatile-import');
  });

  test('missing @import reported with its line', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, 'CLAUDE.md'), '# x\nsee @docs/nope.md\n');
    const f = (await audit(dir)).findings.find((x) => x.ruleId === 'claudemd/missing-import');
    expect(f).toMatchObject({ file: 'CLAUDE.md', line: 2 });
  });

  test('invalid settings.json is an error and suppresses dependent checks', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, '.claude/settings.json'), '{ nope');
    await Bun.write(join(dir, '.claudeignore'), 'dist/\n');
    const found = await ids(dir);
    expect(found).toContain('settings/invalid-json');
    expect(found).not.toContain('ignore/not-enforced');
    expect(found).not.toContain('hooks/missing-guardrails');
  });

  test('hook matcher semantics', () => {
    expect(matcherCovers(undefined, 'Edit')).toBe(true);
    expect(matcherCovers('*', 'Edit')).toBe(true);
    expect(matcherCovers('Edit|Write', 'Write')).toBe(true);
    expect(matcherCovers('Bash', 'Edit')).toBe(false);
    expect(matcherCovers('Edit.*', 'Edit')).toBe(true);
    expect(matcherCovers('mcp__.*', 'Edit')).toBe(false);
  });
});

describe('doctor command', () => {
  test('--check exits 1 on errors, 0 below the threshold', async () => {
    const messy = await tempProject('messy');
    expect(await doctor(messy, { check: true })).toBe(1);
    const clean = await tempProject('bun-app');
    expect(await doctor(clean, { check: true })).toBe(0); // only warns/infos
    expect(await doctor(clean, { check: true, failOn: 'warn' })).toBe(1);
  });

  test("--fix sets up what's missing and leaves a clean audit", async () => {
    const dir = await tempProject('bun-app');
    expect(await doctor(dir, { fix: true })).toBe(0);
    expect((await audit(dir)).score).toBe(100);
  });

  test('--fix enforces a hand-written .claudeignore without dropping its lines', async () => {
    const dir = await tempProject('messy');
    await Bun.write(join(dir, '.claudeignore'), '# mine\nsecrets/\n');
    await doctor(dir, { fix: true });
    const deny = (await readJson<{ permissions: { deny: string[] } }>(
      join(dir, '.claude/settings.json'),
    ))!.permissions.deny;
    expect(deny).toContain('Read(**/secrets/**)');
    expect(await Bun.file(join(dir, '.claudeignore')).text()).toStartWith('# mine\nsecrets/\n');
    expect(await ids(dir)).not.toContain('ignore/not-enforced');
  });

  test('--fix --dry-run writes nothing', async () => {
    const dir = await tempProject('bun-app');
    await doctor(dir, { fix: true, dryRun: true });
    expect(await Bun.file(join(dir, 'CLAUDE.md')).exists()).toBe(false);
  });

  test('rejects bad flag combinations', async () => {
    const dir = await tempProject('bun-app');
    expect(await doctor(dir, { fix: true, check: true })).toBe(2);
    expect(await doctor(dir, { format: 'xml' })).toBe(2);
    expect(await doctor(dir, { check: true, failOn: 'fatal' })).toBe(2);
  });

  test('json output is machine-readable', async () => {
    const dir = await tempProject('bun-app');
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    await doctor(dir, { json: true });
    const out = JSON.parse(spy.mock.calls.map((c) => c.join(' ')).join('\n'));
    spy.mockRestore();
    expect(out.score).toBe(80);
    expect(out.findings).toHaveLength(3);
  });
});

describe('formatGithub', () => {
  test('maps severities and escapes properties and data', () => {
    const out = formatGithub([
      { ruleId: 'a/b', severity: 'warn', message: '50% done\nnext', file: 'x,y:z.md', line: 3 },
      { ruleId: 'c', severity: 'info', message: 'note' },
    ]);
    expect(out).toBe(
      '::warning file=x%2Cy%3Az.md,line=3,title=a/b::50%25 done%0Anext\n::notice title=c::note',
    );
  });
});

describe('config', () => {
  test('rule overrides and path excludes from .claude-kit/config.json', async () => {
    const dir = await tempProject('bun-app');
    await init(dir);
    await Bun.write(
      join(dir, 'fixtures/old/CLAUDE.md'),
      Array.from({ length: 600 }, (_, i) => `- ${i}`).join('\n'),
    );
    await Bun.write(
      join(dir, 'CLAUDE.md'),
      (await Bun.file(join(dir, 'CLAUDE.md')).text()) + '\nLast updated 2026-01-01\n',
    );
    expect((await ids(dir)).sort()).toEqual(['cache/volatile-content', 'claudemd/too-long']);

    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ rules: { 'cache/volatile-content': 'info' }, exclude: ['fixtures/**'] }),
    );
    const run = await audit(dir);
    expect(run.findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['cache/volatile-content', 'info'],
    ]);
    expect(run.score).toBe(100);

    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ rules: { 'cache/volatile-content': 'off' }, exclude: ['fixtures/**'] }),
    );
    expect(await ids(dir)).toEqual([]);
  });

  test('invalid levels are rejected', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, '.claude-kit/config.json'), JSON.stringify({ rules: { x: 'loud' } }));
    await expect(audit(dir)).rejects.toThrow('invalid level "loud"');
  });
});
