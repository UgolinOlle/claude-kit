import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { loadConfig } from "../src/core/config.ts";
import { buildContext } from "../src/core/context.ts";
import { detectMigrations } from "../src/detect/migrations.ts";
import {
  guardrails,
  hooksPlans,
  PRE_EDIT_PATH,
} from "../src/generators/hooks.ts";

import { tempProject } from "./helpers.ts";

async function write(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files))
    await Bun.write(join(dir, path), body);
}

async function installHook(dir: string) {
  const [script] = hooksPlans(await guardrails(await buildContext(dir)), "bun");
  await Bun.write(join(dir, PRE_EDIT_PATH), script!.content);
}

async function runHook(dir: string, input: unknown) {
  const proc = Bun.spawn([process.execPath, join(dir, PRE_EDIT_PATH)], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stderr: "pipe",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return {
    code: await proc.exited,
    stderr: await new Response(proc.stderr).text(),
  };
}

const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
  });

const edit = (
  dir: string,
  file_path: string,
  old_string: string,
  new_string: string,
) => ({
  tool_name: "Edit",
  cwd: dir,
  tool_input: { file_path, old_string, new_string },
});

describe("migration detection", () => {
  test("django, prisma and drizzle folders are found on disk, alembic from dependencies", async () => {
    const dir = await tempProject("python-app");
    await write(dir, {
      "app/blog/migrations/__init__.py": "",
      "web/prisma/migrations/migration_lock.toml": "",
      "packages/db/drizzle/meta/_journal.json": "{}",
    });
    const ctx = await buildContext(dir);
    const rules = await detectMigrations(dir, ctx.stacks);
    expect(rules.map((r) => [r.tool, r.pattern])).toEqual([
      ["django", "**/migrations/*.py"],
      ["prisma", "**/prisma/migrations/"],
      ["drizzle", "packages/db/drizzle/"],
    ]);
    expect(rules[0]!.reason).toContain(
      "uv run python manage.py makemigrations",
    );
  });

  test("nothing for a repo without migrations", async () => {
    const dir = await tempProject("bun-app");
    expect(
      await detectMigrations(dir, (await buildContext(dir)).stacks),
    ).toEqual([]);
  });

  test('"migrations": false in the config turns the protection off', async () => {
    const dir = await tempProject("python-app");
    await write(dir, {
      "app/migrations/__init__.py": "",
      ".claude-kit/config.json": JSON.stringify({
        guardrails: { migrations: false },
      }),
    });
    expect((await guardrails(await buildContext(dir))).migrations).toEqual([]);
  });
});

describe("pre-edit hook: committed migrations", () => {
  test("blocks edits to committed migrations, allows new ones", async () => {
    const dir = await tempProject("python-app");
    await write(dir, {
      "app/migrations/__init__.py": "",
      "app/migrations/0001_initial.py": "ops = []\n",
    });
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    await installHook(dir);

    const committed = await runHook(
      dir,
      edit(dir, "app/migrations/0001_initial.py", "ops", "x"),
    );
    expect(committed.code).toBe(2);
    expect(committed.stderr).toContain("makemigrations");

    await write(dir, { "app/migrations/0002_new.py": "ops = []\n" });
    expect(
      (await runHook(dir, edit(dir, "app/migrations/0002_new.py", "ops", "x")))
        .code,
    ).toBe(0);
    expect(
      (
        await runHook(dir, {
          tool_name: "Write",
          cwd: dir,
          tool_input: {
            file_path: "app/migrations/0003_more.py",
            content: "ops = []\n",
          },
        })
      ).code,
    ).toBe(0);
  });

  test("without git, existing migration files count as committed", async () => {
    const dir = await tempProject("python-app");
    await write(dir, {
      "app/migrations/__init__.py": "",
      "app/migrations/0001_initial.py": "x\n",
    });
    await installHook(dir);
    expect(
      (
        await runHook(
          dir,
          edit(dir, "app/migrations/0001_initial.py", "x", "y"),
        )
      ).code,
    ).toBe(2);
  });
});

describe("pre-edit hook: content rules", () => {
  async function setup() {
    const dir = await tempProject("bun-app");
    await write(dir, {
      ".claude-kit/config.json": JSON.stringify({
        guardrails: {
          content: [
            "no-console-log",
            {
              id: "no-any",
              files: ["src/**/*.ts"],
              pattern: String.raw`:\s*any\b`,
              reason: "use unknown",
            },
          ],
        },
      }),
      "src/legacy.ts": 'console.log("old");\n',
    });
    await installHook(dir);
    return dir;
  }

  test("blocks added matches with the rule id and reason", async () => {
    const dir = await setup();
    const res = await runHook(
      dir,
      edit(dir, "src/index.ts", "a", "console.log(a)"),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('"no-console-log"');
    expect(res.stderr).toContain("logger");
    expect(
      (await runHook(dir, edit(dir, "src/x.ts", "let a", "let a: any"))).stderr,
    ).toContain("use unknown");
  });

  test("only counts what the edit adds", async () => {
    const dir = await setup();
    // the file already had one; this edit keeps it
    const keep = edit(
      dir,
      "src/legacy.ts",
      'console.log("old");',
      'console.log("old"); // note',
    );
    expect((await runHook(dir, keep)).code).toBe(0);
    const write = (content: string) => ({
      tool_name: "Write",
      cwd: dir,
      tool_input: { file_path: "src/legacy.ts", content },
    });
    expect(
      (await runHook(dir, write('console.log("old");\nexport {};\n'))).code,
    ).toBe(0);
    expect(
      (await runHook(dir, write('console.log("old");\nconsole.log(1);\n')))
        .code,
    ).toBe(2);
    const multi = {
      tool_name: "MultiEdit",
      cwd: dir,
      tool_input: {
        file_path: "src/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "console.log(c)" },
        ],
      },
    };
    expect((await runHook(dir, multi)).code).toBe(2);
  });

  test("excluded and unrelated files pass", async () => {
    const dir = await setup();
    for (const file of [
      "src/a.test.ts",
      "tests/a.ts",
      "scripts/build.ts",
      "README.md",
    ])
      expect(
        (await runHook(dir, edit(dir, file, "a", "console.log(a)"))).code,
      ).toBe(0);
  });
});

describe("pre-edit hook: article rules", () => {
  async function setup(content: string[]) {
    const dir = await tempProject("bun-app");
    await write(dir, {
      ".claude-kit/config.json": JSON.stringify({ guardrails: { content } }),
    });
    await installHook(dir);
    return dir;
  }
  const add = (dir: string, file: string, code: string) =>
    edit(dir, file, "x", code);

  test("no-raw-db: only the repository layer queries the database", async () => {
    const dir = await setup(["no-raw-db"]);
    const res = await runHook(
      dir,
      add(dir, "src/services/user.ts", "await db.query(sql)"),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("repository");
    for (const file of [
      "src/repositories/user.ts",
      "app/user_repository.py",
      "src/user.test.ts",
    ])
      expect((await runHook(dir, add(dir, file, "db.execute(sql)"))).code).toBe(
        0,
      );
  });

  test("py-return-annotations: def needs ->", async () => {
    const dir = await setup(["py-return-annotations"]);
    expect(
      (await runHook(dir, add(dir, "app/a.py", "def f(x):\n    return x")))
        .code,
    ).toBe(2);
    expect(
      (await runHook(dir, add(dir, "app/a.py", "async def f(\n  x,\n):"))).code,
    ).toBe(2);
    expect(
      (await runHook(dir, add(dir, "app/a.py", "def f(x: int) -> int:"))).code,
    ).toBe(0);
    expect(
      (await runHook(dir, add(dir, "tests/test_a.py", "def test_f():"))).code,
    ).toBe(0);
  });

  test("requires-test: a new export needs a test file first", async () => {
    const dir = await setup(["requires-test", "requires-test-py"]);
    const res = await runHook(
      dir,
      add(dir, "src/util/math.ts", "export function sum() {}"),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("src/util/math.test.ts");
    expect(res.stderr).toContain("tests/util/math.test.ts");

    await write(dir, { "tests/util/math.test.ts": "" });
    expect(
      (
        await runHook(
          dir,
          add(dir, "src/util/math.ts", "export function sum() {}"),
        )
      ).code,
    ).toBe(0);
    // editing a function that's already exported isn't "new"
    expect(
      (
        await runHook(
          dir,
          edit(
            dir,
            "src/other.ts",
            "export function a() {}",
            "export function a() { return 1 }",
          ),
        )
      ).code,
    ).toBe(0);
    expect(
      (await runHook(dir, add(dir, "src/other.ts", "export const a = 1"))).code,
    ).toBe(0);

    const py = await runHook(
      dir,
      add(dir, "app/billing.py", "def charge(amount):"),
    );
    expect(py.code).toBe(2);
    expect(py.stderr).toContain("tests/test_billing.py");
    expect(
      (await runHook(dir, add(dir, "app/billing.py", "def _helper():"))).code,
    ).toBe(0);
    await write(dir, { "app/test_billing.py": "" });
    expect(
      (await runHook(dir, add(dir, "app/billing.py", "def charge(amount):")))
        .code,
    ).toBe(0);
  });
});

describe("guardrails config", () => {
  test("rejects unknown ids, incomplete rules and bad regexps", async () => {
    const dir = await tempProject();
    const cfg = (content: unknown[]) =>
      Bun.write(
        join(dir, ".claude-kit/config.json"),
        JSON.stringify({ guardrails: { content } }),
      );
    await cfg(["no-such-rule"]);
    await expect(loadConfig(dir)).rejects.toThrow(
      'unknown rule "no-such-rule"',
    );
    await cfg([{ id: "x", files: ["*.ts"], reason: "r" }]);
    await expect(loadConfig(dir)).rejects.toThrow("missing pattern");
    await cfg([{ id: "x", files: ["*.ts"], pattern: "(", reason: "r" }]);
    await expect(loadConfig(dir)).rejects.toThrow("invalid pattern");
  });

  test('"extends" reuses a built-in and overrides fields', async () => {
    const dir = await tempProject();
    await Bun.write(
      join(dir, ".claude-kit/config.json"),
      JSON.stringify({
        guardrails: {
          content: [{ extends: "no-console-log", exclude: ["cli/"] }],
        },
      }),
    );
    const [rule] = (await loadConfig(dir)).guardrails.content;
    expect(rule!.id).toBe("no-console-log");
    expect(rule!.exclude).toEqual(["cli/"]);
    expect(rule!.pattern).toContain("console");
  });

  test("CLAUDE.md mentions the active guardrails", async () => {
    const dir = await tempProject("python-app");
    await write(dir, {
      "app/migrations/__init__.py": "",
      ".claude-kit/config.json": JSON.stringify({
        guardrails: { content: ["no-print"] },
      }),
    });
    const { claudeMdPlan } = await import("../src/generators/claudemd.ts");
    const ctx = await buildContext(dir);
    const md = claudeMdPlan(ctx, ["claudemd", "hooks"], {
      guardrails: await guardrails(ctx),
    });
    expect(md.content).toContain("Committed migrations (django)");
    expect(md.content).toContain("`no-print`");
  });
});
