// Holds every sentence by its order of speech and derives what the screen
// shows. Scores can return out of order; each one lands at its own sequence
// number, so the list and the needle follow speech order, not arrival order.

export interface Entry {
  seq: number;
  text: string;
  finalAt: number; // ms, when the final transcript that completed it arrived
  status: "pending" | "scored" | "dropped";
  score?: number;
  reason?: string;
  lagMs?: number;
}

export class MeterStore {
  private entries = new Map<number, Entry>();
  private nextSeq = 0;
  private hottestSeq: number | null = null;

  add(text: string, finalAt: number): Entry {
    const e: Entry = { seq: this.nextSeq++, text, finalAt, status: "pending" };
    this.entries.set(e.seq, e);
    return e;
  }

  resolve(seq: number, score: number, reason: string): Entry | null {
    const e = this.entries.get(seq);
    if (!e || e.status !== "pending") return null;
    e.status = "scored";
    e.score = score;
    e.reason = reason;
    const hot = this.hottest();
    // Strictly hotter replaces it, so the first line to reach a score keeps it.
    if (!hot || score > hot.score! || (score === hot.score! && seq < hot.seq)) this.hottestSeq = seq;
    return e;
  }

  drop(seq: number): void {
    const e = this.entries.get(seq);
    if (e && e.status === "pending") e.status = "dropped";
  }

  setLag(seq: number, lagMs: number): void {
    const e = this.entries.get(seq);
    if (e) e.lagMs = lagMs;
  }

  // Scored sentences, newest spoken first.
  scored(): Entry[] {
    return [...this.entries.values()].filter((e) => e.status === "scored").sort((a, b) => b.seq - a.seq);
  }

  // Average of the two latest-spoken scored sentences; null before the first.
  needle(): number | null {
    const last = this.scored().slice(0, 2);
    if (last.length === 0) return null;
    return last.reduce((s, e) => s + e.score!, 0) / last.length;
  }

  // The latest-spoken scored sentence: the one the needle most reflects.
  needleSentence(): Entry | null {
    return this.scored()[0] ?? null;
  }

  hottest(): Entry | null {
    return this.hottestSeq === null ? null : (this.entries.get(this.hottestSeq) ?? null);
  }

  lags(): number[] {
    return [...this.entries.values()].filter((e) => e.lagMs !== undefined).map((e) => e.lagMs!);
  }
}
