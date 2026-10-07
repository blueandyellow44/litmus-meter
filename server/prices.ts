// Every rate the spend cap charges against. README.md carries the same numbers
// with their sources and the date they were checked; change both together.

// Deepgram Nova-3 English streaming, Pay As You Go, checked 2026-10-07 at
// https://deepgram.com/pricing. The page shows $0.0048/min as a "limited-time
// promotional" current price and $0.0077/min as the regular price, with no end
// date. The cap charges the REGULAR price so the meter can only over-count
// spend, never under-count it when the promotion ends.
export const DEEPGRAM_USD_PER_MIN = 0.0077;

// Claude Haiku 4.5 list price, checked 2026-10-07 at
// https://platform.claude.com/docs/en/about-claude/pricing.
export const HAIKU_USD_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite5m: 1.25,
  cacheRead: 0.1,
} as const;

export const SPEND_CAP_USD = 50.0;
export const SPEND_WARN_USD = 40.0;

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function tokens(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

export function anthropicCostUsd(usage: AnthropicUsage | undefined): number {
  if (!usage) return 0;
  const p = HAIKU_USD_PER_MTOK;
  return (
    (tokens(usage.input_tokens) * p.input +
      tokens(usage.output_tokens) * p.output +
      tokens(usage.cache_creation_input_tokens) * p.cacheWrite5m +
      tokens(usage.cache_read_input_tokens) * p.cacheRead) /
    1_000_000
  );
}

export function deepgramCostUsd(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 0;
  return (audioSeconds / 60) * DEEPGRAM_USD_PER_MIN;
}
