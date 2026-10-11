/**
 * Heuristic token estimate (~3.5 chars/token for mixed code + prose).
 * Good to roughly ±15%; `claude-kit context --exact` will use the API counter instead.
 */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

export function formatTokens(n: number): string {
  const short = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${short(n / 1_000_000)}M`;
  if (n >= 1_000) return `${short(n / 1_000)}K`;
  return String(n);
}
