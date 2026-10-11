import { join } from "node:path";
import { readJson } from "../utils/fsSafe.ts";

export const CONFIG_PATH = ".claude-kit/config.json";

export type RuleLevel = "error" | "warn" | "info" | "off";

/**
 * Hand-written project config (claude-kit never generates it).
 *   { "rules": { "cache/volatile-content": "off" }, "exclude": ["tests/fixtures/**"], "packs": ["claude-kit-pack-elixir"] }
 */
export interface KitConfig {
  /** Per-rule severity override, or "off". */
  rules: Record<string, RuleLevel>;
  /** Globs: findings about matching files are dropped. */
  exclude: string[];
  /** External stack packs: package names or ./relative module paths. */
  packs: string[];
}

const LEVELS = new Set<RuleLevel>(["error", "warn", "info", "off"]);

export async function loadConfig(root: string): Promise<KitConfig> {
  const raw = await readJson<Partial<KitConfig>>(join(root, CONFIG_PATH));
  const rules: Record<string, RuleLevel> = {};
  for (const [id, level] of Object.entries(raw?.rules ?? {})) {
    if (!LEVELS.has(level)) throw new Error(`${CONFIG_PATH}: rule "${id}" has invalid level "${level}" (use error, warn, info or off)`);
    rules[id] = level;
  }
  const exclude = Array.isArray(raw?.exclude) ? raw.exclude.filter((g): g is string => typeof g === "string") : [];
  const packs = Array.isArray(raw?.packs) ? raw.packs.filter((p): p is string => typeof p === "string") : [];
  return { rules, exclude, packs };
}
