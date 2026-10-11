import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Builds the npm release layout (option A — esbuild-style platform packages):
 *
 *   release/npm/claude-kit/              main package: Node launcher + optionalDependencies
 *   release/npm/@claude-kit/<os>-<cpu>/  one per platform: compiled Bun binary, gated by os/cpu
 *
 * Usage: bun scripts/build-release.ts [--current]   (--current = host platform only, for local testing)
 * Publishing is a separate, manual step: `npm publish` each platform dir first, then the main package.
 */
import { $ } from 'bun';

import pkg from '../package.json' with { type: 'json' };

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'release', 'npm');
const SCOPE = '@claude-kit';

interface Target {
  os: NodeJS.Platform;
  cpu: string;
  bunTarget: string;
}

export const TARGETS: Target[] = [
  { os: 'darwin', cpu: 'arm64', bunTarget: 'bun-darwin-arm64' },
  { os: 'darwin', cpu: 'x64', bunTarget: 'bun-darwin-x64' },
  { os: 'linux', cpu: 'x64', bunTarget: 'bun-linux-x64' },
  { os: 'linux', cpu: 'arm64', bunTarget: 'bun-linux-arm64' },
  { os: 'win32', cpu: 'x64', bunTarget: 'bun-windows-x64' },
];

const meta = {
  version: pkg.version,
  description: pkg.description,
};

async function writeJson(path: string, data: unknown) {
  await Bun.write(path, JSON.stringify(data, null, 2) + '\n');
}

async function buildPlatform(t: Target): Promise<string> {
  const name = `${SCOPE}/${t.os}-${t.cpu}`;
  const dir = join(OUT, name);
  const exe = t.os === 'win32' ? 'claude-kit.exe' : 'claude-kit';
  await mkdir(join(dir, 'bin'), { recursive: true });

  await $`${process.execPath} build ${join(ROOT, 'index.ts')} --compile --minify --target=${t.bunTarget} --outfile=${join(dir, 'bin', exe)}`.quiet();
  if (t.os !== 'win32') await chmod(join(dir, 'bin', exe), 0o755);

  await writeJson(join(dir, 'package.json'), {
    name,
    ...meta,
    description: `${meta.description} — prebuilt binary for ${t.os}-${t.cpu}`,
    os: [t.os],
    cpu: [t.cpu],
    files: ['bin'],
    preferUnplugged: true,
  });
  return name;
}

async function buildMain(platformNames: string[]) {
  const dir = join(OUT, 'claude-kit');
  await mkdir(join(dir, 'bin'), { recursive: true });
  await cp(join(ROOT, 'npm', 'launcher.js'), join(dir, 'bin', 'claude-kit.js'));
  await chmod(join(dir, 'bin', 'claude-kit.js'), 0o755);
  if (await Bun.file(join(ROOT, 'README.md')).exists())
    await cp(join(ROOT, 'README.md'), join(dir, 'README.md'));

  await writeJson(join(dir, 'package.json'), {
    name: 'claude-kit',
    ...meta,
    bin: { 'claude-kit': 'bin/claude-kit.js' },
    files: ['bin', 'README.md'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(platformNames.map((n) => [n, meta.version])),
  });
}

if (import.meta.main) {
  const currentOnly = Bun.argv.includes('--current');
  const targets = currentOnly
    ? TARGETS.filter((t) => t.os === process.platform && t.cpu === process.arch)
    : TARGETS;
  if (targets.length === 0)
    throw new Error(`No release target for ${process.platform}-${process.arch}`);

  await rm(OUT, { recursive: true, force: true });
  const names: string[] = [];
  for (const t of targets) {
    names.push(await buildPlatform(t));
    console.log(`✔ ${t.bunTarget}`);
  }
  // The main package always lists every platform so the version matrix stays complete.
  await buildMain(TARGETS.map((t) => `${SCOPE}/${t.os}-${t.cpu}`));
  console.log(`✔ claude-kit@${meta.version} → ${OUT}`);
}
