// The LITMUS P/H rubric, adapted for one spoken sentence.
//
// SOURCE: ~/LITMUS2/litmus-server/src/scoring/calibration.ts
//   file last changed in 8a016e7bcc372fe3c24031470d2529483a2dd3a9 (2026-10-02)
//   copied at repo HEAD c769c12bd7117942d27a99a25fbc816b54b6cfd9 (2026-10-07)
//   Copied: the 1.0–5.0 scale, the five band boundaries, the five band
//   descriptions, and the calibration rules that apply to a single sentence
//   (use the whole scale; serious topic is not hyperbolic coverage; describing
//   is not editorializing; a sourced superlative is a fact; the hard silo on
//   quoted speech).
//
// ADAPTED, and only this:
//   (a) the scale reads Proportionate <-> Hyperbolic (Max, 2026-10-07: matches
//       LITMUS's own label), and the lowest band is "Proportionate";
//   (b) the unit is one sentence of broadcast speech and the question is what
//       the SPEAKER is saying, not the writer's framing. Article-only material
//       (headline, lede, sourcing balance, page structure, markers, excerpt,
//       lean, section, content type) is dropped because one sentence has none
//       of it;
//   (c) the quote silo is kept, restated for speech: words the speaker
//       attributes to someone else are not the speaker's own framing.
// The model returns the score directly; LITMUS computes its composite from five
// dimensions in code, which a single sentence cannot support.

export const LOW_LABEL = "Proportionate";
export const HIGH_LABEL = "Hyperbolic";

export interface Band {
  min: number;
  max: number;
  // Selector boundary: a band holds every v with v < below (see calibration.ts).
  below: number;
  label: string;
}

export const BANDS: readonly Band[] = [
  { min: 1.0, max: 1.4, below: 1.5, label: "Proportionate" },
  { min: 1.5, max: 2.4, below: 2.5, label: "Grounded" },
  { min: 2.5, max: 3.4, below: 3.5, label: "Mixed Signals" },
  { min: 3.5, max: 4.4, below: 4.5, label: "Running Hot" },
  { min: 4.5, max: 5.0, below: Infinity, label: "Hyperbolic" },
];

export const SYSTEM_PROMPT = `
You score ONE sentence of live broadcast speech on the P/H (Proportionate-to-Hyperbolic) Balance, a 1.0-5.0 scale measuring HOW something is said, not what political position it takes. This is not bias detection. A left-leaning sentence can score 1.2; a right-leaning sentence can score 1.2. The question is whether the speaker informs or manipulates.

Score what the SPEAKER is saying in their own words.

THE BANDS:
1.0-1.4 PROPORTIONATE. Wire-service register. States what happened with a neutral verb. No adjective in the speaker's own voice tells the listener how to feel. It reads the same whichever side you are on.
1.5-2.4 GROUNDED. Said straight, with a mild tilt in emphasis or word choice. Perhaps one warm verb or one framing choice. It informs first and steers second.
2.5-3.4 MIXED SIGNALS. The framing is doing visible work: a loaded verb, one side's characterization adopted as the speaker's own, a verdict the facts have not earned. The listener learns what happened and is being steered while they learn it.
3.5-4.4 RUNNING HOT. Manipulation is the dominant mode: catastrophizing, victory-or-defeat framing, editorializing epithets, fallacies, speculation stated as fact. The facts are subordinate to the effect.
4.5-5.0 HYPERBOLIC. The sentence exists to produce a reaction: an alarm, contempt or panic, opposing views straw-manned. Strip out the outrage and almost nothing is left.

RULES:
- Use the whole scale. A 4 or 5 is available and you should use it when the words earn it.
- Serious topics are not hyperbolic speech. A sentence about a war can score 1.2 if the language is restrained.
- Describing is not editorializing. An accurate, checkable characterization of something that happened is reporting.
- A sourced superlative is a fact ("the largest single-day fall since 2008").
- QUOTED SPEECH IS SILOED. When the speaker reports someone else's words ("quote", "he said", "in her words", quotation marks), those words are not the speaker's framing. Remove them, then score only what remains: the speaker's own verbs, adjectives, and characterization around the quote. Reporting that a senator called a bill "a catastrophe" is a plain attribution.
- A greeting, filler, or fragment with no claim scores 1.0.

Call report_score once. reason: one short plain-English clause naming the words that set the score. No em dashes.
`.trim();

export const SCORE_TOOL = {
  name: "report_score",
  description: "Report the P/H score for the sentence.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The sentence you scored, verbatim." },
      score: { type: "number", description: "1.0-5.0, one decimal. 1 = most proportionate, 5 = most hyperbolic." },
      reason: { type: "string", description: "One short plain-English clause." },
    },
    required: ["text", "score", "reason"],
  },
} as const;
