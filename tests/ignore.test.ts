import { describe, expect, test } from 'bun:test';

import { buildIgnoreFile, ignoreToDenyRules } from '../src/core/ignore.ts';

describe('ignoreToDenyRules', () => {
  const rules = (...lines: string[]) => ignoreToDenyRules(lines);

  test('directory patterns cover contents at any depth', () => {
    expect(rules('node_modules/')).toEqual(['Read(**/node_modules/**)']);
  });

  test('file-like and glob patterns stay bare (gitignore: any depth)', () => {
    expect(rules('*.log', 'package-lock.json', 'id_rsa*')).toEqual([
      'Read(*.log)',
      'Read(package-lock.json)',
      'Read(id_rsa*)',
    ]);
  });

  test('ambiguous bare names cover both the path and its contents', () => {
    expect(rules('dist')).toEqual(['Read(dist)', 'Read(**/dist/**)']);
  });

  test('leading or middle slash anchors to the project root', () => {
    expect(rules('/build', 'docs/generated/', 'src/**/*.gen.ts')).toEqual([
      'Read(/build)',
      'Read(/build/**)',
      'Read(/docs/generated/**)',
      'Read(/src/**/*.gen.ts)',
    ]);
  });

  test('negations are kept in order, comments and blanks dropped', () => {
    expect(rules('# secrets', '', '.env.*', '!.env.example')).toEqual([
      'Read(.env.*)',
      'Read(!.env.example)',
    ]);
  });

  test('dedupes and supports Edit rules', () => {
    expect(ignoreToDenyRules(['dist/', 'dist/'], 'Edit')).toEqual(['Edit(**/dist/**)']);
  });
});

describe('buildIgnoreFile', () => {
  test('dedupes across sections and drops empty sections', () => {
    const out = buildIgnoreFile('# header', [
      { title: 'a', patterns: ['x/', 'y'] },
      { title: 'b', patterns: ['y', '# comment'] },
      { title: 'c', patterns: ['z'] },
    ]);
    expect(out).toBe('# header\n\n# a\nx/\ny\n\n# c\nz\n');
  });
});
