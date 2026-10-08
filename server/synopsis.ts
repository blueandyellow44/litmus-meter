// End-of-listen synopsis. Everything numeric is decided here, in code:
// the score is the plain average of the lines that make a claim (Max,
// 2026-10-07: "whatever is most honest ... we do not manipulate them"), the
// band comes from the rubric's table, and the proving lines are picked by
// rule, hot AND calm, so the listener sees the evidence on both sides. The
// model writes only the one-sentence Why, and that sentence must quote one of
// the proving lines or it is not shown (the site's "retry, then none").

import { BANDS, SYNOPSIS_PROMPT, WHY_TOOL } from "./rubric.ts";
import { SCORER_MODEL, type AnthropicResponse } from "./score.ts";

export const MIN_CLAIM_LINES = 3;
const HOT_LINES = 3;
const CALM_LINES = 2;
const WHY_QUOTE_WORDS = 3;
const MAX_WHY_CHARS = 400;

export interface ScoredLine {
  seq: number;
  text: string;
  score: number;
  reason: string;
}

export interface Summary {
  lines: number;
  score: number;
  band: string;
  counts: Record<string, number>;
  hottest: ScoredLine[];
  calmest: ScoredLine[];
}

export function bandOf(score: number): string {
  const s = Math.max(1, Math.min(5, score));
  return (BANDS.find((b) => s < b.below) ?? BANDS[BANDS.length - 1]!).label;
}

// Null when too little was said to judge; the screen says so instead of
// stretching three words into a verdict.
export function summarize(lines: ScoredLine[]): Summary | null {
  if (lines.length < MIN_CLAIM_LINES) return null;
  const mean = lines.reduce((s, l) => s + l.score, 0) / lines.length;
  const score = Math.round(mean * 10) / 10;
  const counts: Record<string, number> = Object.fromEntries(BANDS.map((b) => [b.label, 0]));
  for (const l of lines) counts[bandOf(l.score)]! += 1;
  // Ties go to the earlier line, so the pick never depends on arrival order.
  const byHeat = [...lines].sort((a, b) => b.score - a.score || a.seq - b.seq);
  const hottest = byHeat.slice(0, HOT_LINES);
  const calmest = [...lines]
    .sort((a, b) => a.score - b.score || a.seq - b.seq)
    .filter((l) => !hottest.includes(l))
    .slice(0, CALM_LINES);
  return { lines: lines.length, score, band: bandOf(score), counts, hottest, calmest };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// True when `why` contains WHY_QUOTE_WORDS consecutive words of some line.
export function whyQuotesALine(why: string, lines: ScoredLine[]): boolean {
  const w = ` ${normalize(why)} `;
  return lines.some((l) => {
    const words = normalize(l.text).split(" ");
    for (let i = 0; i + WHY_QUOTE_WORDS <= words.length; i++) {
      if (w.includes(` ${words.slice(i, i + WHY_QUOTE_WORDS).join(" ")} `)) return true;
    }
    return false;
  });
}

export function buildWhyRequest(summary: Summary, retry: boolean) {
  const proving = [...summary.hottest, ...summary.calmest];
  const payload = {
    band: summary.band,
    score: summary.score,
    lines_scored: summary.lines,
    lines_per_band: summary.counts,
    hottest_lines: summary.hottest.map((l) => ({ text: l.text, score: l.score })),
    calmest_lines: summary.calmest.map((l) => ({ text: l.text, score: l.score })),
  };
  const note = retry
    ? `\n\nYour last answer did not quote any line. Quote three or more consecutive words exactly from one of these lines: ${proving.map((l) => JSON.stringify(l.text)).join(", ")}`
    : "";
  return {
    model: SCORER_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: SYNOPSIS_PROMPT,
    tools: [WHY_TOOL],
    tool_choice: { type: "tool", name: WHY_TOOL.name },
    messages: [{ role: "user", content: JSON.stringify(payload) + note }],
  };
}

export function readWhy(response: AnthropicResponse): string | null {
  const input = response.content?.find((c) => c.type === "tool_use" && c.name === WHY_TOOL.name)?.input;
  const why = input && typeof input === "object" ? (input as Record<string, unknown>).why : null;
  if (typeof why !== "string" || why.trim() === "") return null;
  return why.trim().replace(/—/g, ", ").slice(0, MAX_WHY_CHARS);
}

// Accepts only well-formed lines from the client; anything else is dropped
// rather than trusted.
export function parseLines(raw: unknown): ScoredLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 2000)
    .filter(
      (l): l is ScoredLine =>
        !!l &&
        typeof l === "object" &&
        Number.isInteger((l as ScoredLine).seq) &&
        typeof (l as ScoredLine).text === "string" &&
        (l as ScoredLine).text.length > 0 &&
        (l as ScoredLine).text.length <= 1000 &&
        typeof (l as ScoredLine).score === "number" &&
        (l as ScoredLine).score >= 1 &&
        (l as ScoredLine).score <= 5 &&
        typeof (l as ScoredLine).reason === "string",
    )
    .map((l) => ({ seq: l.seq, text: l.text, score: l.score, reason: l.reason.slice(0, 240) }));
}
