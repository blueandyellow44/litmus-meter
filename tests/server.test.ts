import { describe, expect, it } from "vitest";
import { checkPasscode, COOKIE_NAME, hasValidSession, issueSessionCookie, SESSION_TTL_SECONDS } from "../server/auth.ts";
import { anthropicCostUsd, deepgramCostUsd } from "../server/prices.ts";
import { BUDGET_MESSAGE, handle, MAX_TICK_SECONDS } from "../server/router.ts";
import { validateToolOutput } from "../server/score.ts";
import { SPEND_KEY, SpendLedger } from "../server/spend.ts";
import { env, goodResponse, makeDeps, MemoryStore, NOW, PASSCODE, req } from "./helpers.ts";

async function signIn(store: MemoryStore): Promise<string> {
  const { deps } = makeDeps(store);
  const res = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store), deps);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie")!;
  return setCookie.split(";")[0]!;
}

describe("passcode check", () => {
  it("accepts only the exact configured passcode", () => {
    expect(checkPasscode(PASSCODE, PASSCODE)).toBe(true);
    expect(checkPasscode(PASSCODE + " ", PASSCODE)).toBe(false);
    expect(checkPasscode("correct hors", PASSCODE)).toBe(false);
    expect(checkPasscode("", PASSCODE)).toBe(false);
    expect(checkPasscode(undefined, PASSCODE)).toBe(false);
    expect(checkPasscode(12345, PASSCODE)).toBe(false);
  });

  it("lets nobody in when METER_PASSCODE is unset", () => {
    expect(checkPasscode("", undefined)).toBe(false);
    expect(checkPasscode("anything", "")).toBe(false);
  });

  it("login route sets an HttpOnly 12-hour cookie on success and refuses a wrong passcode", async () => {
    const store = new MemoryStore();
    const { deps } = makeDeps(store);
    const bad = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: "nope" }) }), env(store), deps);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store), deps);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toContain(`${COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookie).toContain("Secure");
    expect(SESSION_TTL_SECONDS).toBe(43200);
  });
});

describe("session cookie", () => {
  it("expires after 12 hours", async () => {
    const cookie = (await issueSessionCookie(PASSCODE, NOW, true)).split(";")[0]!;
    expect(await hasValidSession(cookie, PASSCODE, NOW + 1000)).toBe(true);
    expect(await hasValidSession(cookie, PASSCODE, NOW + SESSION_TTL_SECONDS * 1000 - 1)).toBe(true);
    expect(await hasValidSession(cookie, PASSCODE, NOW + SESSION_TTL_SECONDS * 1000)).toBe(false);
  });

  it("rejects a forged expiry, a tampered signature, and a cookie signed under another passcode", async () => {
    const cookie = (await issueSessionCookie(PASSCODE, NOW, true)).split(";")[0]!;
    const [, token] = cookie.split("=");
    const [exp, mac] = token!.split(".");
    expect(await hasValidSession(`${COOKIE_NAME}=${Number(exp) + 999999}.${mac}`, PASSCODE, NOW)).toBe(false);
    expect(await hasValidSession(`${COOKIE_NAME}=${exp}.${mac!.replace(/.$/, "0")}x`, PASSCODE, NOW)).toBe(false);
    expect(await hasValidSession(cookie, "a different passcode", NOW)).toBe(false);
    expect(await hasValidSession(null, PASSCODE, NOW)).toBe(false);
  });
});

describe("cookie enforcement on every route", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/session"],
    ["GET", "/api/spend"],
    ["POST", "/api/deepgram-token"],
    ["POST", "/api/score"],
    ["POST", "/api/listen-tick"],
    ["POST", "/api/synopsis"],
    ["GET", "/api/anything-else"],
  ];

  for (const [method, path] of routes) {
    it(`${method} ${path} without a cookie is 401 and does nothing`, async () => {
      const store = new MemoryStore();
      let anthropicCalls = 0;
      let tokenCalls = 0;
      const { deps } = makeDeps(store, {
        anthropic: async () => {
          anthropicCalls++;
          return goodResponse();
        },
        deepgramToken: async () => {
          tokenCalls++;
          return { access_token: "jwt", expires_in: 30 };
        },
      });
      const body = method === "POST" ? JSON.stringify({ text: "Hello there.", seconds: 10 }) : undefined;
      const res = await handle(req(path, { method, body }), env(store), deps);
      expect(res.status).toBe(401);
      expect(anthropicCalls + tokenCalls).toBe(0);
      expect(store.puts).toBe(0);

      const forged = await handle(req(path, { method, body, cookie: `${COOKIE_NAME}=9999999999999.deadbeef` }), env(store), deps);
      expect(forged.status).toBe(401);
    });
  }

  it("with a valid cookie the same routes answer", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const { deps } = makeDeps(store);
    expect((await handle(req("/api/spend", { cookie }), env(store), deps)).status).toBe(200);
    expect((await handle(req("/api/session", { cookie }), env(store), deps)).status).toBe(200);
    expect((await handle(req("/api/deepgram-token", { method: "POST", cookie }), env(store), deps)).status).toBe(200);
  });
});

describe("spend cap", () => {
  async function at(total: string) {
    const store = new MemoryStore();
    store.map.set(SPEND_KEY, total);
    const cookie = await signIn(store);
    let anthropicCalls = 0;
    let tokenCalls = 0;
    const h = makeDeps(store, {
      anthropic: async () => {
        anthropicCalls++;
        return goodResponse();
      },
      deepgramToken: async () => {
        tokenCalls++;
        return { access_token: "jwt", expires_in: 30 };
      },
    });
    const score = await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "The vote passed." }) }), env(store), h.deps);
    const token = await handle(req("/api/deepgram-token", { method: "POST", cookie }), env(store), h.deps);
    const spend = await (await handle(req("/api/spend", { cookie }), env(store), h.deps)).json();
    return { score, token, spend: spend as Record<string, unknown>, anthropicCalls, tokenCalls };
  }

  it("refuses scoring and token minting at exactly $50.00, with the budget message, and calls nothing", async () => {
    const r = await at("50.000000");
    expect(r.score.status).toBe(402);
    expect(r.token.status).toBe(402);
    expect(((await r.score.json()) as { message: string }).message).toBe(BUDGET_MESSAGE);
    expect(((await r.token.json()) as { message: string }).message).toBe("Meter budget reached");
    expect(r.anthropicCalls).toBe(0);
    expect(r.tokenCalls).toBe(0);
    expect(r.spend.capped).toBe(true);
  });

  it("still serves at $49.99", async () => {
    const r = await at("49.99");
    expect(r.score.status).toBe(200);
    expect(r.token.status).toBe(200);
    expect(r.spend.capped).toBe(false);
    expect(r.spend.warn).toBe(true);
  });

  it("warns at exactly $40.00 and not at $39.99", async () => {
    expect((await at("40.00")).spend.warn).toBe(true);
    expect((await at("40.00")).spend.capped).toBe(false);
    expect((await at("39.99")).spend.warn).toBe(false);
  });

  it("counts a charge that has not been written yet against the cap", async () => {
    const store = new MemoryStore();
    store.map.set(SPEND_KEY, "49.999");
    const ledger = new SpendLedger(store, () => new Promise(() => {})); // flush never fires
    void ledger.charge(0.002);
    expect((await ledger.state()).capped).toBe(true);
  });

  it("a corrupt stored total fails closed instead of reading as $0", async () => {
    const store = new MemoryStore();
    store.map.set(SPEND_KEY, "not a number");
    const cookie = await signIn(store);
    const { deps } = makeDeps(store);
    const res = await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "Hi." }) }), env(store), deps);
    expect(res.status).toBe(500);
  });

  it("charges Anthropic usage at Haiku 4.5 list price and Deepgram seconds at the README rate", async () => {
    expect(anthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(1.0, 10);
    expect(anthropicCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(5.0, 10);
    expect(deepgramCostUsd(60)).toBeCloseTo(0.0077, 10);

    const store = new MemoryStore();
    const cookie = await signIn(store);
    // Hold the flush window open until both charges are in, as two requests
    // inside 1.5 s would be.
    let openWindow!: () => void;
    const windowClosed = new Promise<void>((r) => (openWindow = r));
    const h = makeDeps(store, { ledger: new SpendLedger(store, () => windowClosed) });
    await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "The vote passed." }) }), env(store), h.deps);
    await handle(req("/api/listen-tick", { method: "POST", cookie, body: JSON.stringify({ seconds: 600 }) }), env(store), h.deps);
    openWindow();
    await h.flush();
    const expected = (1200 * 1 + 60 * 5) / 1e6 + deepgramCostUsd(MAX_TICK_SECONDS);
    expect(Number(store.map.get(SPEND_KEY))).toBeCloseTo(expected, 6);
    // Both charges rode one KV write.
    expect(store.puts).toBe(1);
  });
});

describe("scoring route", () => {
  it("sends exactly one sentence and no prior transcript", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    // Hold the flush window open until both charges are in, as two requests
    // inside 1.5 s would be.
    let openWindow!: () => void;
    const windowClosed = new Promise<void>((r) => (openWindow = r));
    const h = makeDeps(store, { ledger: new SpendLedger(store, () => windowClosed) });
    await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "Second sentence." }) }), env(store), h.deps);
    const body = h.calls[0] as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.messages).toEqual([{ role: "user", content: "Second sentence." }]);
  });

  it("drops malformed model output with a log line and still charges the call", async () => {
    const bad = [
      { content: [{ type: "text", text: "I think 3" }], usage: { input_tokens: 1000, output_tokens: 10 } },
      { content: [{ type: "tool_use", name: "report_score", input: { text: "x", score: "hot", reason: "r" } }], usage: { input_tokens: 1000, output_tokens: 10 } },
      { content: [{ type: "tool_use", name: "report_score", input: { text: "x", score: 7, reason: "r" } }], usage: { input_tokens: 1000, output_tokens: 10 } },
      { content: [{ type: "tool_use", name: "report_score", input: { text: "x", score: 2 } }], usage: { input_tokens: 1000, output_tokens: 10 } },
    ];
    for (const response of bad) {
      const store = new MemoryStore();
      const cookie = await signIn(store);
      const h = makeDeps(store, { anthropic: async () => response });
      const res = await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "Some sentence." }) }), env(store), h.deps);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { dropped: boolean }).dropped).toBe(true);
      expect(h.logs.some((l) => l.event === "malformed_score_dropped")).toBe(true);
      await h.flush();
      expect(Number(store.map.get(SPEND_KEY))).toBeGreaterThan(0);
    }
  });

  it("a scorer outage drops the sentence without crashing", async () => {
    const store = new MemoryStore();
    const cookie = await signIn(store);
    const h = makeDeps(store, { anthropic: async () => { throw new Error("529 overloaded"); } });
    const res = await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "Hi." }) }), env(store), h.deps);
    expect(res.status).toBe(502);
  });

  it("validates and rounds a good tool call to one decimal", () => {
    expect(validateToolOutput(goodResponse(3.46, "loaded verb"))).toEqual({ text: "x", claim: true, continues: false, score: 3.5, reason: "loaded verb" });
    expect(validateToolOutput(goodResponse(1.0))).not.toBeNull();
    expect(validateToolOutput(goodResponse(5.0))).not.toBeNull();
    expect(validateToolOutput(goodResponse(0.9))).toBeNull();
    expect(validateToolOutput(goodResponse(5.1))).toBeNull();
    expect(validateToolOutput(goodResponse(Number.NaN))).toBeNull();
  });

  it("refuses STUB_MODE off localhost", async () => {
    const store = new MemoryStore();
    const { deps } = makeDeps(store);
    const res = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store, { STUB_MODE: "1" }), deps);
    expect(res.status).toBe(503);
  });
});

describe("context on the score route", () => {
  it("sends the previous lines labelled as context, with the line to score last", async () => {
    const store = new MemoryStore();
    const cookie = await (async () => {
      const { deps } = makeDeps(store);
      const res = await handle(req("/api/login", { method: "POST", body: JSON.stringify({ passcode: PASSCODE }) }), env(store), deps);
      return res.headers.get("set-cookie")!.split(";")[0]!;
    })();
    const h = makeDeps(store);
    await handle(req("/api/score", { method: "POST", cookie, body: JSON.stringify({ text: "That was the end of that.", context: ["a", "I stopped them from ever having nukes.", "extra ignored? no, last two kept"] }) }), env(store), h.deps);
    const content = (h.calls[0] as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(content).toContain("do not score");
    expect(content.trim().endsWith("Score this line:\nThat was the end of that.")).toBe(true);
    expect(content).not.toContain("- a\n");
  });
});
