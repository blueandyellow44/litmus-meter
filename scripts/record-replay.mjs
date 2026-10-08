// Records real meter scores for a fixed speech, for a static replay page.
// Usage: node scripts/record-replay.mjs <sentences.json> <out.json> [base-url]
//   sentences.json: a JSON array of strings in speech order, or a debates file
//   ({ debates: [{ id, speakers: [{ id, name, sentences }] }] }).
// Runs against the local meter (default http://127.0.0.1:8796) with real keys,
// exactly as a live listen would: each line scored in order with the previous
// two lines as context, then the whole-speech verdict. Real spend: about
// 3-4 cents for 15 lines. The passcode is read from .dev.vars, never printed.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const allowStub = args.includes("--allow-stub"); // for testing this script only
// --verdicts-from <scores.json>: keep the recorded lines, redo only the
// whole-speech verdicts (one call per speaker instead of one per line).
const vfIndex = args.indexOf("--verdicts-from");
const verdictsFrom = vfIndex >= 0 ? args[vfIndex + 1] : null;
if (vfIndex >= 0) args.splice(vfIndex, 2);
const [inPath, outPath, base = "http://127.0.0.1:8796"] = args.filter((a) => a !== "--allow-stub");
if (!inPath || !outPath) {
  console.error("usage: node scripts/record-replay.mjs <sentences.json> <out.json> [base-url]");
  process.exit(2);
}

// Input: a plain array of sentences (one speech), or a debates file
// { debates: [{ id, speakers: [{ id, name, sentences: [] }] }] }. Each speaker
// is scored on their own: context never crosses from one speaker to another.
const input = JSON.parse(readFileSync(inPath, "utf8"));
const speeches = Array.isArray(input)
  ? [{ id: "speech", name: null, debate: null, sentences: input }]
  : (input.debates ?? []).flatMap((d) => (d.speakers ?? []).map((sp) => ({ id: sp.id, name: sp.name ?? null, debate: d.id ?? null, sentences: sp.sentences })));
const MAX_LINES = 150;
const total = speeches.reduce((n, sp) => n + (Array.isArray(sp.sentences) ? sp.sentences.length : 0), 0);
for (const sp of speeches) {
  if (!sp.id || !Array.isArray(sp.sentences) || !sp.sentences.every((x) => typeof x === "string" && x.trim())) {
    console.error(`speech ${sp.id ?? "?"}: sentences must be a non-empty array of strings`);
    process.exit(2);
  }
}
if (total === 0 || total > MAX_LINES) {
  console.error(`refusing ${total} lines; this script is for demo excerpts (1-${MAX_LINES})`);
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

let cost = 0;
async function scoreSpeech(sentences, recorded = null) {
  const lines = recorded ? recorded.lines : [];
  for (let i = 0; !recorded && i < sentences.length; i++) {
    const text = sentences[i].trim();
    const context = sentences.slice(Math.max(0, i - 2), i);
    const r = await post("/api/score", { text, context });
    cost += Number(r.body.cost_usd) || 0;
    if (r.status !== 200) {
      console.error(`  line ${i + 1}: ${r.status} ${r.body.error ?? ""}`);
      lines.push({ seq: i, heard: text, status: "dropped" });
      if (r.status === 402) throw new Error("meter budget reached");
      continue;
    }
    const b = r.body;
    lines.push({ seq: i, heard: text, text: b.text, status: b.claim ? "scored" : "noclaim", score: b.score, reason: b.reason, continues: b.continues, marks: b.marks, devices: b.devices, appeal: b.appeal });
    console.log(`  ${i + 1}/${sentences.length} ${b.claim ? b.score.toFixed(1) : "no claim"}`);
  }
  const scored = lines.filter((l) => l.status === "scored");
  const syn = await post("/api/synopsis", {
    lines: scored.map((l) => ({ seq: l.seq, text: l.text, score: l.score, reason: l.reason })),
    transcript: lines.filter((l) => l.status !== "dropped").map((l) => l.text),
  });
  cost += Number(syn.body.cost_usd) || 0;
  return {
    lines,
    report: {
      verdict: syn.body.verdict ?? null,
      style_name: syn.body.style_name ?? null,
      summary: syn.body.summary_text ?? null,
      why: syn.body.why ?? null,
      line_stats: syn.body.summary ?? null,
    },
  };
}

const previous = verdictsFrom ? JSON.parse(readFileSync(verdictsFrom, "utf8")) : null;
const results = {};
for (const sp of speeches) {
  console.log(`${sp.id} (${sp.sentences.length} lines${previous ? ", verdict only" : ""})`);
  const recorded = previous?.speeches?.[sp.id] ?? null;
  if (previous && !recorded) throw new Error(`${sp.id} is missing from ${verdictsFrom}`);
  results[sp.id] = { name: sp.name, debate: sp.debate, ...(await scoreSpeech(sp.sentences, recorded)) };
  const v = results[sp.id].report.verdict;
  console.log(`  verdict ${v ? `${v.band} ${v.score}` : "none"}`);
}

const git = (args) => execSync(`git ${args}`, { cwd: new URL("..", import.meta.url) }).toString().trim();
const out = {
  recorded_at: new Date().toISOString(),
  meter_commit: git("rev-parse --short HEAD"),
  rubric_version: git("log -1 --format=%h -- server/rubric.ts server/labels.ts server/verdict.ts"),
  model: "claude-haiku-4-5",
  note: "Automated readings by the LITMUS Live meter: each line scored on its own with up to two earlier lines from the same speaker as context; the verdict is the whole excerpt scored with the LITMUS site's composite. Not a verdict on any person.",
  speeches: results,
  cost_usd: 0,
};
out.cost_usd = Math.round((cost + (previous?.cost_usd ?? 0)) * 10000) / 10000;
if (previous) out.lines_recorded_at = previous.recorded_at;
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`wrote ${outPath}; ${Object.keys(results).length} speeches; cost $${out.cost_usd}`);
