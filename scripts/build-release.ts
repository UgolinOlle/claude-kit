/**
 * Builds the publishable npm package in release/npm/claude-kit:
 *   bin/claude-kit.mjs  the whole CLI bundled into one JavaScript file (dependencies inlined)
 *   package.json        no runtime dependencies, so installs are instant
 *   README.md
 * The same file runs on Node (>=20) and Bun, on macOS, Linux and Windows.
 *
 * Usage: bun scripts/build-release.ts
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import pkg from "../package.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "release", "npm", "claude-kit");
const ENTRY = "bin/claude-kit.mjs";

async function writeJson(path: string, data: unknown) {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

if (import.meta.main) {
  await rm(join(ROOT, "release"), { recursive: true, force: true });
  await mkdir(join(OUT, "bin"), { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "index.ts")],
    target: "node",
    format: "esm",
    minify: true,
    banner: "#!/usr/bin/env node",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Bundling failed");
  }
  await Bun.write(join(OUT, ENTRY), result.outputs[0]!);
  await chmod(join(OUT, ENTRY), 0o755);
  if (await Bun.file(join(ROOT, "README.md")).exists()) {
    await cp(join(ROOT, "README.md"), join(OUT, "README.md"));
  }

  await writeJson(join(OUT, "package.json"), {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: "module",
    bin: { "claude-kit": ENTRY },
    files: ["bin", "README.md"],
    engines: { node: ">=20" },
    keywords: [
      "claude",
      "claude-code",
      "claude-md",
      "context",
      "tokens",
      "cli",
    ],
    // npm provenance rejects a package whose `repository` doesn't match the repo that built it.
    repository: pkg.repository,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
  });

  const size = Bun.file(join(OUT, ENTRY)).size;
  console.log(
    `✔ ${pkg.name}@${pkg.version} → ${OUT} (${(size / 1024 / 1024).toFixed(1)} MB)`,
  );
}
