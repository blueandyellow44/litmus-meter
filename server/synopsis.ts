// End-of-listen synopsis. Two numbers, roles named:
//   - the VERDICT: the whole transcript scored the website's way (Max,
//     2026-10-07), dimensions from the model, number computed in
//     server/verdict.ts;
//   - the LINE AVERAGE: the plain average of the scored lines, shown second so
//     the listener can see both and judge ("we provide a tool -- we do not
//     manipulate them").
// The proving lines are picked by rule, hot AND calm. The Why must quote the
// transcript or it is not shown (the site's "retry, then none").

import { BANDS, VERDICT_PROMPT, VERDICT_TOOL } from "./rubric.ts";
import { SCORER_MODEL, type AnthropicResponse } from "./score.ts";

export const MIN_CLAIM_LINES = 3;
const HOT_LINES = 3;
const CALM_LINES = 2;
const WHY_QUOTE_WORDS = 3;

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
export function whyQuotesALine(why: string, texts: string[]): boolean {
  const w = ` ${normalize(why)} `;
  return texts.some((t) => {
    const words = normalize(t).split(" ");
    for (let i = 0; i + WHY_QUOTE_WORDS <= words.length; i++) {
      if (w.includes(` ${words.slice(i, i + WHY_QUOTE_WORDS).join(" ")} `)) return true;
    }
    return false;
  });
}

const MAX_TRANSCRIPT_CHARS = 60_000;

export function parseTranscript(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  let size = 0;
  for (const t of raw) {
    if (typeof t !== "string" || t.trim() === "") continue;
    const line = t.trim().slice(0, 1000);
    if (size + line.length > MAX_TRANSCRIPT_CHARS) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

export function buildVerdictRequest(transcript: string[], retryProblem: string | null) {
  const note = retryProblem
    ? `\n\nYour last answer was refused: ${retryProblem}. Answer again, following the binding rules and quoting the transcript exactly in why.`
    : "";
  return {
    model: SCORER_MODEL,
    // Dimensions, flags, a style name, a 3-5 sentence summary and the Why.
    // 400 cut the reply off before "why" on full debate answers (2026-10-07).
    max_tokens: 1200,
    temperature: 0,
    system: VERDICT_PROMPT,
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: VERDICT_TOOL.name },
    messages: [{ role: "user", content: `Transcript, one line per recognized sentence:\n${transcript.join("\n")}${note}` }],
  };
}

export function verdictInput(response: AnthropicResponse): unknown {
  return response.content?.find((c) => c.type === "tool_use" && c.name === VERDICT_TOOL.name)?.input ?? null;
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
