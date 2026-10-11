#!/usr/bin/env node
// Thin Node launcher for the published `claude-kit` package.
// npm installs exactly one @claude-kit/<platform>-<arch> optional dependency holding a
// compiled Bun binary; this script finds it and hands over argv, stdio and exit code.
"use strict";

const { spawnSync } = require("node:child_process");

const target = `${process.platform}-${process.arch}`;
const pkg = `@claude-kit/${target}`;
const exe = process.platform === "win32" ? "claude-kit.exe" : "claude-kit";

function resolveBinary() {
  if (process.env.CLAUDE_KIT_BINARY) return process.env.CLAUDE_KIT_BINARY;
  try {
    return require.resolve(`${pkg}/bin/${exe}`);
  } catch {
    console.error(
      [
        `claude-kit: no prebuilt binary found for ${target} (expected package ${pkg}).`,
        "  • If you installed with --omit=optional / --no-optional, reinstall without it.",
        "  • If your platform isn't supported, run from source with Bun: bunx claude-kit",
      ].join("\n"),
    );
    process.exit(1);
  }
}

const result = spawnSync(resolveBinary(), process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`claude-kit: failed to start binary: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
