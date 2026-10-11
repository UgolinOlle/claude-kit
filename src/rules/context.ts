import { join } from 'node:path';

import { loadConfig } from '../core/config.ts';
import { buildContext } from '../core/context.ts';
import { loadManifest } from '../core/manifest.ts';
import { discoverMemory, type DiscoverOptions } from '../core/memory.ts';
import type { HookRuntime } from '../generators/hooks.ts';
import { readText } from '../utils/fsSafe.ts';

import type { RuleContext, Settings } from './types.ts';

async function readSettings(
  path: string,
): Promise<{ value: Settings | null; error: string | null }> {
  const text = await readText(path);
  if (text === null) return { value: null, error: null };
  try {
    return { value: JSON.parse(text) as Settings, error: null };
  } catch (err) {
    return { value: null, error: (err as Error).message };
  }
}

export async function buildRuleContext(
  root: string,
  opts: { hookRuntime?: HookRuntime; memory?: DiscoverOptions } = {},
): Promise<RuleContext> {
  const project = await buildContext(root);
  const [manifest, memory, claudeignore, settings, local, mcp, config] = await Promise.all([
    loadManifest(project.root),
    discoverMemory(project.root, { ancestors: false, ...opts.memory }),
    readText(join(project.root, '.claudeignore')),
    readSettings(join(project.root, '.claude', 'settings.json')),
    readSettings(join(project.root, '.claude', 'settings.local.json')),
    readSettings(join(project.root, '.mcp.json')),
    loadConfig(project.root),
  ]);
  const servers = (mcp.value as { mcpServers?: Record<string, unknown> } | null)?.mcpServers;
  return {
    project,
    manifest,
    memory,
    claudeignore,
    settings: settings.value,
    settingsError: settings.error,
    localSettings: local.value,
    mcpServers: Object.keys(servers ?? {}),
    hookRuntime: opts.hookRuntime ?? (Bun.which('node') ? 'node' : 'bun'),
    config,
  };
}
