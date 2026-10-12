import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { readFileText, sha256Hex, writeFile } from "./runtime.ts";

/** Returns file contents, or null if the file does not exist. */
export async function readText(path: string): Promise<string | null> {
  return readFileText(path);
}

export async function readJson<T = unknown>(path: string): Promise<T | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve `rel` inside `root`, refusing paths that escape it. */
export function resolveInside(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back.startsWith("..") || isAbsolute(back)) {
    throw new Error(`Refusing to touch path outside project root: ${rel}`);
  }
  return abs;
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export async function writeAtomic(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.claude-kit.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

export function sha256(content: string): string {
  return sha256Hex(content);
}

/** Heuristic binary check: a NUL byte in the first 8KB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
