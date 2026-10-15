import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { buildContext, parseIgnoreFile } from '../src/core/context.ts';
import { detectMonorepo } from '../src/detect/monorepo.ts';
import { measureSize } from '../src/detect/size.ts';
import { detectStacks } from '../src/detect/stack.ts';
import { claudeMdPlan } from '../src/generators/claudemd.ts';

import { FIXTURES, tempProject } from './helpers.ts';

const fx = (name: string) => join(FIXTURES, name);

describe('stacks in subdirectories', () => {
  const write = async (files: Record<string, string>) => {
    const dir = await tempProject();
    for (const [path, body] of Object.entries(files)) await Bun.write(join(dir, path), body);
    return dir;
  };

  test('a Python service in a JS monorepo: detected with its directory and commands', async () => {
    const dir = await write({
      'package.json': JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }),
      'bun.lock': '',
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'apps/engine/package.json': JSON.stringify({ name: 'engine' }),
      'apps/engine/pyproject.toml':
        '[project]\nname = "engine"\ndependencies = ["httpx"]\n[dependency-groups]\ndev = ["pytest"]\n',
      'apps/engine/uv.lock': '',
      'tests/fixtures/sample/go.mod': 'module example.com/sample\n', // sample data, not the project
    });
    const ctx = await buildContext(dir);
    expect(ctx.stacks.map((s) => [s.id, s.manager, s.dir])).toEqual([
      ['node', 'bun', undefined], // packages of the root's own language aren't repeated
      ['python', 'uv', 'apps/engine'],
    ]);
    expect(ctx.stacks[1]!.evidence).toContain('apps/engine/pyproject.toml');
    expect(ctx.primaryStack?.id).toBe('node');
    const md = claudeMdPlan(ctx, ['claudemd']).content;
    expect(md).toContain('Python in `apps/engine/` (package manager: uv)');
    expect(md).toContain('cd apps/engine && uv run pytest');
  });

  test('nothing at the root: each side is found', async () => {
    const dir = await write({
      'frontend/package.json': JSON.stringify({ name: 'front' }),
      'backend/go.mod': 'module example.com/api\n',
    });
    expect((await buildContext(dir)).stacks.map((s) => `${s.id}@${s.dir}`).sort()).toEqual([
      'go@backend',
      'node@frontend',
    ]);
  });
});

describe('detectStacks', () => {
  test('bun app: manager from lockfile, deps and scripts', async () => {
    const [node] = await detectStacks(fx('bun-app'));
    expect(node?.id).toBe('node');
    expect(node?.manager).toBe('bun');
    expect(node?.deps).toEqual(['react', 'zod']);
    expect(node?.node?.scripts.test).toBe('bun test');
  });

  test('python app: uv manager, normalized PEP 508 names', async () => {
    const [py] = await detectStacks(fx('python-app'));
    expect(py?.id).toBe('python');
    expect(py?.manager).toBe('uv');
    expect(py?.deps).toEqual(['fastapi', 'sqlalchemy', 'pydantic']);
  });

  test("packageManager field is used when there's no lockfile", async () => {
    const dir = await tempProject('pnpm-monorepo');
    await rm(join(dir, 'pnpm-lock.yaml'));
    const [node] = await detectStacks(dir);
    expect(node?.manager).toBe('pnpm');
  });

  test('polyglot: go + rust both detected', async () => {
    const stacks = await detectStacks(fx('polyglot'));
    expect(stacks.map((s) => s.id).sort()).toEqual(['go', 'rust']);
    expect(stacks.find((s) => s.id === 'go')?.deps).toEqual([
      'github.com/spf13/cobra',
      'golang.org/x/sync',
    ]);
  });

  test('empty dir: nothing', async () => {
    expect(await detectStacks(await tempProject())).toEqual([]);
  });
});

describe('detectMonorepo', () => {
  test('pnpm workspace with negation + turbo', async () => {
    const mono = await detectMonorepo(fx('pnpm-monorepo'));
    expect(mono.isMonorepo).toBe(true);
    expect(mono.tools).toEqual(['pnpm', 'turbo']);
    expect(mono.packages).toEqual(['apps/web', 'packages/ui', 'packages/utils']);
  });

  test('cargo workspace members', async () => {
    const mono = await detectMonorepo(fx('polyglot'));
    expect(mono.tools).toContain('cargo');
    expect(mono.packages).toEqual(['crates/core']);
  });

  test('single package is not a monorepo', async () => {
    expect((await detectMonorepo(fx('bun-app'))).isMonorepo).toBe(false);
  });
});

describe('measureSize', () => {
  test('walk fallback skips node_modules and binaries', async () => {
    const dir = await tempProject('bun-app');
    await Bun.write(join(dir, 'node_modules/big/index.js'), 'x'.repeat(100_000));
    await Bun.write(join(dir, 'logo.png'), 'x'.repeat(100_000));
    await Bun.write(join(dir, 'blob.bin'), new Uint8Array([1, 0, 2]));
    const size = await measureSize(dir);
    expect(size.source).toBe('walk');
    expect(size.files).toBe(5); // .gitignore, bun.lock, package.json, tsconfig.json, src/index.ts
    expect(size.needsRag).toBe(false);
    expect(size.largest[0]?.path).toBe('package.json');
  });

  test('flags RAG above threshold', async () => {
    const dir = await tempProject();
    await Bun.write(join(dir, 'huge.txt'), 'a'.repeat(1_000_000));
    expect((await measureSize(dir)).needsRag).toBe(true);
  });
});

describe('buildContext', () => {
  test('collects gitignore, existing setup, lazy size', async () => {
    const ctx = await buildContext(fx('messy'));
    expect(ctx.existing.claudeMd).toBe(true);
    expect(ctx.existing.claudeignore).toBe(false);
    expect(ctx.primaryStack?.id).toBe('node');
    expect(ctx.size()).toBe(ctx.size()); // memoized
  });

  test('parseIgnoreFile drops comments and blanks', () => {
    expect(parseIgnoreFile('node_modules/\n\n# x\n dist \n')).toEqual(['node_modules/', 'dist']);
  });

  test('rejects a non-directory root', async () => {
    await expect(buildContext(fx('bun-app/package.json'))).rejects.toThrow('Not a directory');
  });
});
