import { describe, expect, test } from 'bun:test';

import {
  deepMergeJson,
  LINES_HEADER,
  mergeJsonText,
  mergeLines,
  mergeRegions,
  region,
} from '../src/core/merge.ts';

describe('mergeRegions', () => {
  const gen = `# Project\n\n${region('stack', 'Bun + React')}\n\n${region('workflow', 'Use plan mode')}\n`;

  test('replaces region bodies, keeps everything outside', () => {
    const existing = `# My title\n\nMy notes.\n\n${region('stack', 'old stack')}\n\nMore notes.\n\n${region('workflow', 'old')}\n`;
    const out = mergeRegions(existing, gen);
    expect(out).toContain('# My title\n\nMy notes.');
    expect(out).toContain('More notes.');
    expect(out).toContain('Bun + React');
    expect(out).not.toContain('old stack');
  });

  test('appends brand-new regions', () => {
    const existing = `# Mine\n\n${region('stack', 'x')}\n`;
    const out = mergeRegions(existing, gen);
    expect(out).toContain('Use plan mode');
    expect(out.indexOf('Use plan mode')).toBeGreaterThan(out.indexOf('Bun + React'));
  });

  test('a region the user deleted stays deleted', () => {
    const existing = `# Mine\n\n${region('stack', 'x')}\n`;
    const out = mergeRegions(existing, gen, gen);
    expect(out).not.toContain('Use plan mode');
  });

  test('is idempotent', () => {
    const once = mergeRegions(`notes\n`, gen);
    expect(mergeRegions(once, gen)).toBe(once);
  });
});

describe('JSON deep merge', () => {
  test('unions arrays, keeps user scalars, adds new keys', () => {
    const existing = {
      model: 'sonnet',
      permissions: { deny: ['Read(./.env)'], allow: ['Bash(ls)'] },
    };
    const generated = {
      model: 'opusplan',
      permissions: { deny: ['Read(./.env)', 'Read(./dist/**)'] },
      statusLine: { type: 'command' },
    };
    expect(deepMergeJson(existing, generated)).toEqual({
      model: 'sonnet',
      permissions: { deny: ['Read(./.env)', 'Read(./dist/**)'], allow: ['Bash(ls)'] },
      statusLine: { type: 'command' },
    });
  });

  test('dedupes object array items by value', () => {
    const hook = { matcher: 'Edit', hooks: [{ type: 'command', command: 'x' }] };
    expect(deepMergeJson({ a: [hook] }, { a: [hook] })).toEqual({ a: [hook] });
  });

  test('3-way: user-deleted items stay deleted, items we dropped are removed', () => {
    const previous = { permissions: { deny: ['Read(a)', 'Read(b)', 'Read(c)'] } };
    const existing = { permissions: { deny: ['Read(a)', 'Read(c)', 'Read(mine)'] } }; // user removed b, added mine
    const generated = { permissions: { deny: ['Read(a)', 'Read(b)', 'Read(d)'] } }; // we dropped c, added d
    expect(deepMergeJson(existing, generated, previous)).toEqual({
      permissions: { deny: ['Read(a)', 'Read(mine)', 'Read(d)'] },
    });
  });

  test('3-way scalars: untouched values follow the template, edited values stay', () => {
    const previous = { model: 'opusplan', statusLine: { type: 'command', command: 'old' } };
    const generated = { model: 'best', statusLine: { type: 'command', command: 'new' } };
    expect(deepMergeJson(previous, generated, previous)).toEqual(generated);
    expect(deepMergeJson({ ...previous, model: 'haiku' }, generated, previous)).toMatchObject({
      model: 'haiku',
    });
  });

  test("3-way keys: a key the user deleted isn't re-added; a key we dropped is removed", () => {
    const previous = { a: 1, b: 2 };
    expect(deepMergeJson({ a: 1 }, { a: 1, b: 2 }, previous)).toEqual({ a: 1 });
    expect(deepMergeJson({ a: 1, b: 2 }, { a: 1 }, previous)).toEqual({ a: 1 });
    expect(deepMergeJson({ a: 1, b: 3 }, { a: 1 }, previous)).toEqual({ a: 1, b: 3 }); // user changed it → keep
  });

  test('refuses to merge invalid JSON', () => {
    expect(() => mergeJsonText('{ nope', '{}')).toThrow('not valid JSON');
  });
});

describe('mergeLines', () => {
  test('keeps user file verbatim and appends missing lines once', () => {
    const existing = '# mine\nnode_modules/\n';
    const out = mergeLines(existing, 'node_modules/\ndist/\n.env\n');
    expect(out).toBe(`# mine\nnode_modules/\n\n${LINES_HEADER}\ndist/\n.env\n`);
    expect(mergeLines(out, 'node_modules/\ndist/\n.env\n')).toBe(out);
  });

  test('does not repeat the header on later additions', () => {
    const first = mergeLines('a\n', 'b\n');
    const second = mergeLines(first, 'c\n');
    expect(second.split(LINES_HEADER).length).toBe(2);
    expect(second).toEndWith('c\n');
  });

  test("3-way: lines the user deleted aren't re-added, lines we dropped are removed", () => {
    const previous = 'node_modules/\ndist/\ncoverage/\n';
    const existing = '# mine\nnode_modules/\ncoverage/\nsecret/\n'; // user removed dist/, added secret/
    const generated = 'node_modules/\ndist/\n.next/\n'; // we dropped coverage/, added .next/
    expect(mergeLines(existing, generated, previous)).toBe(
      `# mine\nnode_modules/\nsecret/\n\n${LINES_HEADER}\n.next/\n`,
    );
  });
});
