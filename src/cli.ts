import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { runAdd } from "./commands/add.ts";
import { runCompress } from "./commands/compress.ts";
import { runContext } from "./commands/context.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runInit } from "./commands/init.ts";
import { runUpgrade } from "./commands/upgrade.ts";
import { buildContext } from "./core/context.ts";
import { c, configureLogger, log } from "./utils/logger.ts";
import { formatTokens } from "./utils/tokenCount.ts";

export interface GlobalOptions {
  cwd: string;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
  verbose: boolean;
  preset?: string;
  with: string[];
  without: string[];
  fix?: boolean;
  check?: boolean;
  failOn?: string;
  format?: string;
  baseline?: string;
  outline?: boolean;
  exact?: boolean;
  model?: string;
}

type Command = {
  summary: string;
  run(opts: GlobalOptions, positionals: string[]): Promise<number>;
};

const commands: Record<string, Command> = {
  init: {
    summary: "Set up Claude Code context files for this project",
    run: (opts) => runInit(opts),
  },
  sync: {
    summary: "Re-apply the recorded setup (e.g. after editing .claudeignore)",
    run: (opts) => runInit(opts, { sync: true }),
  },
  doctor: {
    summary: "Audit the setup and print a prioritized fix list",
    run: (opts) => runDoctor(opts),
  },
  context: {
    summary: "Estimate the tokens a cold session loads from this repo and ~/.claude",
    run: (opts) => runContext(opts),
  },
  compress: {
    summary: "Print files with comments/blank lines stripped, or --outline for declarations",
    run: (opts, paths) => runCompress(opts, paths),
  },
  add: { summary: "Scaffold a component: `add mcp <name>` (MCP server stub + .mcp.json)", run: (opts, args) => runAdd(opts, args) },
  upgrade: {
    summary: "Re-apply this version\'s templates; reports what changed and newer releases",
    run: (opts) => runUpgrade(opts),
  },
  detect: {
    summary: "Show what claude-kit detects about this project",
    run: runDetect,
  },
};

async function runDetect(opts: GlobalOptions): Promise<number> {
  const ctx = await buildContext(opts.cwd);
  const size = await ctx.size();
  if (opts.json) {
    const { size: _, ...rest } = ctx;
    console.log(JSON.stringify({ ...rest, size }, null, 2));
    return 0;
  }
  log.info(c.bold(ctx.root));
  log.info(
    `  stacks     ${ctx.stacks.map((s) => `${s.id} (${s.manager})`).join(", ") || c.dim("none detected")}`,
  );
  log.info(
    `  monorepo   ${ctx.monorepo.isMonorepo ? `${ctx.monorepo.tools.join(", ")} — ${ctx.monorepo.packages.length} package${ctx.monorepo.packages.length === 1 ? "" : "s"}` : "no"}`,
  );
  log.info(
    `  size       ${size.files} files, ~${formatTokens(size.estTokens)} tokens (${size.source})${size.needsRag ? c.yellow("  → RAG recommended") : ""}`,
  );
  const have = Object.entries(ctx.existing)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log.info(`  existing   ${have.join(", ") || c.dim("nothing yet")}`);
  return 0;
}

function help(): string {
  const rows = Object.entries(commands).map(
    ([name, cmd]) => `  ${name.padEnd(10)} ${cmd.summary}`,
  );
  return `${c.bold("claude-kit")} ${pkg.version} — optimize a repo for Claude Code

Usage: claude-kit <command> [options]

Commands:
${rows.join("\n")}

Options:
  --cwd <dir>   Project root (default: current directory)
  --preset <p>  init: minimal | standard | full
  --with <f>    init: add features (repeatable or comma-separated)
  --without <f> init: remove features
  --fix         doctor: apply automatic fixes
  --check       doctor: exit 1 on findings at or above --fail-on (for CI)
  --fail-on <s> doctor --check threshold: error (default) | warn | info
  --format <f>  doctor: text | json | github (annotations)
  --baseline <file>  context: compare with a saved "context --json" report
  --outline     compress: declarations with line numbers only
  --exact       context: real counts via the Anthropic token-counting API (sends file text)
  --model <id>  context --exact: tokenizer model (default claude-opus-5-5)
  --dry-run     Show what would change, write nothing
  -y, --yes     Non-interactive; keep edited files on conflict
  --force       Non-interactive; overwrite on conflict
  --json        Machine-readable output
  -v, --verbose Debug logging
  -h, --help    Show help
  --version     Show version`;
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cwd: { type: "string" },
        preset: { type: "string" },
        with: { type: "string", multiple: true },
        without: { type: "string", multiple: true },
        fix: { type: "boolean", default: false },
        check: { type: "boolean", default: false },
        "fail-on": { type: "string" },
        format: { type: "string" },
        baseline: { type: "string" },
        outline: { type: "boolean", default: false },
        exact: { type: "boolean", default: false },
        model: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  const [name, ...rest] = positionals;
  if (values.help || !name) {
    console.log(help());
    return values.help ? 0 : 1;
  }
  const cmd = commands[name];
  if (!cmd) {
    log.error(`Unknown command: ${name}`);
    console.log(help());
    return 2;
  }

  configureLogger({ verbose: values.verbose, silent: values.json || values.format === "json" || values.format === "github" });
  const opts: GlobalOptions = {
    cwd: values.cwd ?? process.cwd(),
    dryRun: values["dry-run"],
    yes: values.yes,
    force: values.force,
    json: values.json,
    verbose: values.verbose,
    preset: values.preset,
    with: splitList(values.with),
    without: splitList(values.without),
    fix: values.fix,
    check: values.check,
    failOn: values["fail-on"],
    format: values.format,
    baseline: values.baseline,
    outline: values.outline,
    exact: values.exact,
    model: values.model,
  };
  try {
    return await cmd.run(opts, rest);
  } catch (err) {
    log.error((err as Error).message);
    if (opts.verbose) console.error(err);
    return 1;
  }
}

const splitList = (vals: string[] | undefined) => (vals ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
