import type { Deps, Env } from "../server/router.ts";
import { SpendLedger, type SpendStore } from "../server/spend.ts";
import type { AnthropicResponse, CallAnthropic } from "../server/score.ts";

export class MemoryStore implements SpendStore {
  map = new Map<string, string>();
  puts = 0;
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.puts++;
    this.map.set(k, v);
  }
}

export const PASSCODE = "correct horse";
export const NOW = 1_800_000_000_000;

export function goodResponse(score = 2.3, reason = "one warm verb"): AnthropicResponse {
  return {
    content: [{ type: "tool_use", name: "report_score", input: { text: "x", score, reason } }],
    usage: { input_tokens: 1200, output_tokens: 60 },
  };
}

export function makeDeps(store: MemoryStore, over: Partial<Deps> = {}) {
  const pending: Promise<unknown>[] = [];
  const calls: unknown[] = [];
  const logs: Record<string, unknown>[] = [];
  const anthropic: CallAnthropic = async (body) => {
    calls.push(body);
    return goodResponse();
  };
  const deps: Deps = {
    now: () => NOW,
    waitUntil: (p) => void pending.push(p),
    ledger: new SpendLedger(store, async () => {}),
    anthropic,
    deepgramToken: async () => ({ access_token: "jwt", expires_in: 30 }),
    log: (e) => void logs.push(e),
    ...over,
  };
  return { deps, pending, calls, logs, flush: () => Promise.all(pending) };
}

export function env(store: MemoryStore, over: Partial<Env> = {}): Env {
  return { METER_KV: store, METER_PASSCODE: PASSCODE, ...over };
}

export function req(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`https://meter.example${path}`, { ...init, headers });
}
