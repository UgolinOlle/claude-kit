import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import { buildContextReport, formatReport } from "../src/commands/context.ts";
import {
  apiCounter,
  describeCountError,
  framedCounter,
} from "../src/core/exactCount.ts";

import { tempProject } from "./helpers.ts";

async function setup() {
  const dir = await tempProject();
  const config = join(dir, ".fake-config");
  const files: Record<string, string> = {
    "CLAUDE.md": "# Project\n<!-- free -->\n@docs/arch.md\n",
    "docs/arch.md": "x".repeat(700),
    ".claude/rules/api.md": "---\npaths: [src/**]\n---\nscoped",
    "packages/a/CLAUDE.md": "nested",
    ".claude/skills/deploy/SKILL.md":
      "---\nname: deploy\ndescription: Deploy to staging\n---\nlong body that is not loaded",
    ".claude/agents/reviewer.md":
      "---\ndescription: Reviews diffs\n---\nprompt",
    ".mcp.json": JSON.stringify({ mcpServers: { github: {}, db: {} } }),
  };
  for (const [p, content] of Object.entries(files))
    await Bun.write(join(dir, p), content);
  await Bun.write(join(config, "CLAUDE.md"), "user prefs");
  return { dir, config };
}

describe("context report", () => {
  test("lists what loads at start, separates on-demand files", async () => {
    const { dir, config } = await setup();
    const r = await buildContextReport(dir, {
      configDir: config,
      ancestors: false,
    });
    expect(r.items.map((i) => i.group)).toEqual([
      "memory",
      "memory",
      "memory",
      "skills",
      "agents",
    ]);
    expect(r.items.map((i) => i.label).slice(1)).toEqual([
      "CLAUDE.md (project)",
      "docs/arch.md (import)",
      "skill deploy",
      "agent reviewer",
    ]);
    expect(r.items[0]!.label).toEndWith("CLAUDE.md (user)");
    expect(
      r.items.find((i) => i.label.startsWith("docs/arch.md"))?.importedBy,
    ).toBe("CLAUDE.md");
    expect(r.total).toBe(r.items.reduce((s, i) => s + i.tokens, 0));
    expect(r.onDemand.files).toBe(2);
    expect(r.mcpServers).toEqual(["github", "db"]);
    // skill body isn't counted, only name + description
    expect(
      r.items.find((i) => i.label === "skill deploy")!.tokens,
    ).toBeLessThan(25);
  });

  test("baseline comparison shows savings and removed items", async () => {
    const { dir, config } = await setup();
    const before = await buildContextReport(dir, {
      configDir: config,
      ancestors: false,
    });
    await Bun.write(join(dir, "CLAUDE.md"), "# Project\n");
    const after = await buildContextReport(dir, {
      configDir: config,
      ancestors: false,
    });
    const text = formatReport(after, before);
    expect(after.total).toBeLessThan(before.total);
    expect(text).toContain("removed: docs/arch.md (import)");
    expect(text).toContain("−");
  });
});

describe("--exact counting", () => {
  // Fake count_tokens endpoint: 7 tokens of framing + 1 token per 4 chars.
  function fakeApi(status = 200) {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          model: string;
          messages: { content: string }[];
        };
        seen.push(`${new URL(req.url).pathname} ${body.model}`);
        if (status !== 200)
          return Response.json(
            {
              type: "error",
              error: { type: "authentication_error", message: "bad key" },
            },
            { status },
          );
        return Response.json({
          input_tokens: 7 + Math.ceil(body.messages[0]!.content.length / 4),
        });
      },
    });
    return {
      server,
      seen,
      client: new Anthropic({
        apiKey: "test",
        baseURL: server.url.toString().replace(/\/$/, ""),
        maxRetries: 0,
      }),
    };
  }

  test("subtracts message framing and goes through the SDK", async () => {
    const { server, seen, client } = fakeApi();
    try {
      const counter = await framedCounter(
        apiCounter("claude-opus-5-5", client),
      );
      expect(await counter("x".repeat(400))).toBe(100);
      expect(await counter("   ")).toBe(0);
      expect(seen[0]).toBe("/v1/messages/count_tokens claude-opus-5-5");
    } finally {
      server.stop(true);
    }
  });

  test("report switches to exact counts", async () => {
    const { dir, config } = await setup();
    const counter = async (t: string) => t.length; // deterministic stand-in
    const r = await buildContextReport(dir, {
      configDir: config,
      ancestors: false,
      counter,
      model: "m",
    });
    expect(r.method).toEqual({ kind: "exact", model: "m" });
    expect(
      r.items.find((i) => i.label === "docs/arch.md (import)")!.tokens,
    ).toBe(700);
    expect(formatReport(r)).toContain("exact counts (m tokenizer)");
  });

  test("auth failures become a readable message", async () => {
    const { server, client } = fakeApi(401);
    try {
      const err = await apiCounter(
        "claude-opus-5-5",
        client,
      )("x").catch((e) => e);
      expect(describeCountError(err)).toContain("ant auth login");
    } finally {
      server.stop(true);
    }
  });
});
