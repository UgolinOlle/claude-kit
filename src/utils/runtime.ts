/**
 * Runtime-neutral helpers. claude-kit ships as plain JavaScript that runs on Node (>=20) and
 * on Bun, so runtime code uses these instead of Bun-only APIs (enforced by a test).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile as fsWriteFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';

import picomatch from 'picomatch';
import { parse as parseTomlText } from 'smol-toml';
import { glob as tinyGlob } from 'tinyglobby';
import { parse as parseYamlText } from 'yaml';

export const argv = (): string[] => process.argv.slice(2);

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function readFileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function readBytes(path: string, limit?: number): Promise<Uint8Array> {
  const buf = await readFile(path);
  return limit === undefined ? buf : buf.subarray(0, limit);
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await fsWriteFile(path, content);
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export const parseToml = (text: string): unknown => parseTomlText(text);
export const parseYaml = (text: string): unknown => parseYamlText(text);

/** Relative POSIX paths under `cwd` matching `pattern`. */
export async function glob(
  pattern: string,
  opts: { cwd: string; onlyFiles?: boolean; dot?: boolean; ignore?: string[] },
): Promise<string[]> {
  try {
    const found = await tinyGlob(pattern, {
      cwd: opts.cwd,
      onlyFiles: opts.onlyFiles ?? true,
      dot: opts.dot ?? false,
      expandDirectories: false,
      ignore: opts.ignore,
    });
    return found.map((p) => p.replace(/\/$/, ''));
  } catch {
    return []; // missing cwd behaves like an empty directory
  }
}

export function globMatcher(pattern: string): (path: string) => boolean {
  return picomatch(pattern, { dot: true });
}

/** Absolute path of an executable on PATH, or null. Honors PATHEXT on Windows. */
export function which(cmd: string): string | null {
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** Run a command, capture stdout; never throws. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}
