import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { buildContext } from '../src/core/context.ts';
import { guardrails, hooksPlans, PRE_EDIT_PATH } from '../src/generators/hooks.ts';

import { tempProject } from './helpers.ts';

async function setup(fixture: string) {
  const dir = await tempProject(fixture);
  const [script] = hooksPlans(await guardrails(await buildContext(dir)), 'bun');
  await Bun.write(join(dir, PRE_EDIT_PATH), script!.content);
  return dir;
}

/** Run the generated hook the way Claude Code does: JSON on stdin, verdict via exit code + stderr. */
async function runHook(dir: string, input: unknown) {
  const proc = Bun.spawn([process.execPath, join(dir, PRE_EDIT_PATH)], {
    stdin: new TextEncoder().encode(typeof input === 'string' ? input : JSON.stringify(input)),
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
}

const edit = (dir: string, file_path: string) => ({
  tool_name: 'Edit',
  cwd: dir,
  tool_input: { file_path },
});

describe('pre-edit hook', () => {
  test.each([
    ['bun.lock', 2],
    ['src/index.ts', 0],
    ['packages/x/node_modules/a/index.js', 2],
    ['dist/out.js', 2],
    ['src/dist-utils.ts', 0],
    ['.env', 2],
    ['.env.local', 2],
    ['config/.env.production', 2],
    ['.env.example', 0],
  ])('node project: %s → exit %d', async (file, expected) => {
    const dir = await setup('bun-app');
    const { code, stderr } = await runHook(dir, edit(dir, file));
    expect(code).toBe(expected);
    if (expected === 2) expect(stderr).toContain('claude-kit guardrail');
  });

  test('absolute paths inside the project are matched too', async () => {
    const dir = await setup('bun-app');
    expect((await runHook(dir, edit(dir, join(dir, 'bun.lock')))).code).toBe(2);
  });

  test('python and rust rules come from their packs', async () => {
    const py = await setup('python-app');
    expect((await runHook(py, edit(py, 'uv.lock'))).code).toBe(2);
    expect((await runHook(py, edit(py, 'app/main.py'))).code).toBe(0);
    const poly = await setup('polyglot');
    expect((await runHook(poly, edit(poly, 'Cargo.lock'))).code).toBe(2);
    expect((await runHook(poly, edit(poly, 'crates/core/target/debug/x'))).code).toBe(2);
    expect((await runHook(poly, edit(poly, 'go.sum'))).code).toBe(2);
  });

  test('never blocks on paths outside the project, NotebookEdit paths are checked', async () => {
    const dir = await setup('bun-app');
    expect((await runHook(dir, edit(dir, '/etc/hosts'))).code).toBe(0);
    expect(
      (
        await runHook(dir, {
          tool_name: 'NotebookEdit',
          cwd: dir,
          tool_input: { notebook_path: 'dist/a.ipynb' },
        })
      ).code,
    ).toBe(2);
  });

  test('fails open on malformed input', async () => {
    const dir = await setup('bun-app');
    expect((await runHook(dir, 'not json')).code).toBe(0);
    expect((await runHook(dir, { tool_name: 'Edit', tool_input: {} })).code).toBe(0);
  });
});
