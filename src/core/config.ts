import { join } from "node:path";

import { readJson } from "../utils/fsSafe.ts";

export const CONFIG_PATH = ".claude-kit/config.json";

export type RuleLevel = "error" | "warn" | "info" | "off";

/**
 * Token budgets (#12) for the parts of a session this repo controls. Defaults are the article's
 * BUDGETS; the system prompt, user prompt and response budgets aren't controllable here.
 */
export interface Budgets {
  /** Always-loaded project instructions: CLAUDE.md, its @imports, unscoped rules. */
  project_rules: number;
  /** Tool definitions of the project's MCP servers (measured by `doctor --probe-mcp`). */
  tool_definitions: number;
  /** Ceiling for code that `search_code` returns in one call. */
  retrieved_context: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  project_rules: 800,
  tool_definitions: 12_000,
  retrieved_context: 15_000,
};

/** A check on the text Claude adds in an edit; built-in ids or a custom rule. */
export interface ContentRule {
  id: string;
  /** gitignore-style patterns of files the rule applies to. */
  files: string[];
  /** gitignore-style patterns of files it never applies to (tests, scripts…). */
  exclude: string[];
  /** JavaScript regular expression source; matched with the "gm" flags. */
  pattern: string;
  /** Shown to Claude when the edit is blocked: what to do instead. */
  reason: string;
  /**
   * Turns the rule into "added matches need a test": the edit passes when one of these files
   * exists. Placeholders: {dir} {name} {ext} {path} (no extension), and {subdir} / {subpath}:
   * {dir} / {path} without a leading src/, lib/ or app/.
   */
  tests?: string[];
}

/**
 * Hand-written project config (claude-kit never generates it).
 *   { "rules": { "cache/volatile-content": "off" }, "exclude": ["tests/fixtures/**"],
 *     "packs": ["claude-kit-pack-elixir"], "guardrails": { "content": ["no-console-log"] },
 *     "budgets": { "project_rules": 1500 } }
 */
export interface KitConfig {
  /** Per-rule severity override, or "off". */
  rules: Record<string, RuleLevel>;
  /** Globs: findings about matching files are dropped. */
  exclude: string[];
  /** External stack packs: package names or ./relative module paths. */
  packs: string[];
  /** Token budgets; `budgetsSet` lists the ones the project chose (findings are louder). */
  budgets: Budgets;
  budgetsSet: (keyof Budgets)[];
  /** Edit guardrails compiled into the pre-edit hook (`claude-kit sync` after changing them). */
  guardrails: {
    /** Opt-in checks on added code, resolved to full rules. */
    content: ContentRule[];
    /** false turns off the committed-migration protection. */
    migrations: boolean;
  };
}

const LEVELS = new Set<RuleLevel>(["error", "warn", "info", "off"]);

const JS = [
  "*.js",
  "*.jsx",
  "*.mjs",
  "*.cjs",
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
];
const JS_TESTS = [
  "*.test.*",
  "*.spec.*",
  "__tests__/",
  "test/",
  "tests/",
  "e2e/",
  "scripts/",
  "*.config.*",
];
const PY_TESTS = [
  "test_*.py",
  "*_test.py",
  "tests/",
  "test/",
  "conftest.py",
  "scripts/",
];
const MIGRATIONS = ["migrations/", "alembic/", "db/migrate/"];

/** Opinionated checks a project can switch on by id. */
export const BUILTIN_CONTENT_RULES: Record<string, Omit<ContentRule, "id">> = {
  "no-console-log": {
    files: JS,
    exclude: JS_TESTS,
    pattern: String.raw`\bconsole\.log\(`,
    reason:
      "use the project's logger instead of console.log in application code",
  },
  "no-debugger": {
    files: JS,
    exclude: [],
    pattern: String.raw`^\s*debugger\b`,
    reason: "remove the debugger statement",
  },
  "no-focused-tests": {
    files: JS,
    exclude: [],
    pattern: String.raw`\b(?:it|test|describe)\.only\(`,
    reason: ".only skips the rest of the suite; remove it",
  },
  "no-print": {
    files: ["*.py"],
    exclude: PY_TESTS,
    pattern: String.raw`^\s*print\(`,
    reason: "use logging instead of print() in application code",
  },
  "no-breakpoint": {
    files: ["*.py"],
    exclude: [],
    pattern: String.raw`^\s*(?:breakpoint\(\)|import i?pdb|i?pdb\.set_trace\(\))`,
    reason: "remove the debugger call",
  },
  "no-raw-db": {
    files: [...JS, "*.py"],
    exclude: [
      "repositories/",
      "repository/",
      "*repository.*",
      "*_repository.py",
      ...JS_TESTS,
      ...PY_TESTS,
      ...MIGRATIONS,
    ],
    pattern: String.raw`\bdb\.(?:query|exec|execute|raw)\(`,
    reason:
      "database access goes through the repository layer (repositories/); add or extend a repository method instead",
  },
  "py-return-annotations": {
    files: ["*.py"],
    exclude: PY_TESTS,
    // `def f(...):` with no `->` before the colon; nested parentheses in defaults aren't flagged.
    pattern: String.raw`^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*:`,
    reason: "annotate the return type (`-> None` when nothing is returned)",
  },
  "requires-test": {
    files: JS,
    exclude: [...JS_TESTS, "*.d.ts", "index.*"],
    pattern: String.raw`^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s`,
    reason: "new exported functions and classes need a test; write it first",
    tests: [
      "{dir}/{name}.test.{ext}",
      "{dir}/{name}.spec.{ext}",
      "{dir}/__tests__/{name}.test.{ext}",
      "tests/{path}.test.{ext}",
      "tests/{subpath}.test.{ext}",
      "test/{subpath}.test.{ext}",
    ],
  },
  "requires-test-py": {
    files: ["*.py"],
    exclude: [...PY_TESTS, "__init__.py", "__main__.py", ...MIGRATIONS],
    pattern: String.raw`^(?:async\s+)?def\s+[a-zA-Z]\w*\s*\(|^class\s+[A-Z]`,
    reason: "new public functions and classes need a test; write it first",
    tests: [
      "tests/test_{name}.py",
      "tests/{subdir}/test_{name}.py",
      "{dir}/test_{name}.py",
      "{dir}/{name}_test.py",
    ],
  },
  "requires-test-go": {
    files: ["*.go"],
    exclude: ["*_test.go"],
    pattern: String.raw`^func\s+(?:\([^)]*\)\s*)?[A-Z]`,
    reason: "new exported functions need a test; write it first",
    tests: ["{dir}/{name}_test.go"],
  },
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function resolveContentRule(entry: unknown, i: number): ContentRule {
  const where = `${CONFIG_PATH}: guardrails.content[${i}]`;
  if (typeof entry === "string") {
    const builtin = BUILTIN_CONTENT_RULES[entry];
    if (!builtin)
      throw new Error(
        `${where}: unknown rule "${entry}". Built-in: ${Object.keys(BUILTIN_CONTENT_RULES).join(", ")}; or write { "id", "files", "pattern", "reason" }.`,
      );
    return { id: entry, ...builtin };
  }
  const raw = (entry ?? {}) as Record<string, unknown>;
  const base =
    typeof raw.extends === "string"
      ? BUILTIN_CONTENT_RULES[raw.extends]
      : undefined;
  if (typeof raw.extends === "string" && !base)
    throw new Error(`${where}: "extends" names unknown rule "${raw.extends}".`);
  const rule: ContentRule = {
    id: typeof raw.id === "string" ? raw.id : String(raw.extends ?? ""),
    files: raw.files !== undefined ? strings(raw.files) : (base?.files ?? []),
    exclude:
      raw.exclude !== undefined ? strings(raw.exclude) : (base?.exclude ?? []),
    pattern:
      typeof raw.pattern === "string" ? raw.pattern : (base?.pattern ?? ""),
    reason: typeof raw.reason === "string" ? raw.reason : (base?.reason ?? ""),
  };
  const tests = raw.tests !== undefined ? strings(raw.tests) : base?.tests;
  if (tests?.length) rule.tests = tests;
  const missing: string[] = (["id", "pattern", "reason"] as const).filter(
    (k) => !rule[k],
  );
  if (rule.files.length === 0) missing.push("files");
  if (missing.length)
    throw new Error(`${where}: missing ${missing.join(", ")}.`);
  try {
    RegExp(rule.pattern, "gm");
  } catch (err) {
    throw new Error(`${where}: invalid pattern: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return rule;
}

export async function loadConfig(root: string): Promise<KitConfig> {
  const raw = await readJson<Partial<Record<keyof KitConfig, unknown>>>(
    join(root, CONFIG_PATH),
  );
  const rules: Record<string, RuleLevel> = {};
  for (const [id, level] of Object.entries(
    (raw?.rules ?? {}) as Record<string, RuleLevel>,
  )) {
    if (!LEVELS.has(level))
      throw new Error(
        `${CONFIG_PATH}: rule "${id}" has invalid level "${level}" (use error, warn, info or off)`,
      );
    rules[id] = level;
  }
  const budgets: Budgets = { ...DEFAULT_BUDGETS };
  const budgetsSet: (keyof Budgets)[] = [];
  for (const [key, value] of Object.entries(
    (raw?.budgets ?? {}) as Record<string, unknown>,
  )) {
    if (!(key in DEFAULT_BUDGETS))
      throw new Error(
        `${CONFIG_PATH}: unknown budget "${key}" (use ${Object.keys(DEFAULT_BUDGETS).join(", ")})`,
      );
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(
        `${CONFIG_PATH}: budget "${key}" must be a positive number of tokens`,
      );
    budgets[key as keyof Budgets] = Math.round(value);
    budgetsSet.push(key as keyof Budgets);
  }
  const guardrails = (raw?.guardrails ?? {}) as {
    content?: unknown;
    migrations?: unknown;
  };
  const content = Array.isArray(guardrails.content)
    ? guardrails.content.map(resolveContentRule)
    : [];
  return {
    rules,
    exclude: strings(raw?.exclude),
    packs: strings(raw?.packs),
    budgets,
    budgetsSet,
    guardrails: { content, migrations: guardrails.migrations !== false },
  };
}
