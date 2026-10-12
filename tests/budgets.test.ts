import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { buildContextReport } from '../src/commands/context.ts';
import { searchTools } from '../src/commands/search.ts';
import { DEFAULT_BUDGETS, loadConfig } from '../src/core/config.ts';
import { handleMessage } from '../src/mcp/stdioServer.ts';
import { buildRuleContext } from '../src/rules/context.ts';
import { projectRulesBudget } from '../src/rules/misc.ts';

import { tempProject } from './helpers.ts';

const memory = (dir: string) => ({ configDir: join(dir, '.fake-config') });
const CLAUDE_MD = `# App\n\n${'- A rule Claude should follow on every task in this repository.\n'.repeat(80)}`;

async function project(config?: unknown) {
  const dir = await tempProject();
  await Bun.write(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  await Bun.write(join(dir, 'CLAUDE.local.md'), 'x '.repeat(5000)); // personal: not counted
  if (config) await Bun.write(join(dir, '.claude-kit/config.json'), JSON.stringify(config));
  return dir;
}

describe('token budgets', () => {
  test("defaults are the article's numbers; bad values are refused", async () => {
    const dir = await tempProject();
    expect((await loadConfig(dir)).budgets).toEqual(DEFAULT_BUDGETS);
    expect(DEFAULT_BUDGETS).toEqual({
      project_rules: 800,
      tool_definitions: 12_000,
      retrieved_context: 15_000,
    });
    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ budgets: { response: 1 } }),
    );
    await expect(loadConfig(dir)).rejects.toThrow('unknown budget "response"');
    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ budgets: { project_rules: -5 } }),
    );
    await expect(loadConfig(dir)).rejects.toThrow('positive number');
  });

  test('project_rules: info against the default, warn against a chosen budget, silent under it', async () => {
    const byDefault = await projectRulesBudget.check(
      await buildRuleContext(await project(), { memory: memory('x') }),
    );
    expect(byDefault).toHaveLength(1);
    expect(byDefault[0]!.severity).toBe('info');
    expect(byDefault[0]!.message).toContain("the article's default");
    expect(byDefault[0]!.message).not.toContain('CLAUDE.local.md');

    const chosen = await projectRulesBudget.check(
      await buildRuleContext(await project({ budgets: { project_rules: 500 } }), {
        memory: memory('x'),
      }),
    );
    expect(chosen[0]!.severity).toBe('warn');

    const roomy = await projectRulesBudget.check(
      await buildRuleContext(await project({ budgets: { project_rules: 5000 } }), {
        memory: memory('x'),
      }),
    );
    expect(roomy).toEqual([]);
  });

  test('context reports the same number as doctor', async () => {
    const dir = await project({ budgets: { project_rules: 1000 } });
    const r = await buildContextReport(dir, memory(dir));
    expect(r.budget!.limit).toBe(1000);
    const claudeMd = r.items.find((i) => i.label.startsWith('CLAUDE.md'))!;
    expect(r.budget!.projectRules).toBe(claudeMd.tokens);
  });

  test('retrieved_context caps what search_code returns', async () => {
    const dir = await tempProject();
    const body = Array.from(
      { length: 40 },
      (_, i) => `  const widgetValue${i} = computeWidget(${i});`,
    ).join('\n');
    for (const name of ['a', 'b', 'c'])
      await Bun.write(
        join(dir, `src/${name}.ts`),
        `export function widget_${name}() {\n${body}\n}\n`,
      );
    await Bun.write(
      join(dir, '.claude-kit/config.json'),
      JSON.stringify({ budgets: { retrieved_context: 600 } }),
    );
    const res = (await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'search_code',
          arguments: { query: 'widget', include_code: true, max_tokens: 50_000 },
        },
      },
      { name: 'code-search', version: '0' },
      searchTools(dir),
    )) as { result: { content: { text: string }[] } };
    const text = res.result.content[0]!.text;
    expect(text.match(/```/g)!.length / 2).toBe(1); // one ~500-token chunk fits, two don't
  });
});
