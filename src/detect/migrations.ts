/**
 * Database migration folders (#9). Committed migrations are history: editing one desyncs every
 * database that already ran it, so the pre-edit hook blocks edits to *tracked* migration files
 * and points Claude at the generator command. New, uncommitted migrations stay editable.
 */
import { dirname } from 'node:path';

import { glob } from '../utils/runtime.ts';

import type { StackInfo } from './stack.ts';

export interface MigrationRule {
  /** gitignore-style pattern, as the pre-edit hook matches it. */
  pattern: string;
  reason: string;
  /** Only files already committed to git are blocked. */
  committedOnly: true;
  /** Tool that owns the folder, for display. */
  tool: string;
}

const IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/**',
  '**/dist/**',
  '**/build/**',
  '**/site-packages/**',
];

const PY_RUN: Record<string, string> = {
  uv: 'uv run ',
  poetry: 'poetry run ',
  pipenv: 'pipenv run ',
};

const reason = (cmd: string) =>
  `committed migrations are history that databases already ran; add a new one with \`${cmd}\` instead`;

const has = (stacks: StackInfo[], id: string, ...deps: string[]) =>
  stacks.some((s) => s.id === id && deps.some((d) => s.deps.includes(d) || s.devDeps.includes(d)));

const goHas = (stacks: StackInfo[], prefix: string) =>
  stacks.some((s) => s.id === 'go' && s.deps.some((d) => d.startsWith(prefix)));

const find = (root: string, pattern: string, onlyFiles = true) =>
  glob(pattern, { cwd: root, onlyFiles, dot: false, ignore: IGNORE });

/**
 * A rule is added when the tool is a declared dependency or its folder exists on disk; the disk
 * check covers monorepo packages, whose dependencies aren't part of the root stack.
 */
export async function detectMigrations(
  root: string,
  stacks: StackInfo[],
): Promise<MigrationRule[]> {
  const rules: MigrationRule[] = [];
  const add = (tool: string, pattern: string, cmd: string) => {
    if (!rules.some((r) => r.pattern === pattern))
      rules.push({ tool, pattern, reason: reason(cmd), committedOnly: true });
  };
  const py = stacks.find((s) => s.id === 'python');
  const run = (py && PY_RUN[py.manager]) ?? '';

  const [django, alembicIni, alembicDirs, prisma, drizzle, rails, flyway] = await Promise.all([
    find(root, '**/migrations/__init__.py'),
    find(root, '**/alembic.ini'),
    find(root, '**/{alembic,migrations}/versions', false),
    find(root, '**/prisma/migrations/migration_lock.toml'),
    find(root, '**/meta/_journal.json'),
    find(root, 'db/migrate', false),
    find(root, '**/db/migration/V*__*.sql'),
  ]);

  // Python
  if (django.length || has(stacks, 'python', 'django'))
    add('django', '**/migrations/*.py', `${run}python manage.py makemigrations`);
  if (
    alembicIni.length ||
    alembicDirs.length ||
    has(stacks, 'python', 'alembic', 'flask-migrate')
  ) {
    add('alembic', '**/alembic/versions/', `${run}alembic revision --autogenerate -m "<change>"`);
    add(
      'alembic',
      '**/migrations/versions/',
      `${run}alembic revision --autogenerate -m "<change>"`,
    );
  }

  // Node
  if (prisma.length || has(stacks, 'node', 'prisma', '@prisma/client'))
    add('prisma', '**/prisma/migrations/', 'prisma migrate dev --name <change>');
  for (const journal of drizzle)
    add('drizzle', `${dirname(dirname(journal))}/`, 'drizzle-kit generate');
  if (!drizzle.length && has(stacks, 'node', 'drizzle-kit'))
    add('drizzle', 'drizzle/', 'drizzle-kit generate');
  if (has(stacks, 'node', 'knex')) add('knex', '**/migrations/', 'knex migrate:make <name>');
  if (has(stacks, 'node', 'sequelize-cli'))
    add('sequelize', '**/migrations/', 'sequelize-cli migration:generate --name <name>');

  // Rust
  if (has(stacks, 'rust', 'diesel', 'diesel_migrations'))
    add('diesel', '**/migrations/', 'diesel migration generate <name>');
  if (has(stacks, 'rust', 'sqlx')) add('sqlx', '**/migrations/', 'sqlx migrate add <name>');

  // Go
  if (goHas(stacks, 'github.com/pressly/goose'))
    add('goose', '**/migrations/', 'goose create <name> sql');
  if (goHas(stacks, 'github.com/golang-migrate/migrate'))
    add('golang-migrate', '**/migrations/', 'migrate create -ext sql -dir migrations <name>');

  // Language-agnostic layouts
  if (rails.length) add('rails', 'db/migrate/', 'bin/rails generate migration <Name>');
  if (flyway.length) add('flyway', '**/db/migration/', 'a new V<n>__<name>.sql file');

  return rules;
}
