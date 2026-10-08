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
  status: "pending" | "scored" | "noclaim" | "dropped" | "merged";
  score?: number;
  reason?: string;
  marks?: string[]; // the speaker's own hyperbolic words in `text`, verbatim
  lagMs?: number;
}

export class MeterStore {
  private entries = new Map<number, Entry>();
  private nextSeq = 0;

  add(text: string, finalAt: number): Entry {
    const e: Entry = { seq: this.nextSeq++, text, heard: text, finalAt, status: "pending" };
    this.entries.set(e.seq, e);
    return e;
  }

  resolve(seq: number, score: number, reason: string, claim = true, shownText?: string, marks: string[] = []): Entry | null {
    const e = this.entries.get(seq);
    if (!e || e.status !== "pending") return null;
    if (shownText) e.text = shownText;
    e.reason = reason;
    e.marks = claim ? marks : [];
    if (!claim) {
      e.status = "noclaim";
      return e;
    }
    e.status = "scored";
    e.score = score;
    return e;
  }

  // The line before `seq` that this one finished: the latest earlier entry
  // still on screen or in flight. Null when there is nothing to continue.
  previousOf(seq: number): Entry | null {
    for (let s = seq - 1; s >= 0; s--) {
      const e = this.entries.get(s);
      if (e && e.status !== "dropped" && e.status !== "merged") return e;
    }
    return null;
  }

  // Self-correcting lines (Max, 2026-10-07): the previous line is folded into
  // this one, which carries the whole thought and the score for it. The
  // previous entry stops counting anywhere; if its own score arrives later,
  // resolve() ignores it because it is no longer pending.
  merge(prevSeq: number, seq: number): void {
    const prev = this.entries.get(prevSeq);
    const cur = this.entries.get(seq);
    if (!prev || !cur || prevSeq >= seq) return;
    cur.text = `${prev.text} ${cur.text}`;
    cur.heard = `${prev.heard} ${cur.heard}`;
    prev.status = "merged";
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

  // Computed fresh because a merge can retire the line that was hottest.
  // Ties go to the earlier line, so the pick never depends on arrival order.
  hottest(): Entry | null {
    let hot: Entry | null = null;
    for (const e of this.scored()) {
      if (!hot || e.score! > hot.score! || (e.score === hot.score && e.seq < hot.seq)) hot = e;
    }
    return hot;
  }

  // Everything the speaker said, in order, for the whole-listen verdict.
  // A merged line is skipped because its words live on in the line that
  // absorbed it.
  transcript(): string[] {
    return this.spoken().map((e) => e.text);
  }

  // The resolved lines in speech order, merged lines excluded: the recap's
  // "whole speech" and the verdict's transcript come from the same list.
  spoken(): Entry[] {
    return [...this.entries.values()]
      .filter((e) => e.status !== "merged" && e.status !== "pending")
      .sort((a, b) => a.seq - b.seq);
  }

  pendingCount(): number {
    return [...this.entries.values()].filter((e) => e.status === "pending").length;
  }

  lags(): number[] {
    return [...this.entries.values()].filter((e) => e.lagMs !== undefined).map((e) => e.lagMs!);
  }
}
