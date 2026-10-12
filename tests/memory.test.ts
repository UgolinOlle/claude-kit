import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  discoverMemory,
  parseImports,
  projectDirName,
  stripBlockComments,
} from "../src/core/memory.ts";

import { tempProject } from "./helpers.ts";

describe("stripBlockComments", () => {
  test("drops block comments (single and multi-line), keeps those in code fences", () => {
    const text =
      "# T\n<!-- one -->\nkeep\n<!--\nmulti\n-->\n```\n<!-- in code -->\n```\n";
    expect(stripBlockComments(text)).toBe(
      "# T\nkeep\n```\n<!-- in code -->\n```\n",
    );
  });
});

describe("parseImports", () => {
  test("finds @paths, skipping code spans, fences and emails", () => {
    const text =
      "See @docs/a.md, and `@not-this`.\nmail me@example.com\n```\n@fenced.md\n```\n@~/x.md";
    expect(parseImports(text)).toEqual([
      { spec: "docs/a.md", line: 1 },
      { spec: "~/x.md", line: 6 },
    ]);
  });
});

async function project(files: Record<string, string>) {
  const dir = await tempProject();
  for (const [p, content] of Object.entries(files))
    await Bun.write(join(dir, p), content);
  return dir;
}

describe("discoverMemory", () => {
  test("follows imports up to 4 hops and records missing ones", async () => {
    const dir = await project({
      "CLAUDE.md": "@a.md\n@missing.md\n",
      "a.md": "@b.md",
      "b.md": "@c.md",
      "c.md": "@d.md",
      "d.md": "@e.md",
      "e.md": "too deep",
    });
    const files = await discoverMemory(dir, {
      configDir: join(dir, ".fake-config"),
      ancestors: false,
    });
    expect(files.map((f) => f.display)).toEqual([
      "CLAUDE.md",
      "a.md",
      "b.md",
      "c.md",
      "d.md",
    ]);
    expect(files[0]!.missingImports).toEqual([{ spec: "missing.md", line: 2 }]);
    expect(files[1]!.importedBy).toBe("CLAUDE.md");
  });

  test("scopes: rules with paths and nested files load on demand; AGENTS.md ignored when CLAUDE.md exists", async () => {
    const dir = await project({
      "CLAUDE.md": "root",
      "AGENTS.md": "agents",
      ".claude/rules/always.md": "always",
      ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\nonly api",
      "packages/web/CLAUDE.md": "web",
      "node_modules/x/CLAUDE.md": "skip",
    });
    const files = await discoverMemory(dir, {
      configDir: join(dir, ".fake-config"),
      ancestors: false,
    });
    const by = Object.fromEntries(
      files.map((f) => [f.display, f.loadedAtStart]),
    );
    expect(by).toEqual({
      "CLAUDE.md": true,
      ".claude/rules/always.md": true,
      ".claude/rules/api.md": false,
      "packages/web/CLAUDE.md": false,
    });
  });

  test("AGENTS.md is used when there's no CLAUDE.md", async () => {
    const dir = await project({ "AGENTS.md": "agents" });
    const files = await discoverMemory(dir, {
      configDir: join(dir, ".fake-config"),
      ancestors: false,
    });
    expect(files.map((f) => [f.display, f.scope])).toEqual([
      ["AGENTS.md", "agents-md"],
    ]);
  });

  test("user CLAUDE.md and truncated auto memory come from the config dir", async () => {
    const dir = await project({ "CLAUDE.md": "<!-- free -->\nx" });
    const config = join(dir, ".fake-config");
    await Bun.write(join(config, "CLAUDE.md"), "user prefs");
    const long = Array.from({ length: 300 }, (_, i) => `- memory ${i}`).join(
      "\n",
    );
    await Bun.write(
      join(config, "projects", projectDirName(dir), "memory", "MEMORY.md"),
      long,
    );

    const files = await discoverMemory(dir, {
      configDir: config,
      ancestors: false,
    });
    const auto = files.find((f) => f.scope === "auto-memory")!;
    expect(files.find((f) => f.scope === "user")?.content).toBe("user prefs");
    expect(auto.lines).toBe(300);
    expect(auto.content.split("\n").length).toBe(200);
    expect(files.find((f) => f.display === "CLAUDE.md")?.content).toBe("x"); // comment stripped
  });
});
