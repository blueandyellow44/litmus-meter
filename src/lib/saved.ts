// The last listen, kept in this browser (Max, 2026-10-07: "yes add both").
// A reload or a closed tab used to lose the speech and its report; now the
// lines, their labels, their timing and the end report are saved as they
// happen and restored on load. Browser storage can be missing or full
// (private windows, blocked site data), so every access is guarded and the
// meter works the same without it.

import type { Synopsis } from "./api.ts";
import { MeterStore, type Entry } from "./meterStore.ts";

const KEY = "litmus-meter:last-listen";
const VERSION = 1;

export interface SavedEntry {
  seq: number;
  tMs: number; // when the line was final, from the start of the listen
  text: string;
  heard: string;
  status: Entry["status"];
  score?: number;
  reason?: string;
  marks?: string[];
  devices?: Entry["devices"];
  appeal?: Entry["appeal"];
}

export interface SavedListen {
  v: number;
  savedAt: string; // ISO time
  durationMs: number;
  entries: SavedEntry[];
  result: Synopsis | null; // null while listening, or if the report failed
}

export function snapshot(store: MeterStore, startedAt: number, durationMs: number, result: Synopsis | null): SavedListen {
  return {
    v: VERSION,
    savedAt: new Date().toISOString(),
    durationMs,
    result,
    entries: store.spoken().map((e) => ({
      seq: e.seq,
      tMs: e.finalAt - startedAt,
      text: e.text,
      heard: e.heard,
      status: e.status,
      score: e.score,
      reason: e.reason,
      marks: e.marks,
      devices: e.devices,
      appeal: e.appeal,
    })),
  };
}

export function save(listen: SavedListen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listen));
  } catch (err) {
    console.warn("could not save the listen in this browser", err);
  }
}

export function load(): SavedListen | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as SavedListen;
    if (v?.v !== VERSION || !Array.isArray(v.entries)) return null;
    return v;
  } catch (err) {
    console.warn("could not read the saved listen", err);
    return null;
  }
}

// Rebuilds a store from a saved listen, at its original timing, so the report
// draws exactly what was heard. startedAt is 0 because the times are relative.
export function restore(listen: SavedListen): MeterStore {
  const store = new MeterStore();
  for (const s of [...listen.entries].sort((a, b) => a.seq - b.seq)) {
    const e = store.add(s.text, s.tMs, s.seq);
    e.heard = s.heard;
    if (s.status === "scored" || s.status === "noclaim") {
      store.resolve(e.seq, s.score ?? 1, s.reason ?? "", s.status === "scored", s.text, s.marks ?? [], s.devices ?? [], s.appeal ?? null);
    } else {
      store.drop(e.seq);
    }
  }
  return store;
}
