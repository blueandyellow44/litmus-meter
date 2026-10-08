// Every /api route goes through handle(). The passcode route is the only one
// reachable without a session cookie; every other path, including unknown
// ones, is refused with 401 before any route code runs.

import { checkPasscode, hasValidSession, issueSessionCookie } from "./auth.ts";
import { DEEPGRAM_TOKEN_TTL_SECONDS, grantDeepgramToken, type DeepgramToken } from "./deepgram.ts";
import { anthropicCostUsd, deepgramCostUsd, DEEPGRAM_USD_PER_MIN, SPEND_CAP_USD, SPEND_WARN_USD } from "./prices.ts";
import { acceptCorrection, buildRequest, MAX_SENTENCE_CHARS, realAnthropic, validateToolOutput, type CallAnthropic } from "./score.ts";
import { ledgerFor, spendState, type SpendLedger, type SpendStore } from "./spend.ts";
import { isLocalHost, stubAnthropic } from "./stub.ts";
import { buildWhyRequest, parseLines, readWhy, summarize, whyQuotesALine } from "./synopsis.ts";

export interface Env {
  METER_KV: SpendStore;
  DEEPGRAM_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  METER_PASSCODE?: string;
  STUB_MODE?: string;
}

export interface Deps {
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
  ledger: SpendLedger;
  anthropic: CallAnthropic;
  deepgramToken: () => Promise<DeepgramToken>;
  log: (event: Record<string, unknown>) => void;
}

// The most audio seconds one listen tick may report. The client ticks every
// 10 s; this bounds what a buggy or hostile client can claim in one call.
export const MAX_TICK_SECONDS = 60;

export const BUDGET_MESSAGE = "Meter budget reached";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function defaultDeps(env: Env, request: Request, waitUntil: (p: Promise<unknown>) => void): Deps {
  const stub = env.STUB_MODE === "1";
  return {
    now: () => Date.now(),
    waitUntil,
    ledger: ledgerFor(env.METER_KV),
    anthropic: stub ? stubAnthropic() : realAnthropic(env.ANTHROPIC_API_KEY ?? ""),
    deepgramToken: stub
      ? async () => ({ access_token: "stub", expires_in: DEEPGRAM_TOKEN_TTL_SECONDS })
      : () => grantDeepgramToken(env.DEEPGRAM_API_KEY ?? ""),
    log: (e) => console.log(JSON.stringify(e)),
  };
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const stub = env.STUB_MODE === "1";

  // Stub mode on a real host would serve fake scores as if they were real.
  if (stub && !isLocalHost(url)) return json({ error: "STUB_MODE is refused off localhost" }, 503);

  try {
    if (path === "/api/login") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const body = await readJson(request);
      if (!checkPasscode(body?.passcode, env.METER_PASSCODE)) {
        return json({ error: "Wrong passcode" }, 401);
      }
      const cookie = await issueSessionCookie(env.METER_PASSCODE!, deps.now(), url.protocol === "https:");
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }

    if (!(await hasValidSession(request.headers.get("cookie"), env.METER_PASSCODE, deps.now()))) {
      return json({ error: "Not signed in" }, 401);
    }

    if (path === "/api/session" && request.method === "GET") {
      return json({
        ok: true,
        stub,
        rates: { deepgram_usd_per_min: DEEPGRAM_USD_PER_MIN, cap_usd: SPEND_CAP_USD, warn_usd: SPEND_WARN_USD },
        ...(await deps.ledger.state()),
      });
    }

    if (path === "/api/spend" && request.method === "GET") {
      return json(await deps.ledger.state());
    }

    if (path === "/api/deepgram-token" && request.method === "POST") {
      const state = await deps.ledger.state();
      if (state.capped) return json({ error: "budget", message: BUDGET_MESSAGE, ...state }, 402);
      const token = await deps.deepgramToken();
      return json({ ...token, stub, ...state });
    }

    if (path === "/api/listen-tick" && request.method === "POST") {
      const body = await readJson(request);
      const raw = Number(body?.seconds);
      const seconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_TICK_SECONDS) : 0;
      const cost = deepgramCostUsd(seconds);
      const before = await deps.ledger.total();
      deps.waitUntil(deps.ledger.charge(cost));
      return json({ cost_usd: cost, ...spendState(before + cost) });
    }

    if (path === "/api/score" && request.method === "POST") {
      const body = await readJson(request);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text === "" || text.length > MAX_SENTENCE_CHARS) return json({ error: "text must be 1-1000 characters" }, 400);

      const before = await deps.ledger.total();
      if (before >= SPEND_CAP_USD) return json({ error: "budget", message: BUDGET_MESSAGE, ...spendState(before) }, 402);

      let response;
      try {
        response = await deps.anthropic(buildRequest(text));
      } catch (err) {
        deps.log({ event: "score_call_failed", text, error: String(err) });
        return json({ error: "scorer unavailable", dropped: true }, 502);
      }
      const cost = anthropicCostUsd(response.usage);
      deps.waitUntil(deps.ledger.charge(cost));
      const after = spendState(before + cost);

      const valid = validateToolOutput(response);
      if (!valid) {
        deps.log({ event: "malformed_score_dropped", text, output: response.content ?? null });
        return json({ error: "malformed model output", dropped: true, cost_usd: cost, ...after }, 422);
      }
      // The sentence shown is the one heard, with at most a proper-noun fix
      // that passes acceptCorrection; never a free rewrite by the model.
      const shown = acceptCorrection(text, valid.text);
      return json({
        text: shown,
        heard: text,
        claim: valid.claim,
        score: valid.score,
        reason: valid.reason,
        cost_usd: cost,
        ...after,
      });
    }

    if (path === "/api/synopsis" && request.method === "POST") {
      const body = await readJson(request);
      const summary = summarize(parseLines(body?.lines));
      if (!summary) return json({ summary: null });

      const before = await deps.ledger.total();
      // Over budget the numbers still show; only the model-written Why is skipped.
      if (before >= SPEND_CAP_USD) return json({ summary, why: null, budget: true, ...spendState(before) });

      const proving = [...summary.hottest, ...summary.calmest];
      let why: string | null = null;
      let cost = 0;
      for (const retry of [false, true]) {
        let response;
        try {
          response = await deps.anthropic(buildWhyRequest(summary, retry));
        } catch (err) {
          deps.log({ event: "why_call_failed", error: String(err) });
          break;
        }
        cost += anthropicCostUsd(response.usage);
        const candidate = readWhy(response);
        if (candidate && whyQuotesALine(candidate, proving)) {
          why = candidate;
          break;
        }
        deps.log({ event: "why_rejected", retry, candidate });
      }
      deps.waitUntil(deps.ledger.charge(cost));
      return json({ summary, why, cost_usd: cost, ...spendState(before + cost) });
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    deps.log({ event: "api_error", path, error: String(err) });
    return json({ error: "server error" }, 500);
  }
}
