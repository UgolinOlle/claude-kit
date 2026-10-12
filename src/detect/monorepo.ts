import { join } from 'node:path';

import { exists, isDir, readJson, readText } from '../utils/fsSafe.ts';
import { glob, globMatcher, parseToml, parseYaml } from '../utils/runtime.ts';

export interface MonorepoInfo {
  isMonorepo: boolean;
  /** Workspace mechanisms found, e.g. ["pnpm", "turbo"]. */
  tools: string[];
  /** Workspace globs as declared. */
  patterns: string[];
  /** Resolved package directories, relative to root, sorted. */
  packages: string[];
}

const SKIP = /(^|\/)(node_modules|\.git|target|dist|build)(\/|$)/;

async function expandDirGlobs(root: string, patterns: string[]): Promise<string[]> {
  const out = new Set<string>();
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => globMatcher(p.slice(1).replace(/\/$/, '')));

  for (const raw of include) {
    const pattern = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (!/[*?[{]/.test(pattern)) {
      if (await isDir(join(root, pattern))) out.add(pattern);
      continue;
    }
    for (const match of await glob(pattern, {
      cwd: root,
      onlyFiles: false,
      ignore: ['**/node_modules/**'],
    })) {
      if (SKIP.test(match)) continue;
      if (exclude.some((matches) => matches(match))) continue;
      if (await isDir(join(root, match))) out.add(match);
    }
  }
  return [...out].sort();
}

export async function detectMonorepo(root: string): Promise<MonorepoInfo> {
  const tools: string[] = [];
  const patterns: string[] = [];

  const pnpmWs = await readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpmWs !== null) {
    tools.push('pnpm');
    try {
      const doc = parseYaml(pnpmWs) as { packages?: string[] } | null;
      patterns.push(...(doc?.packages ?? []));
    } catch {
      // ignore malformed yaml
    }
  }

  const pkg = await readJson<{ workspaces?: string[] | { packages?: string[] } }>(
    join(root, 'package.json'),
  );
  const ws = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (ws?.length) {
    tools.push('workspaces');
    patterns.push(...ws);
  }

  const cargo = await readText(join(root, 'Cargo.toml'));
  if (cargo !== null) {
    try {
      const members = (parseToml(cargo) as { workspace?: { members?: string[] } }).workspace
        ?.members;
      if (members?.length) {
        tools.push('cargo');
        patterns.push(...members);
      }
    } catch {
      // ignore malformed toml
    }
  }

  const gowork = await readText(join(root, 'go.work'));
  if (gowork !== null) {
    tools.push('go-work');
    const block = gowork.match(/use\s*\(([\s\S]*?)\)/)?.[1];
    const uses = block
      ? block.split('\n')
      : [...gowork.matchAll(/^use\s+(\S+)/gm)].map((m) => m[1]!);
    patterns.push(...uses.map((u) => u.trim()).filter((u) => u && !u.startsWith('//')));
  }

  for (const [file, tool] of [
    ['turbo.json', 'turbo'],
    ['nx.json', 'nx'],
    ['lerna.json', 'lerna'],
  ] as const) {
    if (await exists(join(root, file))) tools.push(tool);
  }

  const packages = await expandDirGlobs(root, patterns);
  return {
    isMonorepo: packages.length > 0 || tools.some((t) => ['turbo', 'nx', 'lerna'].includes(t)),
    tools,
    patterns,
    packages,
  };
}
