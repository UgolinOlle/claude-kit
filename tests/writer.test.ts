import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadManifest } from "../src/core/manifest.ts";
import { region } from "../src/core/merge.ts";
import { type FilePlan, NEW_SUFFIX, overwriteAll, planChanges, runPlans, type Resolution } from "../src/core/writer.ts";
import { exists, readText } from "../src/utils/fsSafe.ts";
import { tempProject } from "./helpers.ts";

const plan = (path: string, content: string, strategy: FilePlan["strategy"] = "replace", templateVersion = 1): FilePlan => ({
  path,
  content,
  strategy,
  templateId: path,
  templateVersion,
});

const read = (dir: string, p: string) => readText(join(dir, p));
const actions = (changes: { action: string }[]) => changes.map((c) => c.action);

describe("writer", () => {
  test("creates files and records them in the manifest", async () => {
    const dir = await tempProject();
    const { result } = await runPlans(dir, [plan("docs/a.md", "A\n")]);
    expect(result?.written).toEqual(["docs/a.md"]);
    expect(await read(dir, "docs/a.md")).toBe("A\n");
    const m = await loadManifest(dir);
    expect(m.files["docs/a.md"]?.owned).toBe(true);
  });

  test("re-running with the same plans is a no-op", async () => {
    const dir = await tempProject();
    const plans = [plan("a.md", "A\n"), plan(".claudeignore", "dist/\n", "lines"), plan("s.json", '{"x":1}\n', "json")];
    await runPlans(dir, plans);
    const { changes } = await runPlans(dir, plans);
    expect(actions(changes)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  test("untouched owned file is updated when the template changes", async () => {
    const dir = await tempProject();
    await runPlans(dir, [plan("a.md", "v1\n")]);
    const { changes } = await runPlans(dir, [plan("a.md", "v2\n", "replace", 2)]);
    expect(actions(changes)).toEqual(["update"]);
    expect(await read(dir, "a.md")).toBe("v2\n");
    expect((await loadManifest(dir)).files["a.md"]?.templateVersion).toBe(2);
  });

  test("edited replace-file is a conflict; default resolver keeps it", async () => {
    const dir = await tempProject();
    await runPlans(dir, [plan("a.md", "v1\n")]);
    await Bun.write(join(dir, "a.md"), "my edits\n");
    const { changes, result } = await runPlans(dir, [plan("a.md", "v2\n")]);
    expect(actions(changes)).toEqual(["conflict"]);
    expect(result?.kept).toEqual(["a.md"]);
    expect(await read(dir, "a.md")).toBe("my edits\n");
  });

  test("conflict → write sidecar, original untouched", async () => {
    const dir = await tempProject();
    await Bun.write(join(dir, "a.md"), "handwritten\n");
    const { result } = await runPlans(dir, [plan("a.md", "gen\n")], { resolve: async (): Promise<Resolution> => "new" });
    expect(result?.sidecars).toEqual([`a.md${NEW_SUFFIX}`]);
    expect(await read(dir, "a.md")).toBe("handwritten\n");
    expect(await read(dir, `a.md${NEW_SUFFIX}`)).toBe("gen\n");
  });

  test("conflict → overwrite takes ownership", async () => {
    const dir = await tempProject();
    await Bun.write(join(dir, "a.md"), "handwritten\n");
    await runPlans(dir, [plan("a.md", "gen\n")], { resolve: overwriteAll });
    expect(await read(dir, "a.md")).toBe("gen\n");
    expect((await loadManifest(dir)).files["a.md"]?.owned).toBe(true);
  });

  test("hand-written CLAUDE.md gets regions merged, user text preserved, never wholesale-replaced later", async () => {
    const dir = await tempProject();
    await Bun.write(join(dir, "CLAUDE.md"), "# My rules\n\nNever touch prod.\n");
    const gen = (stack: string) => plan("CLAUDE.md", `# Generated\n\n${region("stack", stack)}\n`, "regions");

    const first = await runPlans(dir, [gen("Bun")]);
    expect(actions(first.changes)).toEqual(["merge"]);
    expect(await read(dir, "CLAUDE.md")).toContain("Never touch prod.");
    expect((await loadManifest(dir)).files["CLAUDE.md"]?.owned).toBe(false);

    // file is now "untouched" since last write, but not owned → must still merge, not replace
    const second = await runPlans(dir, [gen("Bun + React")]);
    expect(actions(second.changes)).toEqual(["merge"]);
    const text = (await read(dir, "CLAUDE.md"))!;
    expect(text).toContain("Never touch prod.");
    expect(text).toContain("Bun + React");
    expect(text).not.toContain("# Generated");
  });

  test("invalid user JSON becomes a conflict instead of being destroyed", async () => {
    const dir = await tempProject();
    await Bun.write(join(dir, "s.json"), "{ broken");
    const { changes } = await runPlans(dir, [plan("s.json", "{}\n", "json")]);
    expect(changes[0]?.action).toBe("conflict");
    expect(changes[0]?.reason).toContain("not valid JSON");
    expect(await read(dir, "s.json")).toBe("{ broken");
  });

  test("dry run writes nothing, not even the manifest", async () => {
    const dir = await tempProject();
    const { changes, result } = await runPlans(dir, [plan("a.md", "A\n")], { dryRun: true });
    expect(actions(changes)).toEqual(["create"]);
    expect(result).toBeNull();
    expect(await exists(join(dir, "a.md"))).toBe(false);
    expect(await exists(join(dir, ".claude-kit"))).toBe(false);
  });

  test("refuses paths outside the project", async () => {
    const dir = await tempProject();
    await expect(planChanges(dir, [plan("../evil.md", "x")], await loadManifest(dir))).rejects.toThrow("outside project root");
  });
});

describe("seed strategy", () => {
  test("creates once, then never touches the file, even when the template changes", async () => {
    const dir = await tempProject();
    await runPlans(dir, [plan("docs/a.md", "template v1\n", "seed")]);
    expect(await read(dir, "docs/a.md")).toBe("template v1\n");
    // untouched by the user, template changes: still not updated
    const { changes } = await runPlans(dir, [plan("docs/a.md", "template v2\n", "seed", 2)]);
    expect(actions(changes)).toEqual(["unchanged"]);
    expect(await read(dir, "docs/a.md")).toBe("template v1\n");
    await Bun.write(join(dir, "docs/a.md"), "my notes\n");
    await runPlans(dir, [plan("docs/a.md", "template v3\n", "seed", 3)], { resolve: overwriteAll });
    expect(await read(dir, "docs/a.md")).toBe("my notes\n");
  });
});
