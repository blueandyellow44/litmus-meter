// The LITMUS P/H rubric, adapted for one spoken sentence.
//
// SOURCE: litmus-server/src/scoring/calibration.ts in the LITMUS repo
//   (github.com/blueandyellow44/litmus), as it stood on 2026-10-07.
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
//       attributes to someone else are not the speaker's own framing;
//   (d) after Max's first live test (2026-10-07): a claim flag, so greetings
//       and broken fragments are not scored as 1.0 and do not drag the needle,
//       and permission to fix a misheard proper noun ("Strait of Hormones"),
//       which server/score.ts accepts only within a narrow guard;
//   (e) 2026-10-07, from the debate scores Max approved: the model never
//       rules on truth ("a false quote" appeared in a Why), and relayed
//       speech is siloed even without quotation marks.
// The model returns the score directly; LITMUS computes its composite from five
// dimensions in code, which a single sentence cannot support.

import { FALLACIES, MOVES } from "./labels.ts";

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
- QUOTED SPEECH IS SILOED. When the speaker reports someone else's words ("quote", "he said", "in her words", quotation marks), those words are not the speaker's framing. Remove them, then score only what remains: the speaker's own verbs, adjectives, and characterization around the quote. Reporting that a senator called a bill "a catastrophe" is a plain attribution. A spoken transcript has no quotation marks: when the speaker relays what someone else said ("All he said was it's not that serious, just inject a little bleach in your arm", "he told us..."), the relayed words are siloed all the same, and only the speaker's own framing around them counts ("All he said was" is mild framing). Do not mark the relayed words, and do not tag them as the speaker's own device.
- NEVER RULE ON TRUTH. You judge how something is said, never whether it is true. In reason, never call a claim true, false, a lie, misleading, or a false quote; describe the words, not their accuracy.
- UNFINISHED LINES. Speech is messy; a line can trail off or restart mid-sentence. Score the words that are there for how they are said. Never score a line low only because it is unfinished.
- CLAIM. Always give the score the words earn, whatever you set here. Set claim false for a greeting, filler, an aside, a sign-off, a compliment to someone in the room, or a broken piece that asserts nothing ("That was the end of that.", "I love that goat.", "It's already... And again, remember this."). A claim-false line is listed as not scored and does not count toward the needle or the verdict. Anything that says something about people, events, policy, threats, opponents or the country is a claim, even when it is unfinished or rambling ("They hate America", "Let them take out Los Angeles").
- TRANSCRIPT ERRORS. The sentence comes from live speech recognition. In "text", return the sentence verbatim, except fix an obvious mishearing of a proper noun (a place, person, group, or law), such as "Strait of Hormones" for "Strait of Hormuz". Change nothing else: no grammar, no other words, no punctuation. Score the corrected sentence.

- CONTEXT. You may be given the speaker's previous one or two lines, marked as context. Use them only to understand what this line refers to ("that", "them", "it"). Do not score the context lines, and do not let their heat carry into this line: score this line's own words.
- CONTINUES. Set continues true when this line finishes a thought the previous line began (the previous line broke off, or this line is its payoff: "I stopped them from ever having" then "a nuclear weapon, and that was the end of that"). Then score the whole thought, the previous line and this one together, and write the reason for the whole thought. Otherwise continues is false.

- MARKS. In "marks", copy the speaker's own loaded words exactly as they appear in the line: the words a listener would underline as hyperbolic (adapted from the LITMUS site's highlight rules). A single charged word counts ("disaster", "deranged", "the worst ever"). Never mark words he attributes to someone else. Never mark an accurate, checkable description, or a superlative anchored to a record ("the largest since 2008"). Mark only what, lifted out on its own, would steer a listener; a calm line has no marks, and that is the right answer. At most three, each a few words.

- DEVICES. In "devices", name up to two rhetorical moves or fallacies the speaker uses in this line, each with the exact words that show it ("words", copied from the line). Use only these labels. Fallacies: ${FALLACIES.join(", ")}. Moves: ${MOVES.join(", ")}. Only the speaker's own words count, never words he attributes to someone else. A plain line has no devices, or only Citing the record or Direct ask, and that is the right answer.
- APPEAL. In "appeal", say which appeal the line leans on most: "pathos" (emotion), "ethos" (trust in the speaker or his record), "logos" (facts and reasoning). Use "none" for a line that makes no claim.

Call report_score once. reason: one short plain-English clause naming the words that set the score. No em dashes.
`.trim();

export const SCORE_TOOL = {
  name: "report_score",
  description: "Report the P/H score for the sentence.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The sentence verbatim, with only a misheard proper noun corrected." },
      claim: { type: "boolean", description: "False only for greetings, filler, sign-offs and few-word pieces that assert nothing. When in doubt, true." },
      score: { type: "number", description: "1.0-5.0, one decimal. 1 = most proportionate, 5 = most hyperbolic." },
      reason: { type: "string", description: "One short plain-English clause." },
      continues: { type: "boolean", description: "True when this line finishes the thought the previous line began; then score the whole thought." },
      marks: { type: "array", items: { type: "string" }, description: "The speaker's own loaded words, copied exactly from the line. Empty for a calm line. At most three." },
      devices: {
        type: "array",
        description: "Up to two moves or fallacies, each with the exact words that show it.",
        items: {
          type: "object",
          properties: { label: { type: "string", enum: [...FALLACIES, ...MOVES] }, words: { type: "string" } },
          required: ["label", "words"],
        },
      },
      appeal: { type: "string", enum: ["pathos", "ethos", "logos", "none"] },
    },
    // Every field required: Haiku skips optional ones. With devices and appeal
    // optional, Max's live test (2026-10-07) got an appeal on almost no lines
    // ("Ethos 100%") and moves on 2 of 11.
    required: ["text", "claim", "score", "reason", "continues", "marks", "devices", "appeal"],
  },
} as const;

// The end-of-listen verdict, scored the way the LITMUS site scores an article
// (Max, 2026-10-07). The model reads the whole transcript and judges five
// dimensions and the flags; server/verdict.ts computes the number. Anchors and
// rules adapted from calibration.ts: headline becomes framing, the writer
// becomes the speaker, quoted words stay siloed, the binding rules stand.
export const VERDICT_PROMPT = `
You judge a whole speech, from its transcript, on the P/H (Proportionate-to-Hyperbolic) Balance: HOW it is said, not what political position it takes. This is not bias detection. The listener decides for themselves; you report what the words did.

YOU DO NOT REPORT A SCORE. The number is computed from the five dimensions and the flags you return. Score each dimension honestly on its own; do not aim at a total.

The transcript comes from live speech recognition: lines can be broken, run together or misheard. Judge the speech as a whole, as a listener would hear it. A thought split across lines is one thought.

QUOTED SPEECH IS SILOED. Words the speaker attributes to someone else ("quote", "he said", "they say") are not the speaker's framing, with or without quotation marks; a spoken transcript has none. Only the speaker's own words move the dimensions.

NEVER RULE ON TRUTH. You judge how the speech is said, never whether its claims are true. In why and summary, never call a claim true, false, a lie, misleading, or a false quote; attribute claims to the speaker and describe the words.

THE FIVE DIMENSIONS (each 1.0-5.0, one decimal). Use the anchors; a 4 is a normal score for speech that earns it.

1. framing (HIGH WEIGHT): how the speaker frames the subject overall.
   1 = states what is happening in neutral terms. 2 = a mild angle. 3 = verdict nouns, judging adjectives, catastrophizing or win-lose framing. 4 = tells the audience how to feel about the subject before giving them anything to judge. 5 = the framing is the argument; an alarm.
2. language (HIGH WEIGHT): intensity of the speaker's own words throughout.
   1 = plain verbs, no modifier doing emotional work. 2 = an occasional warm word. 3 = recurring loaded modifiers, violence or war metaphor applied to politics. 4 = contempt or alarm carried throughout, epithets for one side, absolutes ("never", "always", "the worst ever"). 5 = almost every line carries a charge.
3. sourcing (MEDIUM): balance on CONTESTED claims. First ask whether the speech advances a contested claim at all. If not, 1 or 2. If it does: 1 = the other side is fairly represented, 3 = the other side is a caricature or an aside, 4 = the other side is absent or only mocked, 5 = one side plus unsupported inflammatory claims.
   BINDING: if one_sided_sourcing is false, sourcing must be 1.0-2.0.
4. fallacies (MEDIUM): how much the reasoning depends on appeal to fear, ad hominem, false dilemma, slippery slope, straw man, whataboutism, cherry-picking, anecdote as evidence, bandwagon. Count distinct ones in fallacy_count.
   BINDING: if fallacy_count is 0, fallacies must be 1.0-2.0.
5. structure (MEDIUM): repetition of alarming points, escalation, grievance before facts, us-versus-them arranged for effect.

THE FLAGS:
- loaded_framing: true if the speaker's framing does work beyond stating what is happening (verdicts, catastrophizing, win-lose).
- emotional_open: true if the speech puts alarm, grievance or an enemy before any fact.
- fallacy_count: distinct fallacies in the speaker's own reasoning.
- one_sided_sourcing: true only if a contested claim is advanced with the other side absent or only mocked.
- advocacy_speech: true for a rally, stump speech, campaign or advocacy speech, made to persuade (the site's opinion-column floor).

USE THE WHOLE SCALE. A campaign rally that attacks opponents with epithets is routinely 3.5-4.5. A calm briefing is 1.0-2.0. Do not average toward the middle.

style_name: two to eight words naming the speech's persuasive style by its method, for example "Grievance and victory" or "Briefing by the numbers". Describe what the speech does, never what the speaker is.

summary: a paragraph of three to five sentences saying, strictly neutrally, what the speaker said: the subjects, the claims made, the promises and the requests, each attributed to the speaker ("The speaker said...", "The speaker claimed..."). This is the facts panel, read before any verdict, as on the LITMUS site. No adjectives doing emotional work, no judgement, no verdict, no mention of the score. Do not repeat the speaker's loaded words as fact. Plain words, short sentences, no em dashes, no contractions.

why: one sentence, under 35 words, saying what set the score, quoting at least one phrase of three or more words exactly as it appears in the transcript. Plain words. No em dashes. No contractions. Never tell the listener what to think of the speaker.

Call report_verdict once.
`.trim();

export const VERDICT_TOOL = {
  name: "report_verdict",
  description: "Report the dimensions, flags and Why for the whole speech.",
  input_schema: {
    type: "object",
    properties: {
      framing: { type: "number", description: "1.0-5.0" },
      language: { type: "number", description: "1.0-5.0" },
      sourcing: { type: "number", description: "1.0-5.0" },
      fallacies: { type: "number", description: "1.0-5.0" },
      structure: { type: "number", description: "1.0-5.0" },
      loaded_framing: { type: "boolean" },
      emotional_open: { type: "boolean" },
      fallacy_count: { type: "integer" },
      one_sided_sourcing: { type: "boolean" },
      advocacy_speech: { type: "boolean" },
      summary: { type: "string", description: "Three to five neutral sentences on what the speaker said, each claim attributed to the speaker." },
      style_name: { type: "string", description: "Two to eight words naming the persuasive style, describing the method, never the person." },
      why: { type: "string", description: "One sentence quoting at least three consecutive words from the transcript." },
    },
    required: ["framing", "language", "sourcing", "fallacies", "structure", "loaded_framing", "emotional_open", "fallacy_count", "one_sided_sourcing", "advocacy_speech", "style_name", "summary", "why"],
  },
} as const;
