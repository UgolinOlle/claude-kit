import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { GlobalOptions } from "../src/cli.ts";
import { runInit } from "../src/commands/init.ts";
import { loadManifest } from "../src/core/manifest.ts";
import { exists, readJson, readText } from "../src/utils/fsSafe.ts";
import { configureLogger } from "../src/utils/logger.ts";

import { tempProject } from "./helpers.ts";

beforeAll(() => configureLogger({ silent: true }));

const opts = (
  cwd: string,
  extra: Partial<GlobalOptions> = {},
): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: true,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
  ...extra,
});

const init = (cwd: string, extra: Partial<GlobalOptions> = {}) =>
  runInit(opts(cwd, extra), { interactive: false, hookRuntime: "node" });
const sync = (cwd: string) =>
  runInit(opts(cwd), { sync: true, interactive: false, hookRuntime: "node" });

type Settings = {
  permissions: { deny: string[]; allow?: string[] };
  model?: string;
  hooks: unknown;
};
const settings = (dir: string) =>
  readJson<Settings>(join(dir, ".claude/settings.json")) as Promise<Settings>;
const read = async (dir: string, p: string) => (await readText(join(dir, p)))!;

const GENERATED = [
  ".claudeignore",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/hooks/pre-edit.cjs",
];

describe("init", () => {
  test("creates the minimal setup and records it in the manifest", async () => {
    const dir = await tempProject("bun-app");
    expect(await init(dir)).toBe(0);
    for (const f of GENERATED) expect(await exists(join(dir, f))).toBe(true);
    const m = await loadManifest(dir);
    expect(m.preset).toBe("minimal");
    expect(Object.keys(m.files).sort()).toEqual([...GENERATED].sort());
  });

  test("is idempotent: second run changes nothing", async () => {
    const dir = await tempProject("pnpm-monorepo");
    await init(dir);
    const before = await Promise.all(GENERATED.map((f) => read(dir, f)));
    await init(dir);
    expect(await Promise.all(GENERATED.map((f) => read(dir, f)))).toEqual(
      before,
    );
  });

  test("dry run writes nothing", async () => {
    const dir = await tempProject("bun-app");
    expect(await init(dir, { dryRun: true })).toBe(0);
    for (const f of [...GENERATED, ".claude-kit/manifest.json"])
      expect(await exists(join(dir, f))).toBe(false);
  });

  test("deny rules follow user edits to .claudeignore via sync", async () => {
    const dir = await tempProject("bun-app");
    await init(dir);
    const ignore = await read(dir, ".claudeignore");
    await Bun.write(
      join(dir, ".claudeignore"),
      ignore.replace("coverage/\n", "") + "secrets/\n",
    );

    expect(await sync(dir)).toBe(0);
    const deny = (await settings(dir)).permissions.deny;
    expect(deny).toContain("Read(**/secrets/**)");
    expect(deny).not.toContain("Read(**/coverage/**)");

    // re-running init must not re-add the line the user removed
    await init(dir);
    expect(await read(dir, ".claudeignore")).not.toContain("coverage/");
    expect((await settings(dir)).permissions.deny).not.toContain(
      "Read(**/coverage/**)",
    );
  });

  test("user additions to settings.json survive", async () => {
    const dir = await tempProject("bun-app");
    await init(dir);
    const s = await settings(dir);
    await Bun.write(
      join(dir, ".claude/settings.json"),
      JSON.stringify(
        {
          ...s,
          model: "sonnet",
          permissions: { ...s.permissions, allow: ["Bash(bun test)"] },
        },
        null,
        2,
      ),
    );
    await init(dir);
    const after = await settings(dir);
    expect(after.model).toBe("sonnet");
    expect(after.permissions.allow).toEqual(["Bash(bun test)"]);
    expect(after.permissions.deny).toContain("Read(**/node_modules/**)");
  });

  test("existing hand-written CLAUDE.md is merged, never replaced", async () => {
    const dir = await tempProject("messy");
    const original = await read(dir, "CLAUDE.md");
    await init(dir);
    const merged = await read(dir, "CLAUDE.md");
    expect(merged.startsWith(original.trimEnd())).toBe(true);
    expect(merged).toContain("<!-- claude-kit:begin commands -->");
    expect(merged).not.toContain("<!-- One or two sentences"); // only regions are added, not skeleton prose
  });

  test("edited hook script: --yes keeps it, --force overwrites", async () => {
    const dir = await tempProject("bun-app");
    await init(dir);
    const hook = ".claude/hooks/pre-edit.cjs";
    const generated = await read(dir, hook);
    await Bun.write(join(dir, hook), "// mine\n");
    await init(dir); // --yes: conflict resolves to keep
    expect(await read(dir, hook)).toBe("// mine\n");
    await init(dir, { yes: false, force: true });
    expect(await read(dir, hook)).toBe(generated);
  });

  test("sync before init is an error", async () => {
    expect(await sync(await tempProject("bun-app"))).toBe(1);
  });

  test("--without drops a feature", async () => {
    const dir = await tempProject("bun-app");
    await init(dir, { without: ["hooks"] });
    expect(await exists(join(dir, ".claude/hooks/pre-edit.cjs"))).toBe(false);
    expect((await read(dir, "CLAUDE.md")).includes("pre-edit.cjs")).toBe(false);
  });

  test("unknown preset / feature are rejected", async () => {
    const dir = await tempProject("bun-app");
    expect(await init(dir, { preset: "huge" })).toBe(2);
    await expect(init(dir, { with: ["nope"] })).rejects.toThrow(
      'Unknown feature "nope"',
    );
  });
});

describe("generated output", () => {
  const fixtures = [
    "bun-app",
    "python-app",
    "pnpm-monorepo",
    "polyglot",
    "messy",
  ];

  test.each(fixtures)(
    "%s: no dates or timestamps (cache-breakers)",
    async (fixture) => {
      const dir = await tempProject(fixture);
      const original = (await readText(join(dir, "CLAUDE.md"))) ?? "";
      await init(dir);
      for (const f of GENERATED) {
        const text = (await read(dir, f)).replace(original, "");
        expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\d\d:\d\d:\d\d/);
      }
    },
  );

  test.each(fixtures.filter((f) => f !== "messy"))(
    "%s: CLAUDE.md stays lean",
    async (fixture) => {
      const dir = await tempProject(fixture);
      await init(dir);
      expect((await read(dir, "CLAUDE.md")).split("\n").length).toBeLessThan(
        80,
      );
    },
  );

  test("python commands use the detected manager and dev tools", async () => {
    const dir = await tempProject("python-app");
    await init(dir);
    const md = await read(dir, "CLAUDE.md");
    expect(md).toContain("uv sync");
    expect(md).toContain("uv run pytest");
    expect(md).toContain("uv run ruff check .");
  });

  test("monorepo packages are listed", async () => {
    const dir = await tempProject("pnpm-monorepo");
    await init(dir);
    expect(await read(dir, "CLAUDE.md")).toContain(
      "Monorepo (pnpm + turbo), 3 packages: `apps/web`, `packages/ui`, `packages/utils`",
    );
  });
});
