import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import type { GlobalOptions } from '../cli.ts';
import { compressText, outlineText } from '../core/compress.ts';
import { looksBinary } from '../utils/fsSafe.ts';
import { c, log } from '../utils/logger.ts';
import { estimateTokens, formatTokens } from '../utils/tokenCount.ts';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'vendor',
]);

async function expand(path: string, acc: string[] = []): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    acc.push(path);
    return acc;
  }
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      await expand(join(path, entry.name), acc);
    else if (entry.isFile()) acc.push(join(path, entry.name));
  }
  return acc;
}

/** `claude-kit compress [--outline] <path…>`: prints compressed content to stdout, stats to stderr. */
export async function runCompress(opts: GlobalOptions, paths: string[]): Promise<number> {
  if (paths.length === 0) {
    log.error('Usage: claude-kit compress [--outline] <file or dir>…');
    return 2;
  }
  let before = 0;
  let after = 0;
  let count = 0;
  for (const p of paths) {
    let files: string[];
    try {
      files = await expand(resolve(opts.cwd, p));
    } catch {
      log.error(`Not found: ${p}`);
      return 1;
    }
    for (const file of files) {
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      if (looksBinary(bytes)) continue;
      const text = new TextDecoder().decode(bytes);
      const out = (opts.outline ? outlineText(file, text) : null) ?? compressText(file, text);
      const tIn = estimateTokens(text);
      const tOut = estimateTokens(out);
      before += tIn;
      after += tOut;
      count++;
      const rel = relative(opts.cwd, file) || file;
      if (files.length > 1 || paths.length > 1)
        console.log(`=== ${rel} (${formatTokens(tIn)} → ${formatTokens(tOut)} tokens) ===`);
      console.log(out);
    }
  }
  const saved = before ? Math.round(100 * (1 - after / before)) : 0;
  if (!opts.json)
    console.error(
      c.dim(
        `${count} file${count === 1 ? '' : 's'}: ~${formatTokens(before)} → ~${formatTokens(after)} tokens (−${saved}%)`,
      ),
    );
  return 0;
}
