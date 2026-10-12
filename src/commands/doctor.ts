import type { GlobalOptions } from '../cli.ts';
import type { DiscoverOptions } from '../core/memory.ts';
import type { Feature } from '../core/presets.ts';
import { isFeature } from '../core/presets.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { buildRuleContext } from '../rules/context.ts';
import { type Finding, meetsThreshold, runRules, type Severity } from '../rules/index.ts';
import { c, log } from '../utils/logger.ts';

import { generateAndApply } from './apply.ts';
import { detectHookRuntime, isInteractive } from './init.ts';

export type DoctorFormat = 'text' | 'json' | 'github';

export interface DoctorOptions {
  /** Overrides for tests. */
  hookRuntime?: HookRuntime;
  memory?: DiscoverOptions;
  interactive?: boolean;
}

const ICON: Record<Severity, string> = {
  error: c.red('✖ error'),
  warn: c.yellow('⚠ warn '),
  info: c.blue('ℹ info '),
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const GH_LEVEL: Record<Severity, string> = {
  error: 'error',
  warn: 'warning',
  info: 'notice',
};

const ghData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghProp = (s: string) => ghData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function formatGithub(findings: Finding[]): string {
  return findings
    .map((f) => {
      const props = [
        f.file && `file=${ghProp(f.file)}`,
        f.line && `line=${f.line}`,
        `title=${ghProp(f.ruleId)}`,
      ].filter(Boolean);
      const body = f.hint ? `${f.message} ${f.hint}` : f.message;
      return `::${GH_LEVEL[f.severity]} ${props.join(',')}::${ghData(body)}`;
    })
    .join('\n');
}

function formatText(findings: Finding[], score: number): string {
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const scoreColor = score >= 80 ? c.green : score >= 50 ? c.yellow : c.red;
  const lines = [
    `${c.bold('Score')} ${scoreColor(`${score}/100`)}  ${c.dim(`${plural(count('error'), 'error')} · ${plural(count('warn'), 'warning')} · ${plural(count('info'), 'suggestion')}`)}`,
  ];
  if (findings.length === 0) lines.push(c.green('\nNo issues found.'));
  for (const f of findings) {
    lines.push(
      '',
      `${ICON[f.severity]}  ${c.bold(f.ruleId)}${f.fixable ? c.dim('  [fixable]') : ''}`,
      `  ${f.message}`,
    );
    if (f.hint) lines.push(c.dim(`  → ${f.hint}`));
  }
  return lines.join('\n');
}

export async function runDoctor(opts: GlobalOptions, d: DoctorOptions = {}): Promise<number> {
  const format: DoctorFormat = opts.json
    ? 'json'
    : ((opts.format as DoctorFormat | undefined) ?? 'text');
  if (!['text', 'json', 'github'].includes(format)) {
    log.error(`Unknown --format "${opts.format}". Use text, json or github.`);
    return 2;
  }
  const failOn = (opts.failOn ?? 'error') as Severity;
  if (!['error', 'warn', 'info'].includes(failOn)) {
    log.error(`Unknown --fail-on "${opts.failOn}". Use error, warn or info.`);
    return 2;
  }
  if (opts.fix && opts.check) {
    log.error("--fix and --check can't be combined: --check is read-only.");
    return 2;
  }

  const hookRuntime = d.hookRuntime ?? detectHookRuntime();
  const probeMcp = Boolean(opts.probeMcp);
  if (probeMcp && format === 'text')
    log.info(c.dim('--probe-mcp starts the stdio servers in .mcp.json to list their tools.\n'));
  const rctx = await buildRuleContext(opts.cwd, {
    hookRuntime,
    memory: d.memory,
    probeMcp,
  });
  let run = await runRules(rctx);

  if (opts.fix) {
    if (run.fixFeatures.length === 0) {
      log.info(formatText(run.findings, run.score));
      log.info(c.dim('\nNothing to fix automatically.'));
      return 0;
    }
    const features: Feature[] = [
      ...new Set([...(rctx.manifest.features ?? []).filter(isFeature), ...run.fixFeatures]),
    ];
    log.info(c.dim(`Fixing with: ${run.fixFeatures.join(', ')}`));
    const outcome = await generateAndApply({
      ctx: rctx.project,
      manifest: rctx.manifest,
      features,
      opts,
      interactive: d.interactive ?? isInteractive(opts),
      hookRuntime,
    });
    if (outcome.status === 'cancelled') return 1;
    if (outcome.status === 'dry-run') {
      log.info(c.dim('\nDry run: nothing written.'));
      return 0;
    }
    run = await runRules(
      await buildRuleContext(opts.cwd, {
        hookRuntime,
        memory: d.memory,
        probeMcp,
      }),
    );
    log.info('');
  }

  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          score: run.score,
          findings: run.findings,
          fixFeatures: run.fixFeatures,
        },
        null,
        2,
      ),
    );
  } else if (format === 'github') {
    const out = formatGithub(run.findings);
    if (out) console.log(out);
  } else {
    log.info(`${c.bold('claude-kit doctor')} ${c.dim(rctx.project.root)}\n`);
    log.info(formatText(run.findings, run.score));
    const fixable = run.findings.filter((f) => f.fixable).length;
    if (!opts.fix && fixable)
      log.info(
        `\n${fixable} fixable: run ${c.bold('claude-kit doctor --fix')} (or --fix --dry-run to preview).`,
      );
  }

  if (opts.check) {
    const failing = run.findings.filter((f) => meetsThreshold(f, failOn));
    if (failing.length && format === 'text')
      log.error(
        `${failing.length} finding${failing.length === 1 ? '' : 's'} at or above "${failOn}".`,
      );
    return failing.length ? 1 : 0;
  }
  return 0;
}
