/**
 * Exact token counts via the Messages API's count_tokens endpoint (`context --exact`).
 * Counts are model-specific; a lone user message also carries some framing, which we
 * measure once and subtract so each item reports only its own tokens.
 */
import Anthropic, {
  APIError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
} from "@anthropic-ai/sdk";

export const DEFAULT_COUNT_MODEL = "claude-opus-5-5";
const CONCURRENCY = 4;

export type Counter = (text: string) => Promise<number>;

/** Raw counter backed by the SDK. Credentials resolve the SDK's usual way (env, `ant auth login` profile). */
export function apiCounter(
  model = DEFAULT_COUNT_MODEL,
  client = new Anthropic(),
): Counter {
  return async (text) => {
    const res = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    return res.input_tokens;
  };
}

/** Wraps a raw counter: subtracts per-message framing and limits concurrency. */
export async function framedCounter(raw: Counter): Promise<Counter> {
  // "x" is one token; whatever else it costs is framing every item pays.
  const overhead = Math.max(0, (await raw("x")) - 1);
  return async (text) =>
    text.trim() ? Math.max(0, (await raw(text)) - overhead) : 0;
}

export async function countAll(
  texts: string[],
  counter: Counter,
): Promise<number[]> {
  const out: number[] = Array.from({ length: texts.length }, () => 0);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const i = next++;
      out[i] = await counter(texts[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker),
  );
  return out;
}

/** Human-readable reason for an API failure, using the SDK's typed errors. */
export function describeCountError(err: unknown): string {
  if (err instanceof AuthenticationError) {
    return "Anthropic API rejected the credentials. Run `ant auth login` or set ANTHROPIC_API_KEY.";
  }
  if (err instanceof NotFoundError)
    return "Unknown model; pass a valid --model.";
  if (err instanceof RateLimitError)
    return "Rate limited by the Anthropic API; retry in a moment.";
  if (err instanceof APIError)
    return `Anthropic API error ${err.status}: ${err.message}`;
  if (
    err instanceof Error &&
    /credentials|api key|apiKey|authToken/i.test(err.message)
  ) {
    return "No Anthropic credentials found. Run `ant auth login` or set ANTHROPIC_API_KEY.";
  }
  return err instanceof Error ? err.message : String(err);
}
