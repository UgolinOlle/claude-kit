import type { KitConfig } from '../core/config.ts';
import type { ProjectContext } from '../core/context.ts';
import type { Manifest } from '../core/manifest.ts';
import type { McpServerConfig } from '../core/mcpProbe.ts';
import type { MemoryFile } from '../core/memory.ts';
import type { Feature } from '../core/presets.ts';
import type { HookRuntime } from '../generators/hooks.ts';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Repo-relative path, when the finding is about a file. */
  file?: string;
  line?: number;
  /** What to do about it, when there's no autofix (or in addition to it). */
  hint?: string;
  /** Rough tokens per session this costs, used to rank findings. */
  tokens?: number;
  /** Set when `doctor --fix` can resolve it. */
  fixable?: boolean;
}

export interface Settings {
  permissions?: { deny?: string[]; allow?: string[] };
  hooks?: Record<string, { matcher?: string; hooks?: unknown[] }[]>;
  [key: string]: unknown;
}

export interface RuleContext {
  project: ProjectContext;
  manifest: Manifest;
  memory: MemoryFile[];
  claudeignore: string | null;
  /** Project settings (.claude/settings.json); null if missing. */
  settings: Settings | null;
  settingsError: string | null;
  /** Local settings (.claude/settings.local.json), they also count for enforcement. */
  localSettings: Settings | null;
  mcpServers: string[];
  /** Server configs from .mcp.json, by name. */
  mcpConfigs: Record<string, McpServerConfig>;
  /** `doctor --probe-mcp`: rules may start MCP servers to measure them. */
  probeMcp: boolean;
  hookRuntime: HookRuntime;
  config: KitConfig;
}

export interface Rule {
  id: string;
  description: string;
  check(ctx: RuleContext): Promise<Finding[]> | Finding[];
  /**
   * Features whose generators resolve this rule. `doctor --fix` re-runs the normal init
   * pipeline with these features enabled, never partial file plans: the writer treats every
   * plan as the whole file, so a fragment could wipe sibling content (e.g. hooks in settings.json).
   */
  fixWith?: Feature[];
}
