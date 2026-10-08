// Holds every sentence by its order of speech and derives what the screen
// shows. Scores can return out of order; each one lands at its own sequence
// number, so the list and the needle follow speech order, not arrival order.
//
// A line the scorer says makes no claim (a greeting, a broken fragment) is
// listed as not scored and never touches the needle, the hottest line or the
// synopsis. Before 2026-10-07 such lines scored 1.0 and held the needle flat.

export interface Entry {
  seq: number;
  text: string; // what the screen shows: heard text, or a guarded proper-noun fix
  heard: string; // exactly what speech recognition returned
  finalAt: number; // ms, when the final transcript that completed it arrived
  status: "pending" | "scored" | "noclaim" | "dropped";
  score?: number;
  reason?: string;
  lagMs?: number;
}

export class MeterStore {
  private entries = new Map<number, Entry>();
  private nextSeq = 0;
  private hottestSeq: number | null = null;

  add(text: string, finalAt: number): Entry {
    const e: Entry = { seq: this.nextSeq++, text, heard: text, finalAt, status: "pending" };
    this.entries.set(e.seq, e);
    return e;
  }

  resolve(seq: number, score: number, reason: string, claim = true, shownText?: string): Entry | null {
    const e = this.entries.get(seq);
    if (!e || e.status !== "pending") return null;
    if (shownText) e.text = shownText;
    e.reason = reason;
    if (!claim) {
      e.status = "noclaim";
      return e;
    }
    e.status = "scored";
    e.score = score;
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

  get(seq: number): Entry | null {
    return this.entries.get(seq) ?? null;
  }

  // Lines that make a claim and were scored, newest spoken first.
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

  pendingCount(): number {
    return [...this.entries.values()].filter((e) => e.status === "pending").length;
  }

  lags(): number[] {
    return [...this.entries.values()].filter((e) => e.lagMs !== undefined).map((e) => e.lagMs!);
  }
}
