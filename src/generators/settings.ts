import { deepMergeJson, type Json } from '../core/merge.ts';
import type { FilePlan } from '../core/writer.ts';

export const SETTINGS_PATH = '.claude/settings.json';
const SCHEMA = 'https://json.schemastore.org/claude-code-settings.json';

/** A generator's contribution to .claude/settings.json; combined by `combineSettings`. */
export function settingsPlan(
  templateId: string,
  templateVersion: number,
  fragment: Record<string, Json>,
): FilePlan {
  return {
    path: SETTINGS_PATH,
    content: JSON.stringify(fragment, null, 2) + '\n',
    strategy: 'json',
    templateId,
    templateVersion,
  };
}

/** Several generators write settings.json; fold their fragments into one plan. */
export function combineSettings(plans: FilePlan[]): FilePlan[] {
  const fragments = plans.filter((p) => p.path === SETTINGS_PATH);
  if (fragments.length === 0) return plans;
  let merged: Json = { $schema: SCHEMA };
  for (const f of fragments) merged = deepMergeJson(merged, JSON.parse(f.content) as Json);
  const combined: FilePlan = {
    path: SETTINGS_PATH,
    content: JSON.stringify(merged, null, 2) + '\n',
    strategy: 'json',
    templateId: 'settings',
    templateVersion: Math.max(...fragments.map((f) => f.templateVersion)),
  };
  return [...plans.filter((p) => p.path !== SETTINGS_PATH), combined];
}
