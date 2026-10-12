import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { GlobalOptions } from '../src/cli.ts';
import { runInit } from '../src/commands/init.ts';
import { buildContext } from '../src/core/context.ts';
import { readText } from '../src/utils/fsSafe.ts';
import { configureLogger } from '../src/utils/logger.ts';

import { tempProject } from './helpers.ts';

beforeAll(() => configureLogger({ silent: true }));

const ELIXIR_PACK = `
import { existsSync } from "node:fs";
import { join } from "node:path";

export default {
  id: "elixir",
  label: () => "Elixir",
  detect: (root) => (existsSync(join(root, "mix.exs")) ? { manager: "mix", evidence: ["mix.exs"], deps: ["phoenix"] } : null),
  ignore: ["_build/", "deps/", "*.beam"],
  protectedPaths: [{ pattern: "mix.lock", reason: "run mix deps.get instead" }],
  commands: () => [{ label: "test", cmd: "mix test" }],
};
`;

const opts = (cwd: string): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: true,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
});

async function elixirProject(packSpec: string, install: 'relative' | 'node_modules') {
  const dir = await tempProject();
  await Bun.write(join(dir, 'mix.exs'), 'defmodule App.MixProject do\nend\n');
  if (install === 'relative') await Bun.write(join(dir, 'tools/elixir-pack.mjs'), ELIXIR_PACK);
  else {
    await Bun.write(
      join(dir, 'node_modules/claude-kit-pack-elixir/package.json'),
      JSON.stringify({ name: 'claude-kit-pack-elixir', main: 'index.mjs' }),
    );
    await Bun.write(join(dir, 'node_modules/claude-kit-pack-elixir/index.mjs'), ELIXIR_PACK);
  }
  await Bun.write(join(dir, '.claude-kit/config.json'), JSON.stringify({ packs: [packSpec] }));
  return dir;
}

describe('external packs', () => {
  test.each([
    ['./tools/elixir-pack.mjs', 'relative'],
    ['claude-kit-pack-elixir', 'node_modules'],
  ] as const)('%s drives detection and every generator', async (spec, install) => {
    const dir = await elixirProject(spec, install);
    const ctx = await buildContext(dir);
    expect(ctx.stacks).toEqual([
      {
        id: 'elixir',
        confidence: 1,
        manager: 'mix',
        evidence: ['mix.exs'],
        deps: ['phoenix'],
        devDeps: [],
      },
    ]);

    await runInit(opts(dir), { hookRuntime: 'node', interactive: false });
    const md = (await readText(join(dir, 'CLAUDE.md')))!;
    expect(md).toContain('- Elixir (package manager: mix)');
    expect(md).toContain('mix test');
    expect(await readText(join(dir, '.claudeignore'))).toContain('_build/');
    expect(await readText(join(dir, '.claude/hooks/pre-edit.cjs'))).toContain(
      '"pattern": "mix.lock"',
    );
  });

  test('clear errors for missing, invalid or clashing packs', async () => {
    const dir = await tempProject();
    const config = (packs: string[]) =>
      Bun.write(join(dir, '.claude-kit/config.json'), JSON.stringify({ packs }));

    await config(['claude-kit-pack-nope']);
    await expect(buildContext(dir)).rejects.toThrow('Can\'t find pack "claude-kit-pack-nope"');

    await Bun.write(join(dir, 'bad.mjs'), "export default { id: 'Bad Id', label: () => 'x' };");
    await config(['./bad.mjs']);
    await expect(buildContext(dir)).rejects.toThrow(
      /invalid: `id` must be a lowercase string; `detect\(root\)` is required/,
    );

    await Bun.write(join(dir, 'node.mjs'), ELIXIR_PACK.replace('id: "elixir"', 'id: "node"'));
    await config(['./node.mjs']);
    await expect(buildContext(dir)).rejects.toThrow('uses the built-in id "node"');
  });
});
