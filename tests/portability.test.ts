import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempProject } from './helpers.ts';

const ROOT = join(import.meta.dir, '..');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('portability: the published CLI runs on Node and Bun', () => {
  test('runtime code uses no Bun-only APIs', async () => {
    const offenders: string[] = [];
    for (const file of [...(await sourceFiles(join(ROOT, 'src'))), join(ROOT, 'index.ts')]) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        if (/\bBun\.[A-Za-z$]|import\.meta\.(dir|main|path)\b|from ['"]bun['"]/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  const node = Bun.which('node');
  test.skipIf(!node)('the Node bundle runs init and doctor end to end', async () => {
    const out = join(await tempProject(), 'cli.mjs');
    const result = await Bun.build({
      entrypoints: [join(ROOT, 'index.ts')],
      target: 'node',
      format: 'esm',
    });
    expect(result.success).toBe(true);
    // The optional embeddings runtime is loaded from the user cache, never bundled.
    const code = await result.outputs[0]!.text();
    expect(code).not.toContain('FeatureExtractionPipeline');
    expect(code).not.toContain('InferenceSession');
    await Bun.write(out, result.outputs[0]!);

    const proj = await tempProject('bun-app');
    const runNode = async (...args: string[]) => {
      const proc = Bun.spawn([node!, out, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        code: await proc.exited,
        stdout: await new Response(proc.stdout).text(),
      };
    };
    expect((await runNode('init', '--preset', 'full', '--yes', '--cwd', proj)).code).toBe(0);
    const doctor = await runNode('doctor', '--json', '--cwd', proj);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout).score).toBe(100);
  });
});
