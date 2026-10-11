/** Each preset includes the one before it — mirrors the article's week 1 / 2 / 3 rollout. */

export const FEATURES = [
  // minimal — the quick wins
  "claudeignore", // #1 (+ permissions.deny), extra #4
  "claudemd", //     #2, #3, #8
  "hooks", //        #9
  // standard
  "snapshots", //    #6
  "memory", //       #16
  "docs", //         #13
  "models", //       #10
  // full
  "agents", //       #11
  "budget", //       #12
  "compress", //     #14
  "rag", //          #7 (still only if the repo is large enough)
] as const;

export type Feature = (typeof FEATURES)[number];

export const PRESETS = {
  minimal: ["claudeignore", "claudemd", "hooks"],
  standard: ["claudeignore", "claudemd", "hooks", "snapshots", "memory", "docs", "models"],
  full: [...FEATURES],
} as const satisfies Record<string, readonly Feature[]>;

export type Preset = keyof typeof PRESETS;

export const isPreset = (v: string): v is Preset => v in PRESETS;
export const isFeature = (v: string): v is Feature => (FEATURES as readonly string[]).includes(v);

export function resolveFeatures(preset: Preset, add: readonly string[] = [], remove: readonly string[] = []): Feature[] {
  for (const f of [...add, ...remove]) {
    if (!isFeature(f)) throw new Error(`Unknown feature "${f}". Available: ${FEATURES.join(", ")}`);
  }
  const set = new Set<Feature>([...PRESETS[preset], ...(add as Feature[])]);
  for (const f of remove) set.delete(f as Feature);
  return FEATURES.filter((f) => set.has(f)); // canonical order
}
