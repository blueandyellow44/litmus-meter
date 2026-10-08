import { describe, expect, it } from "vitest";
import { handle } from "../server/router.ts";
import { acceptCorrection, validateToolOutput } from "../server/score.ts";
import { summarize, whyQuotesALine, type ScoredLine } from "../server/synopsis.ts";
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
  const lines = [line(0, 4.0, "We will knock out their whole navy tonight.")];
  it("passes with three consecutive words, ignoring case and punctuation", () => {
    expect(whyQuotesALine('The heat came from "knock out their" navy talk.', lines)).toBe(true);
  });
  it("fails without them", () => {
    expect(whyQuotesALine("The speaker used military language.", lines)).toBe(false);
  });
});

describe("synopsis route", () => {
  async function signIn(store: MemoryStore) {
    const { deps } = makeDeps(store);
    const res = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store), deps);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }
  const body = JSON.stringify({ lines: [line(0, 1.0), line(1, 4.4, "They are destroying this great country of ours."), line(2, 1.2)] });
  const why = (text: string): AnthropicResponse => ({ content: [{ type: "tool_use", name: "report_why", input: { why: text } }], usage: { input_tokens: 500, output_tokens: 30 } });

  it("is refused without a cookie", async () => {
    const store = new MemoryStore();
    const { deps } = makeDeps(store);
    expect((await handle(req("/api/synopsis", { method: "POST", body }), env(store), deps)).status).toBe(401);
  });

  it("keeps a Why that quotes a line", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store, { anthropic: async () => why('Mostly level, but "destroying this great country" pushed it up.') });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as { why: string; summary: { band: string; score: number } };
    expect(r.summary.score).toBe(2.2);
    expect(r.why).toContain("destroying this great country");
  });

  it("retries once, then shows no Why rather than an unsupported one", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    let calls = 0;
    const h = makeDeps(store, { anthropic: async () => (calls++, why("The speaker was very dramatic.")) });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as { why: string | null };
    expect(calls).toBe(2);
    expect(r.why).toBeNull();
    expect(h.logs.filter((l) => l.event === "why_rejected")).toHaveLength(2);
  });

  it("at the $50 cap still returns the numbers but makes no model call", async () => {
    const store = new MemoryStore();
    store.map.set(SPEND_KEY, "50");
    const cookie = await signIn(store);
    let calls = 0;
    const h = makeDeps(store, { anthropic: async () => (calls++, why("x")) });
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body }), env(store), h.deps)).json()) as { why: null; summary: object };
    expect(calls).toBe(0);
    expect(r.summary).toBeTruthy();
    expect(r.why).toBeNull();
  });

  it("answers summary null when fewer than three lines made a claim", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store);
    const r = (await (await handle(req("/api/synopsis", { method: "POST", cookie, body: JSON.stringify({ lines: [line(0, 2)] }) }), env(store), h.deps)).json()) as { summary: null };
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
