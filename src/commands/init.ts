import * as p from "@clack/prompts";

import type { GlobalOptions } from "../cli.ts";
import { buildContext } from "../core/context.ts";
import { loadManifest } from "../core/manifest.ts";
import {
  type Feature,
  isFeature,
  isPreset,
  type Preset,
  resolveFeatures,
} from "../core/presets.ts";
import type { HookRuntime } from "../generators/hooks.ts";
import { askPreset } from "../prompts/questionnaire.ts";
import { c, log } from "../utils/logger.ts";
import { which } from "../utils/runtime.ts";

import { generateAndApply, summarize } from "./apply.ts";

export interface InitOptions {
  /** `sync`: reuse the features recorded in the manifest, never prompt for them. */
  sync?: boolean;
  /** Override hook runtime detection (tests). */
  hookRuntime?: HookRuntime;
  /** Override TTY detection (tests). */
  interactive?: boolean;
}

export const detectHookRuntime = (): HookRuntime =>
  which("node") ? "node" : "bun";

export const isInteractive = (opts: GlobalOptions) =>
  Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
  !opts.yes &&
  !opts.force &&
  !opts.json;

export async function runInit(
  opts: GlobalOptions,
  init: InitOptions = {},
): Promise<number> {
  const ctx = await buildContext(opts.cwd);
  const manifest = await loadManifest(ctx.root);
  const interactive = init.interactive ?? isInteractive(opts);

  let preset: Preset | undefined;
  let features: Feature[];
  if (init.sync) {
    if (!manifest.features?.length) {
      log.error("Nothing to sync yet. Run `claude-kit init` first.");
      return 1;
    }
    features = manifest.features.filter(isFeature);
  } else {
    if (opts.preset && !isPreset(opts.preset)) {
      log.error(
        `Unknown preset "${opts.preset}". Use minimal, standard or full.`,
      );
      return 2;
    }
    if (interactive) p.intro(c.bold("claude-kit init"));
    const recorded =
      manifest.preset && isPreset(manifest.preset)
        ? manifest.preset
        : undefined;
    const chosen =
      (opts.preset as Preset | undefined) ??
      recorded ??
      (interactive ? await askPreset() : "minimal");
    if (chosen === null) {
      p.cancel("Cancelled.");
      return 1;
    }
    preset = chosen;
    features = resolveFeatures(preset, opts.with, opts.without);
  }

  log.info(
    c.dim(
      `${ctx.root} · ${ctx.stacks.map((s) => s.id).join(", ") || "no stack detected"} · ${preset ? `preset ${preset}` : "sync"}`,
    ),
  );
  const outcome = await generateAndApply({
    ctx,
    manifest,
    features,
    preset,
    opts,
    interactive,
    hookRuntime: init.hookRuntime ?? detectHookRuntime(),
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          preset,
          features: outcome.active,
          status: outcome.status,
          changes: summarize(outcome.changes),
          result: outcome.result,
        },
        null,
        2,
      ),
    );
  }
  switch (outcome.status) {
    case "cancelled":
      return 1;
    case "dry-run":
      log.info(c.dim("\nDry run: nothing written."));
      return 0;
    case "up-to-date":
      log.success("Everything is up to date.");
      return 0;
    case "applied": {
      if (init.sync) return 0;
      const next = [
        "Fill in the Conventions and Gotchas sections of CLAUDE.md (keep it short).",
        "Commit CLAUDE.md, .claudeignore, .claude/ and .claude-kit/ so your team shares the setup.",
        "After editing .claudeignore, run `claude-kit sync` to update the deny rules.",
        "Run `claude-kit doctor` any time to check the setup.",
      ];
      if (interactive) p.outro(next.map((n) => `• ${n}`).join("\n"));
      else log.info(`\nNext:\n${next.map((n) => `  • ${n}`).join("\n")}`);
      return 0;
    }
  }
}
