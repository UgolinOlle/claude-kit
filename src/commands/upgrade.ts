/**
 * `claude-kit upgrade`: re-apply this version's templates to a project set up earlier.
 * Templates ship inside the CLI (no runtime template downloads), so getting newer ones means
 * running a newer claude-kit: `npx @whoa-studio/claude-kit@latest upgrade`. The writer keeps user edits.
 */
import pkg from '../../package.json' with { type: 'json' };
import type { GlobalOptions } from '../cli.ts';
import { buildContext } from '../core/context.ts';
import { loadManifest } from '../core/manifest.ts';
import { isFeature } from '../core/presets.ts';
import { NPX, PACKAGE_NAME } from '../data/package.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { collectPlans } from '../generators/index.ts';
import { c, log } from '../utils/logger.ts';

import { generateAndApply } from './apply.ts';
import { detectHookRuntime, isInteractive } from './init.ts';

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME.replace('/', '%2f')}/latest`;

/** Numeric semver compare, ignoring pre-release tags. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export async function latestPublished(): Promise<string | null> {
  if (process.env.CLAUDE_KIT_NO_UPDATE_CHECK) return null;
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null; // offline is fine
  }
}

export interface UpgradeOptions {
  hookRuntime?: HookRuntime;
  interactive?: boolean;
  /** Injected in tests; defaults to the npm registry lookup. */
  latest?: () => Promise<string | null>;
}

export async function runUpgrade(opts: GlobalOptions, o: UpgradeOptions = {}): Promise<number> {
  const ctx = await buildContext(opts.cwd);
  const manifest = await loadManifest(ctx.root);
  const features = (manifest.features ?? []).filter(isFeature);
  if (features.length === 0) {
    log.error("This project wasn't set up with claude-kit yet. Run `claude-kit init` first.");
    return 1;
  }

  const latest = await (o.latest ?? latestPublished)();
  if (latest && compareVersions(latest, pkg.version) > 0) {
    log.warn(
      `claude-kit ${latest} is available (this is ${pkg.version}). For its templates run: ${NPX}@latest upgrade`,
    );
  }

  const hookRuntime = o.hookRuntime ?? detectHookRuntime();
  const plans = await collectPlans({ ctx, manifest, features, hookRuntime });
  const changed = plans
    .map((p) => ({
      path: p.path,
      from: manifest.files[p.path]?.templateVersion,
      to: p.templateVersion,
    }))
    .filter((r) => r.from === undefined || r.from < r.to);

  log.info(
    c.dim(`Project last set up by claude-kit ${manifest.cliVersion}; this is ${pkg.version}.`),
  );
  if (changed.length === 0) log.info('All templates are at their current version.');
  else {
    log.info('Template changes since then:');
    for (const r of changed)
      log.info(`  ${r.path}  ${c.dim(r.from === undefined ? 'new' : `v${r.from} → v${r.to}`)}`);
  }
  log.info('');

  const outcome = await generateAndApply({
    ctx,
    manifest,
    features,
    opts,
    interactive: o.interactive ?? isInteractive(opts),
    hookRuntime,
    plans,
  });
  if (opts.json) {
    console.log(
      JSON.stringify(
        { from: manifest.cliVersion, to: pkg.version, latest, changed, status: outcome.status },
        null,
        2,
      ),
    );
  }
  if (outcome.status === 'up-to-date') log.success('Everything is up to date.');
  return outcome.status === 'cancelled' ? 1 : 0;
}
