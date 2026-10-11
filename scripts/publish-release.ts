/**
 * Publishes release/npm (built by build-release.ts): every platform package first, then the
 * main `claude-kit` package, so its optionalDependencies resolve the moment it's live.
 * Versions already on the registry are skipped, so a half-failed release can be re-run.
 *
 * Usage: bun scripts/publish-release.ts [--dry-run] [--provenance]
 */
import { $ } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "release", "npm");
const dryRun = Bun.argv.includes("--dry-run");
const provenance = Bun.argv.includes("--provenance");

async function published(name: string, version: string): Promise<boolean> {
  const res = await $`npm view ${`${name}@${version}`} version`.quiet().nothrow();
  return res.exitCode === 0 && res.stdout.toString().trim() === version;
}

async function publish(dir: string) {
  const { name, version } = (await Bun.file(join(dir, "package.json")).json()) as { name: string; version: string };
  if (!dryRun && (await published(name, version))) {
    console.log(`· ${name}@${version} already published, skipping`);
    return;
  }
  const flags = ["--access", "public", ...(dryRun ? ["--dry-run"] : []), ...(provenance ? ["--provenance"] : [])];
  await $`npm publish ${dir} ${flags}`.quiet();
  console.log(`✔ ${dryRun ? "[dry-run] " : ""}${name}@${version}`);
}

const platformRoot = join(OUT, "@claude-kit");
const platforms = (await readdir(platformRoot)).sort().map((d) => join(platformRoot, d));
if (platforms.length === 0) throw new Error("No platform packages in release/npm; run build-release.ts first.");
for (const dir of platforms) await publish(dir);
await publish(join(OUT, "claude-kit"));
