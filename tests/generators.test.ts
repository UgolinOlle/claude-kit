import { describe, expect, test } from 'bun:test';

import { buildContext } from '../src/core/context.ts';
import { emptyManifest } from '../src/core/manifest.ts';
import { collectPlans } from '../src/generators/index.ts';
import { render } from '../src/templates/render.ts';

import { tempProject } from './helpers.ts';

describe('generator snapshots', () => {
  test.each(['bun-app', 'python-app', 'pnpm-monorepo', 'polyglot'])('%s', async (fixture) => {
    const ctx = await buildContext(await tempProject(fixture));
    const plans = await collectPlans({
      ctx,
      manifest: emptyManifest(),
      features: ['claudeignore', 'claudemd', 'hooks'],
      hookRuntime: 'node',
    });
    for (const plan of plans.filter((p) => !p.path.endsWith('.cjs'))) {
      expect(plan.content).toMatchSnapshot(plan.path);
    }
  });
});

describe('render', () => {
  test('substitutes and rejects missing variables', () => {
    expect(render('a {{ x }} b', { x: '1' })).toBe('a 1 b');
    expect(() => render('{{missing}}', {})).toThrow('"missing"');
  });
});
