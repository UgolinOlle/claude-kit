import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { runAdd } from '../src/commands/add.ts';
import { buildContext } from '../src/core/context.ts';
import { MCP_TEMPLATES, mcpPlans } from '../src/generators/mcp.ts';
import { configureLogger } from '../src/utils/logger.ts';

import { tempProject } from './helpers.ts';

configureLogger({ silent: true });

/** Writes a template's files into a temp project and imports its tools.mjs. */
async function tools(template: 'data' | 'db' | 'logs') {
  const dir = await tempProject();
  for (const plan of await mcpPlans(await buildContext(dir), 'x', 'node', template))
    await Bun.write(join(dir, plan.path), plan.content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { dir, mod: (await import(join(dir, 'mcp/x/tools.mjs'))) as any };
}

describe('add mcp --template', () => {
  test('every template renders valid JavaScript with no placeholders left', async () => {
    const dir = await tempProject();
    const ctx = await buildContext(dir);
    for (const t of MCP_TEMPLATES) {
      for (const plan of await mcpPlans(ctx, 'demo', 'node', t)) {
        expect(plan.content, `${t}: ${plan.path}`).not.toContain('{{');
        if (plan.path.endsWith('.mjs')) {
          const file = join(dir, t, plan.path);
          await Bun.write(file, plan.content);
          const check = Bun.spawnSync(['node', '--check', file]);
          expect(check.exitCode, `${t}: ${plan.path}\n${check.stderr}`).toBe(0);
        }
      }
    }
  });

  test('db adds pg; unknown templates are refused', async () => {
    const dir = await tempProject();
    const plans = await mcpPlans(await buildContext(dir), 'db', 'node', 'db');
    const pkg = JSON.parse(plans.find((p) => p.path === 'mcp/db/package.json')!.content);
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@modelcontextprotocol/sdk',
      'pg',
      'zod',
    ]);
    const opts = {
      cwd: dir,
      dryRun: false,
      yes: true,
      force: false,
      json: false,
      verbose: false,
      with: [],
      without: [],
    };
    expect(await runAdd({ ...opts, template: 'graphql' }, ['mcp', 'x'])).toBe(2);
    expect(
      await runAdd({ ...opts, template: 'logs' }, ['mcp', 'logs'], {
        hookRuntime: 'node',
        interactive: false,
      }),
    ).toBe(0);
    expect(await Bun.file(join(dir, 'mcp/logs/tools.mjs')).exists()).toBe(true);
  });
});

describe('data template', () => {
  const CSV = [
    'id,merchant,amount,note',
    ...Array.from(
      { length: 200 },
      (_, i) => `${i},${i % 3 === 0 ? 'acme' : 'globex'},${10 + (i % 50)},"ok, fine"`,
    ),
    '200,shady,-25,refund',
    '201,shady,99999,"big ""one"""',
  ].join('\n');

  test('summarises instead of returning rows: stats, outliers, groups, sample', async () => {
    const { dir, mod } = await tools('data');
    await Bun.write(join(dir, 'tx.csv'), CSV);
    const r = await mod.analyzeCsv(dir, {
      path: 'tx.csv',
      value_column: 'amount',
      group_column: 'merchant',
    });
    expect(r.row_count).toBe(202);
    expect(r.columns.amount).toMatchObject({ type: 'number', min: -25, max: 99999 });
    expect(r.columns.merchant).toMatchObject({ type: 'text', distinct: 3 });
    expect(r.outliers.count).toBe(2);
    expect(r.outliers.top[0]).toMatchObject({
      merchant: 'shady',
      amount: '99999',
      note: 'big "one"',
    });
    expect(r.top_groups[0]).toEqual({ merchant: 'globex', count: 133 });
    expect(r.sample).toHaveLength(10);
    expect(r.sample[0].note).toBe('ok, fine');
  });

  test('refuses paths outside the project and unknown columns', async () => {
    const { dir, mod } = await tools('data');
    await Bun.write(join(dir, 'tx.csv'), CSV);
    await expect(mod.analyzeCsv(dir, { path: '../etc/passwd' })).rejects.toThrow(
      'outside the project',
    );
    await expect(mod.analyzeCsv(dir, { path: 'tx.csv', value_column: 'nope' })).rejects.toThrow(
      'Columns: id, merchant',
    );
  });
});

describe('db template', () => {
  async function sqlite() {
    const { dir, mod } = await tools('db');
    const file = join(dir, 'app.db');
    const db = new Database(file);
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)');
    for (let i = 0; i < 40; i++)
      db.run('INSERT INTO users (name, age) VALUES (?, ?)', [`u${i % 4}`, 20 + i]);
    db.close();
    return { mod, conn: await mod.connect(`sqlite:${file}`) };
  }

  test('read-only guard', async () => {
    const { mod } = await tools('db');
    expect(mod.checkReadOnly('select 1; ')).toBe('select 1');
    expect(mod.checkReadOnly('-- note\nWITH a AS (SELECT 1) SELECT * FROM a')).toContain('WITH');
    for (const sql of [
      'DELETE FROM users',
      'select 1; drop table users',
      '/* x */ update users set a=1',
      '',
    ])
      expect(() => mod.checkReadOnly(sql)).toThrow();
  });

  test('query returns a summary; schema is one line per table; writes fail even if they slip through', async () => {
    const { mod, conn } = await sqlite();
    const r = await mod.query(conn, 'SELECT * FROM users', 5);
    expect(r.row_count).toBe(40);
    expect(r.sample).toHaveLength(5);
    expect(r.columns.age).toMatchObject({ type: 'number', min: 20, max: 59 });
    expect(r.columns.name).toMatchObject({ type: 'text', distinct: 4 });
    expect(r.histogram.column).toBe('id');
    expect(r.histogram.buckets.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(
      40,
    );
    expect(await mod.describeSchema(conn)).toBe('users(id INTEGER, name TEXT, age INTEGER)');
    await expect(conn.all('DELETE FROM users')).rejects.toThrow(); // opened read-only
    await conn.close();
  });
});

describe('logs template', () => {
  const NOW = Date.parse('2026-10-12T12:00:00Z');
  const JSON_LOG = [
    { time: NOW - 3_600_000, level: 50, msg: 'db timeout after 3000 ms for user 42' },
    { time: NOW - 1_800_000, level: 50, msg: 'db timeout after 5000 ms for user 7' },
    { time: NOW - 600_000, level: 30, msg: 'request ok' },
    { time: NOW - 48 * 3_600_000, level: 50, msg: 'old failure' },
  ]
    .map((o) => JSON.stringify(o))
    .join('\n');
  const TEXT_LOG = [
    '2026-10-12T11:00:00Z ERROR payment failed id=0xdeadbeef reason="card declined"',
    '2026-10-12T11:30:00Z WARNING slow query 1200ms',
    '2026-10-12T11:45:00Z ERROR payment failed id=0xcafebabe reason="expired"',
  ].join('\n');

  async function setup() {
    const { dir, mod } = await tools('logs');
    await Bun.write(join(dir, 'logs/app.log'), JSON_LOG);
    await Bun.write(join(dir, 'logs/old/pay.log'), TEXT_LOG);
    await Bun.write(join(dir, 'node_modules/x/ignored.log'), 'ERROR nope');
    return { dir, mod, files: await mod.findLogFiles(dir) };
  }

  test('finds log files, parses JSON and text lines', async () => {
    const { dir, mod, files } = await setup();
    expect(files.map((f: string) => f.slice(dir.length + 1))).toEqual([
      'logs/app.log',
      'logs/old/pay.log',
    ]);
    expect(mod.parseLine('2026-10-12 11:30:00 WARNING slow')).toMatchObject({ level: 'WARN' });
    expect(mod.parseLine('{"ts": 1760270400, "severity": "error", "message": "x"}')).toMatchObject({
      level: 'ERROR',
      time: 1760270400000,
      message: 'x',
    });
  });

  test('get_errors groups by pattern within the window', async () => {
    const { dir, mod, files } = await setup();
    const r = await mod.getErrors(dir, files, { hours: 24 }, NOW);
    expect(r.error_count).toBe(4);
    expect(r.distinct_messages).toBe(2);
    expect(
      r.most_common.map((g: { count: number; pattern: string }) => [g.count, g.pattern]),
    ).toEqual([
      [2, 'db timeout after <n> ms for user <n>'],
      [2, '<time> ERROR payment failed id=<hex> reason=<str>'],
    ]);
    expect(r.most_common[0].first_seen).toBe('2026-10-12T11:00:00.000Z');
  });

  test('search_logs filters, sorts newest first and paginates', async () => {
    const { dir, mod, files } = await setup();
    const first = await mod.searchLogs(dir, files, { query: 'PAYMENT failed', limit: 1 }, NOW);
    expect(first.total_matches).toBe(2);
    expect(first.results[0].message).toContain('expired');
    expect(first).toMatchObject({ has_more: true, next_cursor: '1' });
    const second = await mod.searchLogs(
      dir,
      files,
      { query: 'payment', limit: 1, cursor: '1' },
      NOW,
    );
    expect(second).toMatchObject({ has_more: false });
    const warn = await mod.searchLogs(dir, files, { level: 'WARN', since_hours: 2 }, NOW);
    expect(warn.total_matches).toBe(5);
  });
});
