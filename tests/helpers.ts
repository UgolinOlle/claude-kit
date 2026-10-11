import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";

export const FIXTURES = join(import.meta.dir, "fixtures");

const temps: string[] = [];

/** Copy a fixture (or nothing) into a fresh temp dir outside any git repo. */
export async function tempProject(fixture?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-kit-test-"));
  temps.push(dir);
  if (fixture) await cp(join(FIXTURES, fixture), dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
