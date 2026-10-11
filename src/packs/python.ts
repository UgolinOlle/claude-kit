import type { PackCommand, StackPack } from './types.ts';

const RUNNER: Record<string, string> = {
  uv: 'uv run ',
  poetry: 'poetry run ',
  pipenv: 'pipenv run ',
  pip: '',
};
const INSTALL: Record<string, string> = {
  uv: 'uv sync',
  poetry: 'poetry install',
  pipenv: 'pipenv install --dev',
  pip: 'pip install -r requirements.txt',
};

const LOCKFILE_REASON = 'lockfiles are generated; change pyproject.toml and re-lock instead';

export const pythonPack: StackPack = {
  id: 'python',

  label: () => 'Python',

  ignore: [
    '__pycache__/',
    '*.py[cod]',
    '.venv/',
    'venv/',
    '.mypy_cache/',
    '.pytest_cache/',
    '.ruff_cache/',
    '.tox/',
    '.nox/',
    '*.egg-info/',
    'dist/',
    'build/',
    'htmlcov/',
    '.coverage',
    'uv.lock',
    'poetry.lock',
    'Pipfile.lock',
  ],

  protectedPaths: [
    { pattern: 'uv.lock', reason: LOCKFILE_REASON },
    { pattern: 'poetry.lock', reason: LOCKFILE_REASON },
    { pattern: 'Pipfile.lock', reason: LOCKFILE_REASON },
    { pattern: '.venv/', reason: 'the virtualenv is managed by the package manager' },
  ],

  commands(stack) {
    const run = RUNNER[stack.manager] ?? '';
    const all = new Set([...stack.deps, ...stack.devDeps]);
    const out: PackCommand[] = [
      { label: 'install', cmd: INSTALL[stack.manager] ?? 'pip install -e .' },
    ];
    if (all.has('pytest')) out.push({ label: 'test', cmd: `${run}pytest` });
    if (all.has('ruff')) {
      out.push({ label: 'lint', cmd: `${run}ruff check .` });
      out.push({ label: 'format', cmd: `${run}ruff format .` });
    }
    if (all.has('mypy')) out.push({ label: 'typecheck', cmd: `${run}mypy .` });
    if (all.has('pyright')) out.push({ label: 'typecheck', cmd: `${run}pyright` });
    return out;
  },
};
