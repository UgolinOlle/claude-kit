import { dirname, join } from 'node:path';

import { exists, readJson, readText } from '../utils/fsSafe.ts';
import { glob, parseToml } from '../utils/runtime.ts';

export type BuiltinStackId = 'node' | 'python' | 'go' | 'rust';
/** Built-in ids plus whatever external packs declare. */
export type StackId = BuiltinStackId | (string & {});

export interface NodeDetails {
  name?: string;
  scripts: Record<string, string>;
  /** tsconfig.json present or typescript declared. */
  typescript: boolean;
}

export interface StackInfo {
  id: StackId;
  /** 0..1 — several stacks can apply to one repo. */
  confidence: number;
  /** Package manager / toolchain, e.g. "bun", "pnpm", "uv", "cargo". */
  manager: string;
  /** Files that triggered detection, relative to root. */
  evidence: string[];
  /** Subdirectory the stack lives in (a monorepo package, `backend/`…); absent at the root. */
  dir?: string;
  /** Project name from the manifest, if declared. */
  name?: string;
  /** Runtime dependency names (best effort). */
  deps: string[];
  /** Dev/test/optional dependency names (best effort). */
  devDeps: string[];
  node?: NodeDetails;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function firstExisting(root: string, files: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const f of files) if (await exists(join(root, f))) found.push(f);
  return found;
}

async function detectNode(root: string): Promise<StackInfo | null> {
  const pkg = await readJson<PackageJson>(join(root, 'package.json'));
  if (!pkg) return null;

  const lockfiles: Record<string, string> = {
    'bun.lock': 'bun',
    'bun.lockb': 'bun',
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'package-lock.json': 'npm',
  };
  const locks = await firstExisting(root, Object.keys(lockfiles));
  const fromField = pkg.packageManager?.split('@')[0];
  const manager = (locks[0] && lockfiles[locks[0]]) ?? fromField ?? 'npm';

  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const typescript =
    deps.includes('typescript') ||
    devDeps.includes('typescript') ||
    (await exists(join(root, 'tsconfig.json')));
  return {
    id: 'node',
    confidence: 1,
    manager,
    evidence: ['package.json', ...locks],
    name: pkg.name,
    deps,
    devDeps,
    node: { name: pkg.name, scripts: pkg.scripts ?? {}, typescript },
  };
}

interface PyProject {
  project?: {
    name?: string;
    dependencies?: string[];
    'optional-dependencies'?: Record<string, string[]>;
  };
  'dependency-groups'?: Record<string, unknown[]>;
  tool?: {
    uv?: { 'dev-dependencies'?: string[] };
    poetry?: {
      name?: string;
      dependencies?: Record<string, unknown>;
      'dev-dependencies'?: Record<string, unknown>;
      group?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
  };
}

/** Strip version specifiers / extras from a PEP 508 requirement: "fastapi[all]>=0.1" → "fastapi". */
function pyName(req: string): string {
  return req
    .trim()
    .split(/[\s[<>=!~;@]/)[0]!
    .toLowerCase();
}

async function detectPython(root: string): Promise<StackInfo | null> {
  const evidence = await firstExisting(root, [
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'Pipfile',
  ]);
  if (evidence.length === 0) return null;

  const managers: Record<string, string> = {
    'uv.lock': 'uv',
    'poetry.lock': 'poetry',
    'Pipfile.lock': 'pipenv',
  };
  const locks = await firstExisting(root, Object.keys(managers));
  let manager =
    (locks[0] && managers[locks[0]]) ?? (evidence.includes('Pipfile') ? 'pipenv' : 'pip');

  const deps = new Set<string>();
  const devDeps = new Set<string>();
  let name: string | undefined;
  const pyproject = await readText(join(root, 'pyproject.toml'));
  if (pyproject) {
    try {
      const toml = parseToml(pyproject) as PyProject;
      name = toml.project?.name ?? toml.tool?.poetry?.name;
      for (const d of toml.project?.dependencies ?? []) deps.add(pyName(d));
      const poetry = toml.tool?.poetry;
      if (poetry?.dependencies) {
        if (manager === 'pip') manager = 'poetry';
        for (const d of Object.keys(poetry.dependencies))
          if (d !== 'python') deps.add(d.toLowerCase());
      }
      const devLists: unknown[] = [
        ...Object.values(toml['dependency-groups'] ?? {}),
        ...Object.values(toml.project?.['optional-dependencies'] ?? {}),
        toml.tool?.uv?.['dev-dependencies'] ?? [],
      ];
      for (const list of devLists) {
        if (Array.isArray(list))
          for (const d of list) if (typeof d === 'string') devDeps.add(pyName(d));
      }
      const poetryDev = [
        poetry?.['dev-dependencies'],
        ...Object.values(poetry?.group ?? {}).map((g) => g.dependencies),
      ];
      for (const group of poetryDev)
        for (const d of Object.keys(group ?? {})) devDeps.add(d.toLowerCase());
    } catch {
      // malformed pyproject — detection still counts, deps stay empty
    }
  }
  const addRequirements = (text: string | null, into: Set<string>) => {
    for (const line of text?.split('\n') ?? []) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('-')) into.add(pyName(t));
    }
  };
  addRequirements(await readText(join(root, 'requirements.txt')), deps);
  for (const f of [
    'requirements-dev.txt',
    'requirements_dev.txt',
    'dev-requirements.txt',
    'requirements-test.txt',
  ]) {
    addRequirements(await readText(join(root, f)), devDeps);
  }

  return {
    id: 'python',
    confidence: evidence.includes('pyproject.toml') ? 1 : 0.9,
    manager,
    evidence: [...evidence, ...locks],
    name,
    deps: [...deps],
    devDeps: [...devDeps].filter((d) => !deps.has(d)),
  };
}

async function detectGo(root: string): Promise<StackInfo | null> {
  const gomod = await readText(join(root, 'go.mod'));
  if (gomod === null) return null;
  const deps = [...gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v/gm)].map(
    (m) => m[1]!,
  );
  const name = gomod
    .match(/^module\s+(\S+)/m)?.[1]
    ?.split('/')
    .pop();
  return {
    id: 'go',
    confidence: 1,
    manager: 'go',
    evidence: ['go.mod'],
    name,
    deps,
    devDeps: [],
  };
}

async function detectRust(root: string): Promise<StackInfo | null> {
  const cargo = await readText(join(root, 'Cargo.toml'));
  if (cargo === null) return null;
  let deps: string[] = [];
  let devDeps: string[] = [];
  let name: string | undefined;
  try {
    const toml = parseToml(cargo) as {
      package?: { name?: string };
      dependencies?: Record<string, unknown>;
      'dev-dependencies'?: Record<string, unknown>;
    };
    name = toml.package?.name;
    deps = Object.keys(toml.dependencies ?? {});
    devDeps = Object.keys(toml['dev-dependencies'] ?? {});
  } catch {
    // keep detection, skip deps
  }
  return {
    id: 'rust',
    confidence: 1,
    manager: 'cargo',
    evidence: ['Cargo.toml'],
    name,
    deps,
    devDeps,
  };
}

export type Detector = (root: string) => Promise<StackInfo | null> | StackInfo | null;

/** Detect every stack present at `root`, highest confidence first. */
export async function detectStacks(root: string, extra: Detector[] = []): Promise<StackInfo[]> {
  const results = await Promise.all([
    detectNode(root),
    detectPython(root),
    detectGo(root),
    detectRust(root),
    ...extra.map((d) => d(root)),
  ]);
  return results
    .filter((s): s is StackInfo => s !== null)
    .sort((a, b) => b.confidence - a.confidence);
}

/** Manifests that mark the root of a stack. */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
];
/** Directories whose manifests describe samples, test data or dependencies, not the project. */
const NOT_A_PROJECT =
  /(?:^|\/)(?:node_modules|vendor|third_party|\.venv|venv|dist|build|target|fixtures|__fixtures__|testdata|tests?|__tests__|examples?|samples?|templates?|docs?)(?:\/|$)/;

/**
 * Stacks in subdirectories that the root doesn't have: a Python service in a JS monorepo, or
 * `backend/` next to `frontend/` with nothing at the root. Looks in the workspace packages and
 * in directories up to two levels deep that hold a manifest. A language the root already has is
 * left to it (its workspace tooling covers the packages), so a JS monorepo isn't "node" 13 times.
 */
export async function detectNestedStacks(
  root: string,
  rootStacks: StackInfo[],
  packageDirs: string[] = [],
  extra: Detector[] = [],
): Promise<StackInfo[]> {
  const dirs = new Set(packageDirs);
  const manifests = await glob(`{*,*/*}/{${MANIFESTS.join(',')}}`, {
    cwd: root,
    ignore: ['**/node_modules/**'],
  });
  for (const m of manifests) dirs.add(dirname(m));
  const atRoot = new Set(rootStacks.map((s) => s.id));
  const found: StackInfo[] = [];
  for (const dir of [...dirs].filter((d) => d && d !== '.' && !NOT_A_PROJECT.test(d)).sort()) {
    for (const s of await detectStacks(join(root, dir), extra)) {
      if (atRoot.has(s.id)) continue;
      found.push({ ...s, dir, evidence: s.evidence.map((e) => `${dir}/${e}`) });
    }
  }
  return found;
}
