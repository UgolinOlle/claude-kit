/**
 * Bundles the whole CLI into one JavaScript file (dependencies inlined) at bin/claude-kit.mjs,
 * which is what the root package.json publishes, so `npm publish` works from the repo root
 * (it runs this script via `prepack`).
 *
 * Also assembles the same package in release/npm/claude-kit for the release workflow:
 *   bin/claude-kit.mjs
 *   package.json        the root one minus dev-only fields, so installs are instant
 *   README.md
 * The same file runs on Node (>=20) and Bun, on macOS, Linux and Windows.
 *
 * Usage: bun scripts/build-release.ts
 */
import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'release', 'npm', 'claude-kit');
const ENTRY = pkg.bin['claude-kit'];

/** Fields that only matter for developing claude-kit, not for installing it. */
const DEV_ONLY = ['scripts', 'devDependencies', 'lint-staged', 'packageManager'];

async function writeJson(path: string, data: unknown) {
  await Bun.write(path, JSON.stringify(data, null, 2) + '\n');
}

if (import.meta.main) {
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'index.ts')],
    target: 'node',
    format: 'esm',
    minify: true,
    banner: '#!/usr/bin/env node',
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('Bundling failed');
  }
  await rm(join(ROOT, 'bin'), { recursive: true, force: true });
  await Bun.write(join(ROOT, ENTRY), result.outputs[0]!);
  await chmod(join(ROOT, ENTRY), 0o755);

  await rm(join(ROOT, 'release'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(join(ROOT, 'bin'), join(OUT, 'bin'), { recursive: true });
  if (await Bun.file(join(ROOT, 'README.md')).exists()) {
    await cp(join(ROOT, 'README.md'), join(OUT, 'README.md'));
  }
  // npm provenance rejects a package whose `repository` doesn't match the repo that built it,
  // so `repository` is carried over as-is.
  await writeJson(
    join(OUT, 'package.json'),
    Object.fromEntries(Object.entries(pkg).filter(([key]) => !DEV_ONLY.includes(key))),
  );

  const size = Bun.file(join(ROOT, ENTRY)).size;
  console.log(
    `✔ ${pkg.name}@${pkg.version} → ${ENTRY}, ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`,
  );
}
