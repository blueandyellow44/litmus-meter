// One sentence in, one validated score out.

import { SCORE_TOOL, SYSTEM_PROMPT } from "./rubric.ts";
import type { AnthropicUsage } from "./prices.ts";

export const SCORER_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 200;
export const MAX_SENTENCE_CHARS = 1000;
const MAX_REASON_CHARS = 240;

export interface AnthropicResponse {
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  usage?: AnthropicUsage;
}

export type CallAnthropic = (body: unknown) => Promise<AnthropicResponse>;

export interface ValidScore {
  text: string;
  score: number;
  reason: string;
}

export function buildRequest(sentence: string) {
  return {
    model: SCORER_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: SCORE_TOOL.name },
    messages: [{ role: "user", content: sentence }],
  };
}

export function realAnthropic(apiKey: string): CallAnthropic {
  return async (body) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as AnthropicResponse;
  };
}

// Returns null for anything that is not exactly the shape we asked for. The
// caller drops that sentence; it never guesses a score.
export function validateToolOutput(response: AnthropicResponse): ValidScore | null {
  const block = response.content?.find((c) => c.type === "tool_use" && c.name === SCORE_TOOL.name);
  const input = block?.input;
  if (!input || typeof input !== "object") return null;
  const { text, score, reason } = input as Record<string, unknown>;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof reason !== "string" || reason.trim() === "") return null;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score < 1.0 || score > 5.0) return null;
  return {
    text: text.trim(),
    score: Math.round(score * 10) / 10,
    reason: reason.trim().slice(0, MAX_REASON_CHARS),
  };
}
