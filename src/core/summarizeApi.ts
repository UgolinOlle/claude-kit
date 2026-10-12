/**
 * The Claude API side of `compress --summarize`. Credentials resolve the SDK's usual way
 * (ANTHROPIC_API_KEY, or an `ant auth login` profile).
 */
import Anthropic from '@anthropic-ai/sdk';

import { parseSummaries, SUMMARY_SYSTEM, summaryPrompt, type Summarizer } from './summarize.ts';

export const DEFAULT_SUMMARY_MODEL = 'claude-opus-5-5';

/** Models that accept the server-side `fallbacks: "default"` form. */
const DEFAULT_FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

export function apiSummarizer(model = DEFAULT_SUMMARY_MODEL, client = new Anthropic()): Summarizer {
  return async (req) => {
    const targets = req.sections.reduce((n, s) => n + s.target, 0);
    // Streaming, so a long document can't hit the SDK's non-streaming timeout.
    const fallback = DEFAULT_FALLBACK_MODELS.has(model);
    const stream = client.beta.messages.stream({
      model,
      max_tokens: Math.min(64_000, Math.max(4_000, targets * 3 + 2_000)),
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: summaryPrompt(req) }],
      // On a safety decline, the API re-runs the request on a fallback model instead of failing.
      ...(fallback
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal')
      throw new Error(`The model declined to summarise ${req.source}.`);
    const text = message.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseSummaries(text);
  };
}
