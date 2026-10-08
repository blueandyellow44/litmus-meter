import { validateMarks } from "./marks.ts";

// The fixed lists the scorer labels lines from (Max, 2026-10-07: "do it", on
// the proposed list). A fixed list keeps the counts honest: "fear appeal" and
// "appeal to fear" never split one tally in two.

export const FALLACIES = [
  "Ad hominem",
  "Appeal to fear",
  "Straw man",
  "False dilemma",
  "Slippery slope",
  "Whataboutism",
  "Bandwagon",
  "Unsupported superlative",
  "Poisoning the well",
] as const;

export const MOVES = [
  "Us vs. them",
  "Threat to the listener",
  "Victory framing",
  "Self-praise",
  "Strength display",
  "Name-calling",
  "Raising the stakes",
  "Repetition",
  "Citing the record",
  "Direct ask",
] as const;

export const APPEALS = ["ethos", "pathos", "logos"] as const;
export type Appeal = (typeof APPEALS)[number];

export const FALLACY_DEF: Record<string, string> = {
  "Ad hominem": "Attacks the person, not the argument.",
  "Appeal to fear": "Moves you with a threat instead of evidence.",
  "Straw man": "Answers a weaker version of the other side.",
  "False dilemma": "Only two choices, when there are more.",
  "Slippery slope": "One step leads straight to catastrophe.",
  "Whataboutism": "Answers a charge by pointing at someone else.",
  "Bandwagon": "True because everyone believes it.",
  "Unsupported superlative": "A 'most ever' with nothing to check it against.",
  "Poisoning the well": "Discredits a source before you hear it.",
};

export const MOVE_DEF: Record<string, string> = {
  "Us vs. them": "Splits the world into his side and an enemy.",
  "Threat to the listener": "Tells you what you will lose.",
  "Victory framing": "The outcome told as a rout.",
  "Self-praise": "His own record stated as superlative fact.",
  "Strength display": "Force or toughness offered as proof.",
  "Name-calling": "Labels in place of argument.",
  "Raising the stakes": "This moment is the biggest ever.",
  "Repetition": "The same point hammered again.",
  "Citing the record": "A checkable figure or fact.",
  "Direct ask": "A plain request to act.",
};

export const MAX_DEVICES = 2;

export interface Device {
  label: string;
  kind: "fallacy" | "move";
  words: string;
}


const FALLACY_SET = new Set<string>(FALLACIES);
const MOVE_SET = new Set<string>(MOVES);

// Keeps a label only when it is on the fixed list and its words are verbatim,
// unquoted text of the line (the same check as the underlines). One label
// appears once per line.
export function validateDevices(line: string, raw: unknown): Device[] {
  if (!Array.isArray(raw)) return [];
  const out: Device[] = [];
  for (const d of raw) {
    if (out.length >= MAX_DEVICES) break;
    if (!d || typeof d !== "object") continue;
    const { label, words } = d as Record<string, unknown>;
    if (typeof label !== "string" || typeof words !== "string") continue;
    const kind = FALLACY_SET.has(label) ? "fallacy" : MOVE_SET.has(label) ? "move" : null;
    if (!kind || out.some((o) => o.label === label)) continue;
    const [verbatim] = validateMarks(line, [words]);
    if (!verbatim) continue;
    out.push({ label, kind, words: verbatim });
  }
  return out;
}

export function parseAppeal(raw: unknown): Appeal | null {
  return typeof raw === "string" && (APPEALS as readonly string[]).includes(raw) ? (raw as Appeal) : null;
}
