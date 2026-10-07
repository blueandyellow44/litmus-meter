// Running spend total in Cloudflare KV, key spend_total_usd.
//
// Two KV facts shape this file (https://developers.cloudflare.com/kv/api/write-key-value-pairs/):
//   - KV allows at most one write per second to a key; a second write throws 429.
//   - KV has no atomic increment, so concurrent read-add-write cycles can lose
//     one another's charge.
// So charges are not written one by one. Each isolate keeps a pending amount
// and flushes it in ONE write a short window later; every charge that lands
// inside the window rides the same write. The cap check counts the pending
// amount too, so a charge waiting to be written still counts against $50.
// Residual risk, stated in the README: two isolates flushing in the same
// instant can still lose one flush. With one listener that is rare and costs
// cents.

import { SPEND_CAP_USD, SPEND_WARN_USD } from "./prices.ts";

export const SPEND_KEY = "spend_total_usd";
export const FLUSH_WINDOW_MS = 1500;
const WRITE_RETRIES = 4;

export interface SpendStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface SpendState {
  total_usd: number;
  warn: boolean;
  capped: boolean;
}

export function spendState(total: number): SpendState {
  return { total_usd: total, warn: total >= SPEND_WARN_USD, capped: total >= SPEND_CAP_USD };
}

export async function readStored(store: SpendStore): Promise<number> {
  const raw = await store.get(SPEND_KEY);
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    // A corrupt total must never read as $0 and re-open a spent budget.
    throw new Error(`spend_total_usd is not a valid amount: ${JSON.stringify(raw)}`);
  }
  return n;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SpendLedger {
  private pending = 0;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly store: SpendStore,
    private readonly sleep: Sleep = realSleep,
  ) {}

  // Stored total plus whatever this isolate has charged but not yet written.
  async total(): Promise<number> {
    return (await readStored(this.store)) + this.pending;
  }

  async state(): Promise<SpendState> {
    return spendState(await this.total());
  }

  // Records a charge. Returns the flush promise; the caller hands it to
  // ctx.waitUntil so the write finishes after the response has gone out.
  charge(amountUsd: number): Promise<void> {
    if (Number.isFinite(amountUsd) && amountUsd > 0) this.pending += amountUsd;
    if (!this.flushing) {
      this.flushing = this.flushAfterWindow().finally(() => {
        this.flushing = null;
        // A charge that arrived during the write gets its own flush.
        if (this.pending > 0) void this.charge(0);
      });
    }
    return this.flushing;
  }

  private async flushAfterWindow(): Promise<void> {
    await this.sleep(FLUSH_WINDOW_MS);
    const amount = this.pending;
    if (amount <= 0) return;
    for (let attempt = 0; ; attempt++) {
      try {
        const next = (await readStored(this.store)) + amount;
        await this.store.put(SPEND_KEY, next.toFixed(6));
        this.pending -= amount;
        return;
      } catch (err) {
        if (attempt >= WRITE_RETRIES) {
          // Leave the amount pending so the cap check keeps counting it and
          // the next charge retries the write.
          console.error(JSON.stringify({ event: "spend_write_failed", amount, error: String(err) }));
          return;
        }
        await this.sleep(1100 * (attempt + 1));
      }
    }
  }
}

// One ledger per isolate per store, so charges from concurrent requests in the
// same isolate share a flush.
const ledgers = new WeakMap<object, SpendLedger>();
export function ledgerFor(store: SpendStore): SpendLedger {
  let l = ledgers.get(store);
  if (!l) {
    l = new SpendLedger(store);
    ledgers.set(store, l);
  }
  return l;
}
