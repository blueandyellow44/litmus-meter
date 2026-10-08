// The whole-listen verdict, scored the way the LITMUS site scores an article
// (Max, 2026-10-07: "the goal is to have this mimic what the website does").
//
// SOURCE: ~/LITMUS2/litmus-server/src/scoring/composite.ts at c769c12
// (weightedBase, fallacyFloor, applyFloors, computeComposite), and the binding
// rules in calibration.ts. The model judges five dimensions and sets flags;
// the number is computed here, never by the model. Adapted for a speech, and
// only this:
//   headline        -> framing: how the speaker frames the subject overall
//                      (the site's HIGH-weight headline slot, weight 2)
//   loaded_headline -> loaded_framing (floors framing at 3.0)
//   emotional_lede  -> emotional_open: alarm or grievance before facts
//                      (floors structure at 3.0)
//   opinion_column  -> advocacy_speech: a rally, stump speech or other speech
//                      made to persuade (floors the composite at 2.5)
//   register        -> always "news": political speech gets no exemption.

import { bandOf } from "./synopsis.ts";

export interface VerdictDimensions {
  framing: number;
  language: number;
  sourcing: number;
  fallacies: number;
  structure: number;
}

export interface VerdictFlags {
  loadedFraming: boolean;
  emotionalOpen: boolean;
  fallacyCount: number;
  oneSidedSourcing: boolean;
  advocacySpeech: boolean;
}

export interface Verdict {
  score: number;
  band: string;
  base: number;
  raised: string[];
}

const LANGUAGE_WEIGHT = 2; // news register, as on the site
const FRAMING_WEIGHT = 2;
const PAIR_FLOOR = 3.5;
const EXTREME_PAIR = 4.5;
const ADVOCACY_FLOOR = 2.5;
const FLAG_FLOOR = 3.0;

export function fallacyFloor(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 2.5;
  if (count === 2) return 3.2;
  return 4.0;
}

export function computeVerdict(d: VerdictDimensions, f: VerdictFlags): Verdict {
  const dims = { ...d };
  const raised: string[] = [];
  const raise = (k: keyof VerdictDimensions, floor: number, why: string) => {
    if (dims[k] < floor) {
      dims[k] = floor;
      raised.push(why);
    }
  };
  if (f.loadedFraming) raise("framing", FLAG_FLOOR, "loaded framing");
  if (f.emotionalOpen) raise("structure", FLAG_FLOOR, "alarm before facts");
  const ff = fallacyFloor(f.fallacyCount);
  if (ff > 0) raise("fallacies", ff, `${f.fallacyCount} distinct logical fallac${f.fallacyCount === 1 ? "y" : "ies"}`);
  if (f.oneSidedSourcing) raise("sourcing", FLAG_FLOOR, "one-sided on a contested claim");

  const base =
    (FRAMING_WEIGHT * dims.framing + LANGUAGE_WEIGHT * dims.language + dims.sourcing + dims.fallacies + dims.structure) /
    (FRAMING_WEIGHT + LANGUAGE_WEIGHT + 3);
  let value = base;
  if (f.loadedFraming && f.emotionalOpen && value < PAIR_FLOOR) {
    value = PAIR_FLOOR;
    raised.push("loaded framing together with alarm before facts");
  }
  if (dims.framing >= EXTREME_PAIR && dims.language >= EXTREME_PAIR && value < EXTREME_PAIR) {
    value = EXTREME_PAIR;
    raised.push("alarm framing together with extreme language");
  }
  if (f.advocacySpeech && value < ADVOCACY_FLOOR) {
    value = ADVOCACY_FLOOR;
    raised.push("a speech made to persuade");
  }
  const score = Math.max(1, Math.min(5, Math.round(value * 10) / 10));
  return { score, band: bandOf(score), base: Math.round(base * 100) / 100, raised };
}

function dim(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 5 ? Math.round(v * 10) / 10 : null;
}

export interface ParsedVerdict {
  dims: VerdictDimensions;
  flags: VerdictFlags;
  why: string;
  summary: string | null;
  styleName: string | null;
}

const MAX_STYLE_WORDS = 6;

// Optional like the summary; over six words or empty and it is left out.
function cleanStyle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/[."]+$/g, "").replace(/\u2014/g, ", ");
  if (!t || t.split(/\s+/).length > MAX_STYLE_WORDS) return null;
  return t;
}

const MAX_SUMMARY_CHARS = 1200;

// The paragraph summary is optional: a missing one leaves the recap without
// it rather than refusing a sound verdict.
function cleanSummary(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  return v.trim().replace(/\s*\u2014\s*/g, ", ").slice(0, MAX_SUMMARY_CHARS);
}

// The site's binding rules: "no side suppressed" with sourcing above 2.0, or
// "no fallacy found" with fallacies above 2.0, contradicts itself. Such an
// answer is refused, not smoothed over; the caller retries once.
export function parseVerdict(input: unknown): { ok: true; value: ParsedVerdict } | { ok: false; problem: string } {
  if (!input || typeof input !== "object") return { ok: false, problem: "no tool input" };
  const i = input as Record<string, unknown>;
  const dims = {
    framing: dim(i.framing),
    language: dim(i.language),
    sourcing: dim(i.sourcing),
    fallacies: dim(i.fallacies),
    structure: dim(i.structure),
  };
  if (Object.values(dims).some((v) => v === null)) return { ok: false, problem: "a dimension is missing or out of range" };
  const fallacyCount = i.fallacy_count;
  if (typeof fallacyCount !== "number" || !Number.isInteger(fallacyCount) || fallacyCount < 0) return { ok: false, problem: "fallacy_count" };
  for (const k of ["loaded_framing", "emotional_open", "one_sided_sourcing", "advocacy_speech"]) {
    if (typeof i[k] !== "boolean") return { ok: false, problem: k };
  }
  if (typeof i.why !== "string" || i.why.trim() === "") return { ok: false, problem: "why" };
  if (i.one_sided_sourcing === false && dims.sourcing! > 2.0) return { ok: false, problem: "sourcing above 2.0 with one_sided_sourcing false" };
  if (fallacyCount === 0 && dims.fallacies! > 2.0) return { ok: false, problem: "fallacies above 2.0 with fallacy_count 0" };
  return {
    ok: true,
    value: {
      dims: dims as VerdictDimensions,
      flags: {
        loadedFraming: i.loaded_framing as boolean,
        emotionalOpen: i.emotional_open as boolean,
        fallacyCount,
        oneSidedSourcing: i.one_sided_sourcing as boolean,
        advocacySpeech: i.advocacy_speech as boolean,
      },
      why: i.why.trim().replace(/—/g, ", ").slice(0, 400),
      summary: cleanSummary(i.summary),
      styleName: cleanStyle(i.style_name),
    },
  };
}
