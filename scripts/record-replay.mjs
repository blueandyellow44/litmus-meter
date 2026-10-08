// Records real meter scores for a fixed speech, for a static replay page.
// Usage: node scripts/record-replay.mjs <sentences.json> <out.json> [base-url]
//   sentences.json: a JSON array of strings, in speech order.
// Runs against the local meter (default http://127.0.0.1:8796) with real keys,
// exactly as a live listen would: each line scored in order with the previous
// two lines as context, then the whole-speech verdict. Real spend: about
// 3-4 cents for 15 lines. The passcode is read from .dev.vars, never printed.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const allowStub = args.includes("--allow-stub"); // for testing this script only
const [inPath, outPath, base = "http://127.0.0.1:8796"] = args.filter((a) => a !== "--allow-stub");
if (!inPath || !outPath) {
  console.error("usage: node scripts/record-replay.mjs <sentences.json> <out.json> [base-url]");
  process.exit(2);
}

const sentences = JSON.parse(readFileSync(inPath, "utf8"));
if (!Array.isArray(sentences) || !sentences.every((s) => typeof s === "string" && s.trim())) {
  console.error("sentences.json must be a JSON array of non-empty strings");
  process.exit(2);
}
if (sentences.length > 60) {
  console.error(`refusing ${sentences.length} sentences; this script is for short demo speeches (max 60)`);
  process.exit(2);
}

const passcode = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^METER_PASSCODE=(.*)$/m)?.[1]?.trim();
if (!passcode) {
  console.error("METER_PASSCODE not found in .dev.vars");
  process.exit(2);
}

const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
if (!login.ok) {
  console.error(`login failed (${login.status})`);
  process.exit(1);
}
const cookie = login.headers.get("set-cookie").split(";")[0];
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const session = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
if (session.stub && !allowStub) {
  console.error("the meter is in STUB_MODE; these would be fake scores. Refusing.");
  process.exit(1);
}

const lines = [];
let cost = 0;
for (let i = 0; i < sentences.length; i++) {
  const text = sentences[i].trim();
  const context = sentences.slice(Math.max(0, i - 2), i);
  const r = await post("/api/score", { text, context });
  cost += Number(r.body.cost_usd) || 0;
  if (r.status !== 200) {
    console.error(`line ${i + 1}: ${r.status} ${r.body.error ?? ""}`);
    lines.push({ seq: i, heard: text, status: "dropped" });
    continue;
  }
  const b = r.body;
  lines.push({
    seq: i,
    heard: text,
    text: b.text,
    status: b.claim ? "scored" : "noclaim",
    score: b.score,
    reason: b.reason,
    continues: b.continues,
    marks: b.marks,
    devices: b.devices,
    appeal: b.appeal,
  });
  console.log(`${i + 1}/${sentences.length} ${b.claim ? b.score.toFixed(1) : "no claim"}`);
}

const scored = lines.filter((l) => l.status === "scored");
const syn = await post("/api/synopsis", {
  lines: scored.map((l) => ({ seq: l.seq, text: l.text, score: l.score, reason: l.reason })),
  transcript: lines.filter((l) => l.status !== "dropped").map((l) => l.text),
});
cost += Number(syn.body.cost_usd) || 0;

const out = {
  recorded_at: new Date().toISOString(),
  meter_commit: execSync("git rev-parse --short HEAD", { cwd: new URL("..", import.meta.url) }).toString().trim(),
  note: "Real scores from the LITMUS Live meter (claude-haiku-4-5, rubric in server/rubric.ts). The speech is invented.",
  lines,
  report: {
    verdict: syn.body.verdict ?? null,
    style_name: syn.body.style_name ?? null,
    summary: syn.body.summary_text ?? null,
    why: syn.body.why ?? null,
    line_stats: syn.body.summary ?? null,
  },
  cost_usd: Math.round(cost * 10000) / 10000,
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}; verdict ${out.report.verdict ? `${out.report.verdict.band} ${out.report.verdict.score}` : "none"}; cost $${out.cost_usd}`);
