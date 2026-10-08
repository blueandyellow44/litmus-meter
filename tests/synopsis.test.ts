import { describe, expect, it } from "vitest";
import { handle } from "../server/router.ts";
import { acceptCorrection, validateToolOutput } from "../server/score.ts";
import { summarize, whyQuotesALine, type ScoredLine } from "../server/synopsis.ts";
import { computeVerdict, parseVerdict } from "../server/verdict.ts";
import { validateMarks } from "../server/marks.ts";
import { parseAppeal, validateDevices } from "../server/labels.ts";
import { env, makeDeps, MemoryStore, PASSCODE, req } from "./helpers.ts";
import { SPEND_KEY } from "../server/spend.ts";
import type { AnthropicResponse } from "../server/score.ts";

const line = (seq: number, score: number, text = `Line number ${seq} says a thing.`): ScoredLine => ({ seq, text, score, reason: `reason ${seq}` });

describe("proper-noun correction guard", () => {
  it("accepts a misheard proper noun", () => {
    expect(acceptCorrection("We take over the Strait Of Hormones.", "We take over the Strait of Hormuz.")).toBe("We take over the Strait of Hormuz.");
  });
  it("refuses a lowercase word change, a rewrite, or more than three changed words", () => {
    const heard = "We are going to win so big on trade.";
    expect(acceptCorrection(heard, "We are going to lose so big on trade.")).toBe(heard);
    expect(acceptCorrection(heard, "The administration expects large gains in trade policy.")).toBe(heard);
    expect(acceptCorrection("a b c d e", "A B C D e")).toBe("a b c d e"); // case only
    expect(acceptCorrection("one two three four five six", "One Two Three Four Five six")).toBe("one two three four five six");
    expect(acceptCorrection("near one two three four five six", "near Uno Dos Tres Cuatro five six")).toBe("near one two three four five six");
  });
  it("a reply without the claim flag is malformed", () => {
    const r: AnthropicResponse = { content: [{ type: "tool_use", name: "report_score", input: { text: "x", score: 2, reason: "r" } }] };
    expect(validateToolOutput(r)).toBeNull();
  });
});

describe("summarize", () => {
  it("is the plain average of the claim lines, with band, counts and both kinds of proof", () => {
    const s = summarize([line(0, 1.0), line(1, 1.2), line(2, 4.6), line(3, 1.4), line(4, 2.8)])!;
    expect(s.score).toBe(2.2); // (1.0+1.2+4.6+1.4+2.8)/5 = 2.2
    expect(s.band).toBe("Grounded");
    expect(s.counts).toEqual({ Proportionate: 3, Grounded: 0, "Mixed Signals": 1, "Running Hot": 0, Hyperbolic: 1 });
    expect(s.hottest.map((l) => l.seq)).toEqual([2, 4, 3]);
    expect(s.calmest.map((l) => l.seq)).toEqual([0, 1]);
  });
  it("refuses to judge fewer than three lines", () => {
    expect(summarize([line(0, 4), line(1, 4)])).toBeNull();
  });
  it("breaks ties by speech order, never by arrival", () => {
    const s = summarize([line(5, 3.0), line(2, 3.0), line(9, 1.0)])!;
    expect(s.hottest[0]!.seq).toBe(2);
  });
});

describe("why must quote a line", () => {
  const lines = ["We will knock out their whole navy tonight."];
  it("passes with three consecutive words, ignoring case and punctuation", () => {
    expect(whyQuotesALine('The heat came from "knock out their" navy talk.', lines)).toBe(true);
  });
  it("fails without them", () => {
    expect(whyQuotesALine("The speaker used military language.", lines)).toBe(false);
  });
});

describe("whole-speech verdict, the site's composite", () => {
  const flags = { loadedFraming: false, emotionalOpen: false, fallacyCount: 0, oneSidedSourcing: false, advocacySpeech: false };
  it("weights framing and language double, like headline and language on the site", () => {
    // (2*3 + 2*4 + 2 + 2 + 2) / 7 = 20/7 = 2.857 -> 2.9
    expect(computeVerdict({ framing: 3, language: 4, sourcing: 2, fallacies: 2, structure: 2 }, flags).score).toBe(2.9);
  });
  it("applies the site's floors: fallacies, one-sided sourcing, the pair floors, advocacy", () => {
    const calm = { framing: 1, language: 1, sourcing: 1, fallacies: 1, structure: 1 };
    expect(computeVerdict(calm, { ...flags, fallacyCount: 3 }).raised).toContain("3 distinct logical fallacies");
    expect(computeVerdict(calm, { ...flags, loadedFraming: true, emotionalOpen: true }).score).toBe(3.5);
    expect(computeVerdict({ ...calm, framing: 4.5, language: 4.5 }, flags).score).toBe(4.5);
    expect(computeVerdict(calm, { ...flags, advocacySpeech: true }).score).toBe(2.5);
    expect(computeVerdict(calm, flags).score).toBe(1.0);
  });
  it("refuses answers that break the binding rules, like the site", () => {
    const base = { framing: 3, language: 3, sourcing: 2, fallacies: 2, structure: 2, loaded_framing: false, emotional_open: false, fallacy_count: 0, one_sided_sourcing: false, advocacy_speech: true, why: "x" };
    expect(parseVerdict(base).ok).toBe(true);
    expect(parseVerdict({ ...base, sourcing: 3 }).ok).toBe(false);
    expect(parseVerdict({ ...base, fallacies: 2.5 }).ok).toBe(false);
    expect(parseVerdict({ ...base, framing: 6 }).ok).toBe(false);
    expect(parseVerdict({ ...base, fallacy_count: 1.5 }).ok).toBe(false);
  });
});

describe("synopsis route", () => {
  async function signIn(store: MemoryStore) {
    const { deps } = makeDeps(store);
    const res = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store), deps);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const lines = [line(0, 1.0), line(1, 4.4, "They are destroying this great country of ours."), line(2, 1.2)];
  const transcript = ["Line number 0 says a thing.", "They are destroying this great country of ours.", "Line number 2 says a thing."];
  const body = JSON.stringify({ lines, transcript });
  const verdict = (over: Record<string, unknown> = {}): AnthropicResponse => ({
    content: [{ type: "tool_use", name: "report_verdict", input: { framing: 4, language: 4, sourcing: 2, fallacies: 2.5, structure: 3, loaded_framing: true, emotional_open: false, fallacy_count: 1, one_sided_sourcing: false, advocacy_speech: true, why: 'Words like "destroying this great country" set it.', summary: "The speaker said the country is being destroyed.", ...over } }],
    usage: { input_tokens: 2000, output_tokens: 120 },
  });
  type R = { summary: { score: number } | null; verdict: { score: number; band: string } | null; why: string | null };

  it("is refused without a cookie", async () => {
    const store = new MemoryStore();
    const { deps } = makeDeps(store);
    expect((await handle(req("/api/synopsis", { method: "POST", body }), env(store), deps)).status).toBe(401);
  });

  it("leads with the whole-speech verdict computed in code, and keeps the line average", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store, { anthropic: async () => verdict() });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as R;
    // (2*4 + 2*4 + 2 + 2.5 + 3) / 7 = 23.5/7 = 3.357 -> 3.4
    expect(r.verdict).toMatchObject({ score: 3.4, band: "Mixed Signals" });
    expect(r.summary!.score).toBe(2.2);
    expect(r.why).toContain("destroying this great country");
    expect((r as unknown as { summary_text: string }).summary_text).toBe("The speaker said the country is being destroyed.");
  });

  it("a refused verdict is retried once with the problem named", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const seen: string[] = [];
    let n = 0;
    const h = makeDeps(store, {
      anthropic: async (b) => {
        seen.push(JSON.stringify(b));
        return n++ === 0 ? verdict({ sourcing: 3.5 }) : verdict();
      },
    });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as R;
    expect(n).toBe(2);
    expect(seen[1]).toContain("sourcing above 2.0");
    expect(r.verdict!.score).toBe(3.4);
  });

  it("a Why that quotes nothing is retried, then left out; the verdict still shows", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    let n = 0;
    const h = makeDeps(store, { anthropic: async () => (n++, verdict({ why: "The speaker was very dramatic." })) });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as R;
    expect(n).toBe(2);
    expect(r.why).toBeNull();
    expect(r.verdict!.score).toBe(3.4);
  });

  it("two refusals fall back to the line average, labelled as such", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store, { anthropic: async () => verdict({ framing: 9 }) });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as R;
    expect(r.verdict).toBeNull();
    expect(r.summary!.score).toBe(2.2);
  });

  it("at the $50 cap returns the line numbers and makes no model call", async () => {
    const store = new MemoryStore();
    store.map.set(SPEND_KEY, "50");
    const cookie = await signIn(store);
    let calls = 0;
    const h = makeDeps(store, { anthropic: async () => (calls++, verdict()) });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as R;
    expect(calls).toBe(0);
    expect(r.verdict).toBeNull();
    expect(r.summary).toBeTruthy();
  });

  it("answers summary null when fewer than three lines made a claim", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store);
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body: JSON.stringify({ lines: [line(0, 2)], transcript }) }), env(store), h.deps)).json()) as R;
    expect(r.summary).toBeNull();
  });
});

describe("no-claim gate (live tests 2026-10-07)", () => {
  const reply = (text: string, claim: boolean, score: number): AnthropicResponse => ({ content: [{ type: "tool_use", name: "report_score", input: { text, claim, score, reason: "r" } }] });
  it("a hot line cannot hide behind no-claim", () => {
    expect(validateToolOutput(reply("They hate America. So in this election.", false, 4.1))!.claim).toBe(true);
  });
  it("a calm aside is not counted, however long", () => {
    expect(validateToolOutput(reply("You know, there are lot of goat I love that goat.", false, 1.0))!.claim).toBe(false);
  });
  it("the boundary: 1.4 may be no-claim, 1.5 is counted", () => {
    expect(validateToolOutput(reply("x y", false, 1.4))!.claim).toBe(false);
    expect(validateToolOutput(reply("x y", false, 1.5))!.claim).toBe(true);
  });
});

describe("mark validation", () => {
  it("never marks words after a spoken quote, until unquote or the end of the line", () => {
    expect(validateMarks("Senator Hale said, quote, this is a catastrophe for families.", ["catastrophe"])).toEqual([]);
    expect(validateMarks("He said, quote, a disaster, unquote, and that is a radical lie.", ["disaster", "radical lie"])).toEqual(["radical lie"]);
  });
  const line = 'They are sick people, and the press called it "a total disaster" today.';
  it("keeps verbatim marks in the line's own spelling, any case", () => {
    expect(validateMarks(line, ["Sick People"])).toEqual(["sick people"]);
  });
  it("refuses invented words, quoted words, overlaps, long spans, and more than three", () => {
    expect(validateMarks(line, ["evil"])).toEqual([]);
    expect(validateMarks(line, ["total disaster"])).toEqual([]); // inside quotation marks
    expect(validateMarks(line, ["sick people", "sick"])).toEqual(["sick people"]);
    expect(validateMarks(line, ["They are sick people, and the press called it"])).toEqual([]); // nine words
    expect(validateMarks("a b c d e f", ["a", "b", "c", "d"])).toHaveLength(3);
    expect(validateMarks(line, "sick")).toEqual([]);
  });
});

describe("paragraph summary", () => {
  const base = { framing: 3, language: 3, sourcing: 2, fallacies: 2, structure: 2, loaded_framing: false, emotional_open: false, fallacy_count: 0, one_sided_sourcing: false, advocacy_speech: true, why: "x" };
  it("is returned, with em dashes removed", () => {
    const r = parseVerdict({ ...base, summary: "The speaker said a bill passed \u2014 then praised it." });
    expect(r.ok && r.value.summary).toBe("The speaker said a bill passed, then praised it.");
  });
  it("is optional: a missing summary does not refuse a sound verdict", () => {
    const r = parseVerdict(base);
    expect(r.ok && r.value.summary).toBeNull();
  });
});

describe("move and fallacy labels", () => {
  const line = 'They are sick people, and the press said "a total disaster", so vote on Tuesday.';
  it("keeps labels from the fixed lists whose words are verbatim and unquoted", () => {
    expect(validateDevices(line, [{ label: "Name-calling", words: "sick people" }, { label: "Direct ask", words: "vote on Tuesday" }])).toEqual([
      { label: "Name-calling", kind: "move", words: "sick people" },
      { label: "Direct ask", kind: "move", words: "vote on Tuesday" },
    ]);
    expect(validateDevices(line, [{ label: "Ad hominem", words: "sick people" }])[0]!.kind).toBe("fallacy");
  });
  it("refuses invented labels, invented or quoted words, duplicates and more than two", () => {
    expect(validateDevices(line, [{ label: "Gaslighting", words: "sick people" }])).toEqual([]);
    expect(validateDevices(line, [{ label: "Ad hominem", words: "evil people" }])).toEqual([]);
    expect(validateDevices(line, [{ label: "Appeal to fear", words: "total disaster" }])).toEqual([]);
    expect(validateDevices(line, [{ label: "Ad hominem", words: "sick" }, { label: "Ad hominem", words: "people" }])).toHaveLength(1);
    expect(validateDevices(line, [{ label: "Ad hominem", words: "sick" }, { label: "Name-calling", words: "people" }, { label: "Direct ask", words: "vote" }])).toHaveLength(2);
    expect(validateDevices(line, "Ad hominem")).toEqual([]);
  });
  it("accepts only the three appeals", () => {
    expect(parseAppeal("pathos")).toBe("pathos");
    expect(parseAppeal("none")).toBeNull();
    expect(parseAppeal("kairos")).toBeNull();
  });
});

describe("style name", () => {
  const base = { framing: 3, language: 3, sourcing: 2, fallacies: 2, structure: 2, loaded_framing: false, emotional_open: false, fallacy_count: 0, one_sided_sourcing: false, advocacy_speech: true, why: "x" };
  it("keeps two to six words, drops a trailing period", () => {
    const r = parseVerdict({ ...base, style_name: "Grievance and victory." });
    expect(r.ok && r.value.styleName).toBe("Grievance and victory");
  });
  it("drops a style name over six words, and its absence refuses nothing", () => {
    const r = parseVerdict({ ...base, style_name: "a very long name that goes on and on" });
    expect(r.ok && r.value.styleName).toBeNull();
    expect(parseVerdict(base).ok).toBe(true);
  });
});
