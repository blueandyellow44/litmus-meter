// Deepgram messages in, scoring requests out.
//
// Interim results only update the "Speaker now" line. Each sentence completed
// by a FINAL result is scored on its own, immediately, in parallel with any
// request already in flight. Nothing is batched and nothing waits on a timer.

import { MeterStore } from "./meterStore.ts";
import { SentenceAssembler } from "./sentences.ts";

export type ScoreResult =
  | { kind: "scored"; score: number; reason: string; claim: boolean; text: string; costUsd: number; warn: boolean }
  | { kind: "dropped"; costUsd: number; warn: boolean }
  | { kind: "budget" };

export type ScoreFn = (text: string) => Promise<ScoreResult>;

export interface PipelineHooks {
  interim: (text: string) => void;
  changed: (resolvedSeq: number | null) => void;
  cost: (usd: number) => void;
  warn: () => void;
  budget: () => void;
}

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export class Pipeline {
  readonly store = new MeterStore();
  private readonly assembler = new SentenceAssembler();
  private stopped = false;
  private inFlight = new Set<Promise<void>>();

  constructor(
    private readonly score: ScoreFn,
    private readonly hooks: PipelineHooks,
    private readonly now: () => number = () => performance.now(),
  ) {}

  stop(): void {
    this.stopped = true;
  }

  // Stop listening for new speech but release what the speaker already said,
  // then wait for every score in flight. The synopsis runs after this.
  async finish(): Promise<void> {
    this.dispatch(this.assembler.flush());
    this.stopped = true;
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  handleMessage(raw: unknown): void {
    if (this.stopped || !raw || typeof raw !== "object") return;
    const msg = raw as { type?: string };
    if (msg.type === "UtteranceEnd") {
      this.dispatch(this.assembler.flush());
      return;
    }
    if (msg.type !== "Results") return;
    const r = msg as DeepgramResults;
    const transcript = r.channel?.alternatives?.[0]?.transcript ?? "";
    if (!r.is_final) {
      // Show the unfinished tail of the last final plus what is being said now.
      this.hooks.interim([this.assembler.pending, transcript].filter(Boolean).join(" "));
      return;
    }
    this.dispatch(this.assembler.addFinal(transcript, r.speech_final === true));
    this.hooks.interim(this.assembler.pending);
  }

  private dispatch(sentences: string[]): void {
    const finalAt = this.now();
    for (const text of sentences) {
      const entry = this.store.add(text, finalAt);
      const p = this.scoreOne(entry.seq, text).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  private async scoreOne(seq: number, text: string): Promise<void> {
    let result: ScoreResult;
    try {
      result = await this.score(text);
    } catch (err) {
      console.warn("score request failed; sentence dropped", { seq, text, err });
      this.store.drop(seq);
      return;
    }
    if (result.kind === "budget") {
      this.store.drop(seq);
      this.hooks.budget();
      return;
    }
    this.hooks.cost(result.costUsd);
    if (result.warn) this.hooks.warn();
    // A score that returns after Stop is still placed: the sentence was heard.
    if (result.kind === "dropped") {
      console.warn("malformed score; sentence dropped", { seq, text });
      this.store.drop(seq);
      return;
    }
    this.store.resolve(seq, result.score, result.reason, result.claim, result.text);
    this.hooks.changed(seq);
  }
}
