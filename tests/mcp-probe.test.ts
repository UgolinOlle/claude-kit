import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { compressMarkdown } from '../src/core/compress.ts';
import { extractKeyInfo, formatExtracted } from '../src/core/extract.ts';
import { expandVars, probeServer, similarTools } from '../src/core/mcpProbe.ts';
import { buildRuleContext } from '../src/rules/context.ts';
import { mcpToolCost } from '../src/rules/misc.ts';

import { tempProject } from './helpers.ts';

/** A minimal stdio MCP server: answers initialize and a paginated tools/list. */
const FAKE_SERVER = `
const tools = [
  { name: "search_by_title", description: "Search by title", inputSchema: { type: "object" } },
  { name: "search_by_author", description: "Search by author", inputSchema: { type: "object" } },
  { name: "search_by_tag", description: "Search by tag", inputSchema: { type: "object" } },
  { name: "export", description: "x".repeat(4000), inputSchema: { type: "object" } },
];
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    let result = {};
    if (msg.method === "tools/list")
      result = msg.params.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "p2" };
    console.log("log line that is not json");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

async function withServer() {
  const dir = await tempProject();
  await Bun.write(join(dir, 'fake.cjs'), FAKE_SERVER);
  return dir;
}

describe('MCP probe', () => {
  test('lists every page of tools and estimates their tokens', async () => {
    const dir = await withServer();
    const r = await probeServer(
      'fake',
      { command: process.execPath, args: ['${CLAUDE_PROJECT_DIR}/fake.cjs'] },
      dir,
    );
    expect(r.status).toBe('ok');
    expect(r.tools.map((t) => t.name)).toEqual([
      'search_by_title',
      'search_by_author',
      'search_by_tag',
      'export',
    ]);
    expect(r.tokens).toBeGreaterThan(1000);
  });

  test('reports failures and skips remote servers', async () => {
    const dir = await tempProject();
    expect(
      (await probeServer('x', { url: 'https://example.com/mcp', type: 'http' }, dir)).status,
    ).toBe('skipped');
    const crash = await probeServer(
      'x',
      { command: process.execPath, args: ['-e', 'process.exit(3)'] },
      dir,
    );
    expect(crash.status).toBe('failed');
    expect(crash.detail).toContain('code 3');
    const silent = await probeServer(
      'x',
      { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
      dir,
      300,
    );
    expect(silent.detail).toContain('no answer');
  });

  test('doctor rule runs only with --probe-mcp and suggests merging look-alike tools', async () => {
    const dir = await withServer();
    await Bun.write(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: ['fake.cjs'] } } }),
    );
    expect(await mcpToolCost.check(await buildRuleContext(dir))).toEqual([]);
    const [finding] = await mcpToolCost.check(await buildRuleContext(dir, { probeMcp: true }));
    expect(finding!.message).toContain('4 tools');
    expect(finding!.hint).toContain('3× search_by_*');
  });

  test('helpers', () => {
    expect(expandVars('${A}/${B:-def}/${C}', { A: 'a' })).toBe('a/def/');
    expect(similarTools(['getUserById', 'getUserByEmail', 'getUserByName', 'list'])).toEqual([
      { prefix: 'get_user', tools: ['getUserById', 'getUserByEmail', 'getUserByName'] },
    ]);
    expect(similarTools(['read', 'write'])).toEqual([]);
  });
});

describe('markdown compression', () => {
  test('drops badges, images, rules and table padding; keeps code verbatim', () => {
    const md = [
      '# Title',
      '[![ci](https://x/b.svg)](https://x) [![npm](https://x/n.svg)](https://n)',
      '',
      '![](decorative.png)',
      '![architecture](arch.png)',
      '<!-- note -->',
      '| name   | value |',
      '| :----- | ----: |',
      '| a \\| b | 1     |',
      '',
      '---',
      '```md',
      '| keep   | as is |',
      '---',
      '```',
      '',
      '',
      '',
      'Text with  two spaces   ',
    ].join('\n');
    expect(compressMarkdown(md)).toBe(
      [
        '# Title',
        '',
        '[image: architecture]',
        '|name|value|',
        '|:-|-:|',
        '|a \\| b|1|',
        '',
        '```md',
        '| keep   | as is |',
        '---',
        '```',
        '',
        'Text with  two spaces',
      ].join('\n'),
    );
  });
});

describe('key-info extraction', () => {
  const doc = [
    '# Payments',
    'This document was written to explain the history of the service.',
    '## Auth',
    'Every request must include a token. Tokens expire after 15 minutes.',
    '### `createCharge(input)`',
    '- `POST /v1/charges` creates a charge.',
    '| field | type |',
    '| ----- | ---- |',
    '| amount | int |',
    '```ts',
    'await client.charges.create({ amount: 500 });',
    '```',
    '**1. Retries.** Retries happen up to 3 times.',
  ].join('\n');

  test('keeps facts by kind with their section, drops narrative', () => {
    const x = extractKeyInfo(doc);
    expect(x.api.map((i) => i.text)).toEqual([
      '`createCharge(input)`',
      '`POST /v1/charges` creates a charge.',
    ]);
    expect(x.constraints.map((i) => [i.text, i.section])).toEqual([
      ['Every request must include a token.', 'Auth'],
    ]);
    expect(x.numbers.map((i) => i.text)).toEqual([
      'Tokens expire after 15 minutes.',
      '**1. Retries.** Retries happen up to 3 times.',
    ]);
    expect(x.tables[0]!.text).toBe('|field|type|\n|-----|----|\n|amount|int|');
    expect(x.code[0]!.text).toContain('client.charges.create');
    const md = formatExtracted('payments.md', x);
    expect(md).not.toContain('history');
    expect(md).toContain('### Auth\n- Every request must include a token. L4');
  });

  test('says so when nothing is found', () => {
    expect(formatExtracted('a.md', extractKeyInfo('Just a story.'))).toContain('No API references');
  });
});
