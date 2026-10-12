import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { GlobalOptions } from "../src/cli.ts";
import { runCompress } from "../src/commands/compress.ts";
import { runInit } from "../src/commands/init.ts";
import {
  assemble,
  parseSummaries,
  planSections,
  splitSections,
  summarizeDocument,
  summaryPrompt,
  type Summarizer,
  type SummaryRequest,
  trimToBudget,
} from "../src/core/summarize.ts";
import { COMPRESS_SKILL_PATH } from "../src/generators/extras.ts";
import { configureLogger } from "../src/utils/logger.ts";
import { estimateTokens } from "../src/utils/tokenCount.ts";

import { tempProject } from "./helpers.ts";

beforeAll(() => configureLogger({ silent: true }));

const prose = (topic: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `The team discussed ${topic} at length in meeting ${i} and shared many thoughts about its history.`,
  ).join(" ");

const DOC = [
  "# Payments service",
  prose("the origins of the service", 40),
  "## API",
  "`POST /v1/charges` creates a charge. Amount must be at least 50 cents.",
  "| field | type |",
  "| ----- | ---- |",
  "| amount | int |",
  "```ts",
  "await client.charges.create({ amount: 500 });",
  "await client.charges.list();",
  "```",
  "## Retries",
  `Retries happen up to 3 times. ${prose("retries", 30)}`,
  "## Culture",
  prose("team culture", 60),
  "## Roadmap",
  prose("future ideas", 60),
].join("\n");

/** Pretends to be the model: a short summary per section, recording what it was sent. */
function fakeSummarizer(log: SummaryRequest[] = []): Summarizer {
  return async (req) => {
    log.push(req);
    return new Map(
      req.sections.map((s) => [s.id, `- summary of ${s.heading ?? "intro"}`]),
    );
  };
}

const opts = (
  cwd: string,
  extra: Partial<GlobalOptions> = {},
): GlobalOptions => ({
  cwd,
  dryRun: false,
  yes: false,
  force: false,
  json: false,
  verbose: false,
  with: [],
  without: [],
  ...extra,
});

describe("hierarchical compression", () => {
  test("splits by heading and ranks fact-dense sections as critical", () => {
    const sections = splitSections(DOC);
    expect(sections.map((s) => s.heading)).toEqual([
      "# Payments service",
      "## API",
      "## Retries",
      "## Culture",
      "## Roadmap",
    ]);
    const api = sections[1]!;
    expect(api.critical).toBe(true);
    expect(api.importance).toBeGreaterThan(sections[3]!.importance);
    expect(sections[3]!.critical).toBe(false);
    // headings inside code fences don't split
    expect(
      splitSections("# A\n```\n# not a heading\n```\n## B\nx").map(
        (s) => s.heading,
      ),
    ).toEqual(["# A", "## B"]);
  });

  test("keeps critical sections, summarises others to ~30%, omits what does not fit", () => {
    const sections = splitSections(DOC);
    const total = sections.reduce((n, s) => n + s.tokens, 0);
    const plan = planSections(sections, Math.round(total * 0.2));
    expect(plan.get(1)).toEqual({ kind: "keep" });
    const kinds = [...plan.values()].map((a) => a.kind);
    expect(kinds).toContain("summarize");
    expect(kinds).toContain("omit");
    for (const [id, a] of plan)
      if (a.kind === "summarize")
        expect(a.target).toBe(Math.ceil(sections[id]!.tokens * 0.3));
  });

  test("trim re-measures after every omission and stops once it fits", () => {
    const sections = splitSections(DOC);
    const plan = new Map(
      sections.map((s) => [s.id, { kind: "keep" as const }]),
    );
    const target = 250;
    const text = trimToBudget(sections, plan, new Map(), "doc.md", target);
    expect(estimateTokens(text)).toBeLessThanOrEqual(target * 1.15);
    expect(plan.get(1)).toEqual({ kind: "keep" }); // critical goes last
    expect(text).toContain("_(omitted: doc.md L");
  });

  test("omitted and failed summaries point back to the source lines", () => {
    const sections = splitSections(DOC);
    const plan = new Map(
      sections.map((s) => [s.id, { kind: "summarize" as const, target: 10 }]),
    );
    const out = assemble(
      sections,
      plan,
      new Map([[2, "retries: 3"]]),
      "doc.md",
    );
    expect(out).toContain("## Retries\nretries: 3");
    expect(out).toContain(
      `## Culture\n_(omitted: doc.md L${sections[3]!.start}-${sections[3]!.end})_`,
    );
  });

  test("one call per document, with the targets in the prompt", async () => {
    const calls: SummaryRequest[] = [];
    const result = await summarizeDocument(
      DOC,
      "payments.md",
      0.2,
      fakeSummarizer(calls),
    );
    expect(calls).toHaveLength(1);
    expect(result.after).toBeLessThan(result.before * 0.35);
    expect(result.text).toStartWith("<!-- claude-kit summary of payments.md");
    expect(result.text).toContain("await client.charges.create"); // code kept verbatim
    expect(result.kept + result.summarized + result.omitted).toBe(5);
    const prompt = summaryPrompt(calls[0]!);
    expect(prompt).toMatch(
      /<section id="\d+" heading="[^"]+" target_tokens="\d+">/,
    );
  });

  test("parses summaries and ignores chatter around them", () => {
    expect(
      parseSummaries(
        'Sure!\n<summary id="2">- a</summary>\n<summary id="4">\n- b\n</summary> done',
      ),
    ).toEqual(
      new Map([
        [2, "- a"],
        [4, "- b"],
      ]),
    );
  });
});

describe("compress --summarize", () => {
  async function setup() {
    const dir = await tempProject();
    await Bun.write(join(dir, "docs/payments.md"), DOC.repeat(3));
    await Bun.write(join(dir, "docs/short.md"), "# Short\nfine as is\n");
    await Bun.write(join(dir, "src/a.ts"), "export const a = 1;\n");
    return dir;
  }

  test("asks before sending and sends nothing when declined", async () => {
    const dir = await setup();
    const questions: string[] = [];
    // no summarizer injected: the real API path, stopped at the consent question
    const code = await runCompress(opts(dir, { summarize: true }), ["docs"], {
      confirm: async (q) => (questions.push(q), false),
    });
    expect(code).toBe(1);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("to the Anthropic API (claude-opus-5-5, ~$");
  });

  test("refuses without a terminal unless --yes", async () => {
    const dir = await setup();
    const stdinTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      expect(
        await runCompress(opts(dir, { summarize: true }), ["docs/payments.md"]),
      ).toBe(2);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: stdinTTY,
        configurable: true,
      });
    }
  });

  test("skips small and non-prose files, validates options", async () => {
    const dir = await setup();
    const calls: SummaryRequest[] = [];
    const out: string[] = [];
    const orig = console.log;
    console.log = (s: string) => out.push(s);
    try {
      expect(
        await runCompress(
          opts(dir, { summarize: true, yes: true }),
          ["docs", "src"],
          {
            summarizer: fakeSummarizer(calls),
          },
        ),
      ).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(calls.map((c) => c.source)).toEqual([join("docs", "payments.md")]);
    expect(out.join("\n")).toContain("summary of");
    expect(
      await runCompress(opts(dir, { summarize: true, ratio: "2" }), ["docs"]),
    ).toBe(2);
    expect(
      await runCompress(opts(dir, { summarize: true, extract: true }), [
        "docs",
      ]),
    ).toBe(2);
  });
});

describe("compress-doc skill", () => {
  test("ships with the full preset and tells Claude to ask before summarising", async () => {
    const dir = await tempProject("bun-app");
    await runInit(opts(dir, { yes: true, preset: "full" }), {
      hookRuntime: "node",
      interactive: false,
    });
    const skill = await Bun.file(join(dir, COMPRESS_SKILL_PATH)).text();
    expect(skill).toStartWith("---\nname: compress-doc\ndescription: ");
    expect(skill).toContain("Ask the user first");
    expect(skill).toContain("compress --extract");
  });
});

describe("API summarizer", () => {
  const req: SummaryRequest = {
    source: "doc.md",
    sections: [{ id: 3, heading: "## A", text: "long text", target: 100 }],
  };

  function fakeClient(
    reply: { stop_reason: string; text: string },
    seen: unknown[],
  ) {
    return {
      beta: {
        messages: {
          stream: (params: unknown) => {
            seen.push(params);
            return {
              finalMessage: async () => ({
                stop_reason: reply.stop_reason,
                content: [{ type: "text", text: reply.text }],
              }),
            };
          },
        },
      },
    };
  }

  test("streams one request with fallbacks on supported models", async () => {
    const { apiSummarizer } = await import("../src/core/summarizeApi.ts");
    const seen: Record<string, unknown>[] = [];
    const summarize = apiSummarizer(
      "claude-opus-5-5",
      fakeClient(
        { stop_reason: "end_turn", text: '<summary id="3">- short</summary>' },
        seen,
      ) as never,
    );
    expect(await summarize(req)).toEqual(new Map([[3, "- short"]]));
    expect(seen[0]).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    expect(seen[0]!.max_tokens).toBe(4000);

    const older: Record<string, unknown>[] = [];
    await apiSummarizer(
      "claude-haiku-4-5",
      fakeClient({ stop_reason: "end_turn", text: "" }, older) as never,
    )(req);
    expect(older[0]).not.toHaveProperty("fallbacks");
  });

  test("a refusal is an error, not an empty summary", async () => {
    const { apiSummarizer } = await import("../src/core/summarizeApi.ts");
    const summarize = apiSummarizer(
      "claude-opus-5-5",
      fakeClient({ stop_reason: "refusal", text: "" }, []) as never,
    );
    await expect(summarize(req)).rejects.toThrow("declined");
  });
});
