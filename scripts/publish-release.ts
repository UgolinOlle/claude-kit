/**
 * Publishes release/npm/claude-kit (built by build-release.ts). Skips a version that's already
 * on the registry, so a release job can be re-run safely.
 *
 * Usage: bun scripts/publish-release.ts [--dry-run] [--provenance]
 */
import { join } from "node:path";

import { $ } from "bun";

const DIR = join(import.meta.dir, "..", "release", "npm", "claude-kit");
const dryRun = Bun.argv.includes("--dry-run");
const provenance = Bun.argv.includes("--provenance");

const { name, version } = (await Bun.file(
  join(DIR, "package.json"),
).json()) as {
  name: string;
  version: string;
};

const existing = await $`npm view ${`${name}@${version}`} version`
  .quiet()
  .nothrow();
if (
  !dryRun &&
  existing.exitCode === 0 &&
  existing.stdout.toString().trim() === version
) {
  console.log(`· ${name}@${version} already published, skipping`);
  process.exit(0);
}

const flags = [
  "--access",
  "public",
  ...(dryRun ? ["--dry-run"] : []),
  ...(provenance ? ["--provenance"] : []),
];
const res = await $`npm publish ${DIR} ${flags}`.quiet().nothrow();
if (res.exitCode !== 0) {
  // Show npm's own output in full; the shell error alone truncates it.
  console.error(res.stderr.toString());
  throw new Error(
    `npm publish failed for ${name}@${version} (exit ${res.exitCode})`,
  );
}
console.log(`✔ ${dryRun ? "[dry-run] " : ""}${name}@${version}`);
