import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildContextReport, formatReport } from "../src/commands/context.ts";
import { tempProject } from "./helpers.ts";

async function setup() {
  const dir = await tempProject();
  const config = join(dir, ".fake-config");
  const files: Record<string, string> = {
    "CLAUDE.md": "# Project\n<!-- free -->\n@docs/arch.md\n",
    "docs/arch.md": "x".repeat(700),
    ".claude/rules/api.md": "---\npaths: [src/**]\n---\nscoped",
    "packages/a/CLAUDE.md": "nested",
    ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploy to staging\n---\nlong body that is not loaded",
    ".claude/agents/reviewer.md": "---\ndescription: Reviews diffs\n---\nprompt",
    ".mcp.json": JSON.stringify({ mcpServers: { github: {}, db: {} } }),
  };
  for (const [p, content] of Object.entries(files)) await Bun.write(join(dir, p), content);
  await Bun.write(join(config, "CLAUDE.md"), "user prefs");
  return { dir, config };
}

describe("context report", () => {
  test("lists what loads at start, separates on-demand files", async () => {
    const { dir, config } = await setup();
    const r = await buildContextReport(dir, { configDir: config, ancestors: false });
    expect(r.items.map((i) => i.group)).toEqual(["memory", "memory", "memory", "skills", "agents"]);
    expect(r.items.map((i) => i.label).slice(1)).toEqual([
      "CLAUDE.md (project)",
      "docs/arch.md (import)",
      "skill deploy",
      "agent reviewer",
    ]);
    expect(r.items[0]!.label).toEndWith("CLAUDE.md (user)");
    expect(r.items.find((i) => i.label.startsWith("docs/arch.md"))?.importedBy).toBe("CLAUDE.md");
    expect(r.total).toBe(r.items.reduce((s, i) => s + i.tokens, 0));
    expect(r.onDemand.files).toBe(2);
    expect(r.mcpServers).toEqual(["github", "db"]);
    // skill body isn't counted, only name + description
    expect(r.items.find((i) => i.label === "skill deploy")!.tokens).toBeLessThan(25);
  });

  test("baseline comparison shows savings and removed items", async () => {
    const { dir, config } = await setup();
    const before = await buildContextReport(dir, { configDir: config, ancestors: false });
    await Bun.write(join(dir, "CLAUDE.md"), "# Project\n");
    const after = await buildContextReport(dir, { configDir: config, ancestors: false });
    const text = formatReport(after, before);
    expect(after.total).toBeLessThan(before.total);
    expect(text).toContain("removed: docs/arch.md (import)");
    expect(text).toContain("−");
  });
});
