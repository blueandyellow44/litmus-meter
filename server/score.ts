// One sentence in, one validated score out.

import { SCORE_TOOL, SYSTEM_PROMPT } from "./rubric.ts";
import type { AnthropicUsage } from "./prices.ts";
export { validateMarks } from "./marks.ts";

export const SCORER_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 200;
export const MAX_SENTENCE_CHARS = 1000;
const MAX_REASON_CHARS = 240;

export interface AnthropicResponse {
  stop_reason?: string;
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  usage?: AnthropicUsage;
}

export type CallAnthropic = (body: unknown) => Promise<AnthropicResponse>;

export interface ValidScore {
  text: string;
  claim: boolean;
  continues: boolean;
  marks: unknown;
  devices: unknown;
  appeal: unknown;
  score: number;
  reason: string;
}

// "No claim" is honoured only when the scorer also rates the line calm.
// History, both from Max's live tests on 2026-10-07:
//  - Unchecked, the flag hid heat: 168 of 276 rally lines marked no-claim,
//    many plain claims ("They hate America").
//  - A five-word cap that replaced it forced filler in instead: 18 of 37
//    counted lines had reasons like "asserts nothing", 17 scored 1.0, and the
//    listen averaged 2.0 Grounded where the real claims averaged 2.7.
// This gate cuts both ways: a hot line cannot hide behind the flag, and an
// aside cannot be counted as calm evidence.
export const NOCLAIM_MAX_SCORE = 1.4;

// At most this many words may differ between what was heard and what the
// model returns, and every word it adds must be capitalized (a proper noun).
const MAX_CORRECTED_WORDS = 3;

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function bare(w: string): string {
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

// Returns the model's version only when it differs from the heard sentence by
// a proper-noun swap; otherwise the heard sentence. A rewrite never reaches
// the screen as if the speaker had said it.
export function acceptCorrection(heard: string, proposed: string): string {
  if (proposed === heard) return heard;
  const a = words(heard);
  const b = words(proposed);
  // Longest common subsequence on bare words gives the unchanged backbone.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = bare(a[i]!) === bare(b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const kept = dp[0]![0]!;
  const removed = a.length - kept;
  const added: string[] = [];
  for (let i = 0, j = 0; j < b.length; ) {
    if (i < a.length && bare(a[i]!) === bare(b[j]!)) { i++; j++; }
    else if (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else { added.push(b[j]!); j++; }
  }
  if (added.length === 0 && removed === 0) return heard; // punctuation or case only
  if (removed > MAX_CORRECTED_WORDS || added.length > MAX_CORRECTED_WORDS) return heard;
  if (!added.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w))) return heard;
  return proposed.trim();
}

export const MAX_CONTEXT_LINES = 2;
const MAX_CONTEXT_CHARS = 500;

// The previous lines ride along as context only (Max, 2026-10-07, reversing
// the v1 "one sentence only" rule); the line to score is always last and
// labelled, so the model cannot mistake which words it is judging.
export function buildRequest(sentence: string, context: string[] = []) {
  const ctx = context.slice(-MAX_CONTEXT_LINES).map((c) => c.slice(0, MAX_CONTEXT_CHARS));
  const content = ctx.length
    ? `Context, the speaker's previous lines (do not score):\n${ctx.map((c) => `- ${c}`).join("\n")}\n\nScore this line:\n${sentence}`
    : sentence;
  return {
    model: SCORER_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [SCORE_TOOL],
    tool_choice: { type: "tool", name: SCORE_TOOL.name },
    messages: [{ role: "user", content }],
  };
}

export function parseContext(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string" && c.trim() !== "").slice(-MAX_CONTEXT_LINES);
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
  const { text, claim, score, reason, continues, marks, devices, appeal } = input as Record<string, unknown>;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof claim !== "boolean") return null;
  if (typeof reason !== "string" || reason.trim() === "") return null;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score < 1.0 || score > 5.0) return null;
  return {
    text: text.trim(),
    claim: claim || score > NOCLAIM_MAX_SCORE,
    // Optional so an answer without it is still usable: it just does not merge.
    continues: continues === true,
    // Validated against the shown line by the caller (validateMarks,
    // validateDevices, parseAppeal).
    marks,
    devices,
    appeal,
    score: Math.round(score * 10) / 10,
    reason: reason.trim().slice(0, MAX_REASON_CHARS),
  };
}
