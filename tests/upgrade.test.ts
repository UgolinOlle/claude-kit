import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { GlobalOptions } from "../src/cli.ts";
import { runInit } from "../src/commands/init.ts";
import { compareVersions, runUpgrade } from "../src/commands/upgrade.ts";
import { loadManifest, saveManifest } from "../src/core/manifest.ts";
import { readText, sha256 } from "../src/utils/fsSafe.ts";
import { configureLogger } from "../src/utils/logger.ts";

import { tempProject } from "./helpers.ts";

beforeAll(() => configureLogger({ silent: true }));

const opts = (cwd: string): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: true,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
});
const upgrade = (dir: string) =>
  runUpgrade(opts(dir), {
    hookRuntime: "node",
    interactive: false,
    latest: async () => null,
  });

/** Make a generated file look like it came from an older template version. */
async function age(dir: string, path: string, oldContent: string) {
  await Bun.write(join(dir, path), oldContent);
  const m = await loadManifest(dir);
  m.files[path] = {
    ...m.files[path]!,
    templateVersion: 0,
    hash: sha256(oldContent),
  };
  m.cliVersion = "0.0.1";
  await saveManifest(dir, m);
}

describe("upgrade", () => {
  test("updates untouched files from older templates, keeps edited ones", async () => {
    const dir = await tempProject("bun-app");
    await runInit(opts(dir), { hookRuntime: "node", interactive: false });
    const hook = ".claude/hooks/pre-edit.cjs";
    const current = (await readText(join(dir, hook)))!;
    await age(dir, hook, "// hook from an older claude-kit\n");

    expect(await upgrade(dir)).toBe(0);
    expect(await readText(join(dir, hook))).toBe(current);
    expect((await loadManifest(dir)).files[hook]?.templateVersion).toBe(2);

    await Bun.write(join(dir, hook), "// my own hook\n");
    await upgrade(dir);
    expect(await readText(join(dir, hook))).toBe("// my own hook\n");
  });

  test("requires a prior init", async () => {
    expect(await upgrade(await tempProject("bun-app"))).toBe(1);
  });

  test("version comparison", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});
