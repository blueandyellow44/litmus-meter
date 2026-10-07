import { describe, expect, it } from "vitest";
import { MeterStore } from "../src/lib/meterStore.ts";
import { Pipeline, type ScoreResult } from "../src/lib/pipeline.ts";
import { SentenceAssembler, splitSentences } from "../src/lib/sentences.ts";
import { needleDegrees, bandLabel } from "../src/lib/bands.ts";

const interim = (t: string) => ({ type: "Results", is_final: false, speech_final: false, channel: { alternatives: [{ transcript: t }] } });
const final = (t: string, speechFinal = false) => ({ type: "Results", is_final: true, speech_final: speechFinal, channel: { alternatives: [{ transcript: t }] } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const calls: Array<{ text: string; d: ReturnType<typeof deferred<ScoreResult>> }> = [];
  const interims: string[] = [];
  const changed: Array<number | null> = [];
  const p = new Pipeline(
    (text) => {
      const d = deferred<ScoreResult>();
      calls.push({ text, d });
      return d.promise;
    },
    { interim: (t) => interims.push(t), changed: (s) => changed.push(s), cost: () => {}, warn: () => {}, budget: () => {} },
    () => 0,
  );
  return { p, calls, interims, changed };
}

const scored = (score: number, reason = "r"): ScoreResult => ({ kind: "scored", score, reason, costUsd: 0.002, warn: false });

describe("one scoring call per final sentence, none for interims", () => {
  it("interims update the live line and never score", () => {
    const h = harness();
    h.p.handleMessage(interim("The Senate"));
    h.p.handleMessage(interim("The Senate passed the bill."));
    h.p.handleMessage(interim("The Senate passed the bill. It now"));
    expect(h.calls).toHaveLength(0);
    expect(h.interims.at(-1)).toBe("The Senate passed the bill. It now");
  });

  it("scores each sentence in a final the moment it arrives, in parallel", () => {
    const h = harness();
    h.p.handleMessage(final("The Senate passed the bill. It now goes to the House."));
    expect(h.calls.map((c) => c.text)).toEqual(["The Senate passed the bill.", "It now goes to the House."]);
    // Both requests are in flight together; nothing waited on the first.
  });

  it("a final that ends mid-sentence waits for the final that completes it, then scores once", () => {
    const h = harness();
    h.p.handleMessage(final("The bill funds the government through March"));
    expect(h.calls).toHaveLength(0);
    h.p.handleMessage(interim("and adds four billion"));
    expect(h.calls).toHaveLength(0);
    h.p.handleMessage(final("and adds four billion dollars for disaster relief."));
    expect(h.calls.map((c) => c.text)).toEqual(["The bill funds the government through March and adds four billion dollars for disaster relief."]);
  });

  it("an unpunctuated tail is scored when the speaker pauses (speech_final or UtteranceEnd), and only once", () => {
    const h = harness();
    h.p.handleMessage(final("back to you in the studio", true));
    expect(h.calls.map((c) => c.text)).toEqual(["back to you in the studio"]);
    h.p.handleMessage({ type: "UtteranceEnd" });
    expect(h.calls).toHaveLength(1);

    h.p.handleMessage(final("and that is the news"));
    h.p.handleMessage({ type: "UtteranceEnd" });
    expect(h.calls.map((c) => c.text)).toEqual(["back to you in the studio", "and that is the news"]);
  });

  it("stop ends scoring of anything that arrives later", () => {
    const h = harness();
    h.p.stop();
    h.p.handleMessage(final("After stop."));
    expect(h.calls).toHaveLength(0);
  });
});

describe("out-of-order responses", () => {
  it("places each score by sentence order, not arrival order", async () => {
    const h = harness();
    h.p.handleMessage(final("First. Second. Third."));
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.d.resolve(scored(4.0, "third"));
    await tick();
    h.calls[0]!.d.resolve(scored(1.0, "first"));
    await tick();
    h.calls[1]!.d.resolve(scored(2.0, "second"));
    await tick();
    expect(h.p.store.scored().map((e) => e.text)).toEqual(["Third.", "Second.", "First."]);
    // Needle = the two latest-SPOKEN sentences (Third, Second), not the last two to arrive.
    expect(h.p.store.needle()).toBeCloseTo(3.0);
    expect(h.p.store.needleSentence()?.text).toBe("Third.");
  });

  it("a late answer for an earlier sentence does not move the needle off the latest pair", async () => {
    const h = harness();
    h.p.handleMessage(final("Alpha. Beta. Gamma."));
    h.calls[1]!.d.resolve(scored(2.0));
    h.calls[2]!.d.resolve(scored(3.0));
    await tick();
    expect(h.p.store.needle()).toBeCloseTo(2.5);
    h.calls[0]!.d.resolve(scored(5.0));
    await tick();
    expect(h.p.store.needle()).toBeCloseTo(2.5);
    expect(h.p.store.hottest()?.text).toBe("Alpha.");
  });

  it("a malformed (dropped) sentence never appears and never moves the needle", async () => {
    const h = harness();
    h.p.handleMessage(final("Good one. Bad one."));
    h.calls[0]!.d.resolve(scored(2.0));
    h.calls[1]!.d.resolve({ kind: "dropped", costUsd: 0.002, warn: false });
    await tick();
    expect(h.p.store.scored().map((e) => e.text)).toEqual(["Good one."]);
    expect(h.p.store.needle()).toBeCloseTo(2.0);
  });

  it("a network failure on one sentence does not stop the others", async () => {
    const calls: string[] = [];
    const p = new Pipeline(
      async (text) => {
        calls.push(text);
        if (text === "Fails.") throw new Error("offline");
        return scored(1.5);
      },
      { interim: () => {}, changed: () => {}, cost: () => {}, warn: () => {}, budget: () => {} },
      () => 0,
    );
    p.handleMessage(final("Fails. Works."));
    await tick();
    expect(p.store.scored().map((e) => e.text)).toEqual(["Works."]);
  });
});

describe("rolling 2-sentence average", () => {
  it("is null before any score, the score itself after one, then the mean of the latest two", () => {
    const s = new MeterStore();
    expect(s.needle()).toBeNull();
    const a = s.add("a", 0);
    s.resolve(a.seq, 1.0, "");
    expect(s.needle()).toBe(1.0);
    const b = s.add("b", 0);
    s.resolve(b.seq, 3.0, "");
    expect(s.needle()).toBe(2.0);
    const c = s.add("c", 0);
    s.resolve(c.seq, 5.0, "");
    expect(s.needle()).toBe(4.0);
  });

  it("skips dropped sentences when choosing the latest two", () => {
    const s = new MeterStore();
    const a = s.add("a", 0);
    const b = s.add("b", 0);
    const c = s.add("c", 0);
    s.resolve(a.seq, 2.0, "");
    s.drop(b.seq);
    s.resolve(c.seq, 4.0, "");
    expect(s.needle()).toBe(3.0);
  });

  it("hottest keeps the first line to reach the top score", () => {
    const s = new MeterStore();
    const a = s.add("a", 0);
    const b = s.add("b", 0);
    s.resolve(b.seq, 4.2, "");
    s.resolve(a.seq, 4.2, "");
    expect(s.hottest()?.text).toBe("a");
  });
});

describe("sentence splitting", () => {
  it("does not split on abbreviations, initialisms or decimals", () => {
    expect(splitSentences("The U.S. Senate met. Dr. Smith spoke at 3.5 percent.").complete).toEqual([
      "The U.S. Senate met.",
      "Dr. Smith spoke at 3.5 percent.",
    ]);
  });

  it("splits on question and exclamation marks, including inside closing quotes", () => {
    expect(splitSentences('Is it over? He said "No!" Then left').complete).toEqual(["Is it over?", 'He said "No!"']);
  });

  it("assembler carries the unfinished tail", () => {
    const a = new SentenceAssembler();
    expect(a.addFinal("One. Two", false)).toEqual(["One."]);
    expect(a.pending).toBe("Two");
    expect(a.addFinal("three.", false)).toEqual(["Two three."]);
  });
});

describe("gauge mapping", () => {
  it("maps 1 to far left, 3 to straight up, 5 to far right, with the renamed end labels", () => {
    expect(needleDegrees(1)).toBe(-90);
    expect(needleDegrees(3)).toBe(0);
    expect(needleDegrees(5)).toBe(90);
    expect(bandLabel(1.4)).toBe("Proportionate");
    expect(bandLabel(1.45)).toBe("Proportionate");
    expect(bandLabel(4.5)).toBe("Hyperbolic");
  });
});
