// Calls to this app's own /api routes. The session cookie rides along
// automatically (same origin, HttpOnly).

import type { ScoreResult } from "./pipeline.ts";

export interface SpendFields {
  total_usd: number;
  warn: boolean;
  capped: boolean;
}

export interface SessionInfo extends SpendFields {
  stub: boolean;
  rates: { deepgram_usd_per_min: number; cap_usd: number; warn_usd: number };
}

export class BudgetReached extends Error {}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function getSession(): Promise<SessionInfo | null> {
  const res = await fetch("/api/session");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`session check failed (${res.status})`);
  return (await res.json()) as SessionInfo;
}

export async function login(passcode: string): Promise<boolean> {
  const res = await post("/api/login", { passcode });
  return res.ok;
}

export async function deepgramToken(): Promise<{ access_token: string; stub: boolean } & SpendFields> {
  const res = await post("/api/deepgram-token", {});
  if (res.status === 402) throw new BudgetReached();
  if (!res.ok) throw new Error(`Could not start transcription (${res.status}).`);
  return res.json();
}

export async function listenTick(seconds: number): Promise<SpendFields & { cost_usd: number }> {
  const res = await post("/api/listen-tick", { seconds });
  if (!res.ok) throw new Error(`listen tick failed (${res.status})`);
  return res.json();
}

export async function scoreSentence(text: string): Promise<ScoreResult> {
  const res = await post("/api/score", { text });
  if (res.status === 402) return { kind: "budget" };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    return {
      kind: "scored",
      score: Number(body.score),
      reason: String(body.reason),
      claim: body.claim !== false,
      text: typeof body.text === "string" && body.text ? body.text : text,
      costUsd: Number(body.cost_usd) || 0,
      warn: body.warn === true,
    };
  }
  // 422 malformed model output, 502 scorer down: the sentence is dropped.
  return { kind: "dropped", costUsd: Number(body.cost_usd) || 0, warn: body.warn === true };
}

export interface SynopsisLine {
  seq: number;
  text: string;
  score: number;
  reason: string;
}

export interface Synopsis {
  summary: {
    lines: number;
    score: number;
    band: string;
    counts: Record<string, number>;
    hottest: SynopsisLine[];
    calmest: SynopsisLine[];
  } | null;
  why: string | null;
}

export async function synopsis(lines: SynopsisLine[]): Promise<Synopsis> {
  const res = await post("/api/synopsis", { lines });
  if (!res.ok) throw new Error(`synopsis failed (${res.status})`);
  return res.json();
}
