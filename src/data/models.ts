/**
 * Model facts that rot as Claude Code evolves; `claude-kit upgrade` re-applies them.
 * Source: code.claude.com/docs/en/model-config (aliases).
 */
export const MODELS_VERSION = 1;

/** Opus while in Plan Mode, Sonnet for execution. */
export const DEFAULT_MODEL = "opusplan";

export const MODEL_CHEATSHEET = [
  "This project defaults to `opusplan` (.claude/settings.json): Opus in Plan Mode, Sonnet while executing.",
  "/model sonnet: everyday coding · /model opus: hard debugging and design · /model haiku: quick mechanical edits",
  "Personal override: /model <alias>, or set \"model\" in .claude/settings.local.json (not committed).",
];
