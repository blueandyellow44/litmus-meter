import "./styles.css";
import * as api from "./lib/api.ts";
import { CaptureError, getMicStream, getTabStream, startPcm, SAMPLE_RATE, type Capture } from "./lib/audio.ts";
import { BAND_EDGES, bandColor, bandLabel, needleDegrees } from "./lib/bands.ts";
import { openDeepgram, type TranscriptSocket } from "./lib/deepgramSocket.ts";
import { openFakeDeepgram } from "./lib/fakeDeepgram.ts";
import type { Entry } from "./lib/meterStore.ts";
import { Pipeline } from "./lib/pipeline.ts";
import { writeMarked } from "./lib/dom.ts";
import { Report } from "./lib/report.ts";
import * as saved from "./lib/saved.ts";
import type { MeterStore } from "./lib/meterStore.ts";

const TICK_MS = 10_000;
const BYTES_PER_SAMPLE = 2;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  gate: $("gate"),
  gateForm: $<HTMLFormElement>("gate-form"),
  passcode: $<HTMLInputElement>("passcode"),
  gateError: $("gate-error"),
  meter: $("meter"),
  banner: $("budget-banner"),
  btnTab: $<HTMLButtonElement>("btn-tab"),
  btnMic: $<HTMLButtonElement>("btn-mic"),
  btnStop: $<HTMLButtonElement>("btn-stop"),
  hint: $("hint"),
  error: $("error"),
  interim: $("interim"),
  needle: $("needle"),
  gaugeValue: $("gauge-value"),
  showing: $("showing"),
  hottest: $("hottest"),
  synopsis: $("synopsis"),
  synVerdict: $("syn-verdict"),
  synWhy: $("syn-why"),
  synCounts: $("syn-counts"),
  synHot: $<HTMLOListElement>("syn-hot"),
  synCalm: $<HTMLOListElement>("syn-calm"),
  synSummary: $("syn-summary"),
  synAll: $<HTMLOListElement>("syn-all"),
  synAllCount: $("syn-all-count"),
  synAllWrap: $("syn-all-wrap"),
  report: $("report"),
  reportKicker: $("report-kicker"),
  reportTitle: $("report-title"),
  reportSub: $("report-sub"),
  styleName: $("style-name"),
  graph: $("graph"),
  graphRead: $("graph-read"),
  appeals: $("appeals"),
  appealKey: $("appeal-key"),
  moves: $("moves"),
  rescore: $<HTMLButtonElement>("rescore"),
  fallacies: $("fallacies"),
  list: $<HTMLOListElement>("list"),
  minutes: $("minutes"),
  cost: $("cost"),
  debug: $<HTMLInputElement>("debug"),
};

let session: api.SessionInfo | null = null;
// The pipeline whose speech the report is drawing: the live one, or the last
// one after Stop so the report stays up as the recap.
// A finished listen restored from this browser has a store but no pipeline.
interface Speech {
  store: MeterStore;
  startedAt: number;
}
let reportPipeline: Speech | null = null;
const report = new Report(
  { graph: el.graph, read: el.graphRead, appeals: el.appeals, appealKey: el.appealKey, moves: el.moves, fallacies: el.fallacies },
  () => reportPipeline?.store ?? null,
  () => reportPipeline?.startedAt ?? 0,
);
let budgetReached = false;

// ── gauge ────────────────────────────────────────────────────────────────────
function drawArcs(): void {
  const g = document.getElementById("arcs")!;
  const r = 78;
  const point = (s: number) => {
    const theta = Math.PI - ((s - 1) / 4) * Math.PI;
    return `${(100 + r * Math.cos(theta)).toFixed(2)} ${(100 - r * Math.sin(theta)).toFixed(2)}`;
  };
  g.innerHTML = BAND_EDGES.map(
    (b) => `<path d="M ${point(b.from)} A ${r} ${r} 0 0 1 ${point(b.to)}" stroke="${b.color}" />`,
  ).join("");
}

// ── rendering ────────────────────────────────────────────────────────────────
function setText(node: HTMLElement, text: string): void {
  node.textContent = text || " ";
}

function rowHtml(e: { seq: number; text: string; heard?: string; score?: number; reason?: string; marks?: string[]; lagMs?: number; status?: string }): HTMLElement {
  const scored = e.status !== "noclaim" && e.score !== undefined;
  const frag = document.createElement("div");
  frag.className = scored ? "row" : "row noclaim";
  const dot = document.createElement("span");
  dot.className = "dot";
  if (scored) {
    dot.style.background = bandColor(e.score!);
    dot.title = bandLabel(e.score!);
  }
  const score = document.createElement("span");
  score.className = "score";
  score.textContent = scored ? e.score!.toFixed(1) : "\u2013";
  const sentence = document.createElement("p");
  sentence.className = "sentence";
  writeMarked(sentence, e.text, scored ? e.marks : []);
  // A corrected proper noun is shown; what was actually heard stays one hover away.
  if (e.heard && e.heard !== e.text) sentence.title = `Heard as: ${e.heard}`;
  const reason = document.createElement("p");
  reason.className = "reason";
  reason.textContent = scored ? (e.reason ?? "") : "Not scored: no claim to judge.";
  const lag = document.createElement("span");
  lag.className = "lag";
  lag.dataset.seq = String(e.seq);
  lag.hidden = !el.debug.checked;
  lag.textContent = e.lagMs === undefined ? "" : `lag ${Math.round(e.lagMs)} ms`;
  frag.append(dot, score, sentence, reason, lag);
  return frag;
}

const listItems = new Map<number, HTMLLIElement>();

function insertListItem(e: Entry): void {
  const li = document.createElement("li");
  li.dataset.seq = String(e.seq);
  li.append(rowHtml(e));
  // Newest spoken first: place before the first item spoken earlier.
  let before: HTMLLIElement | null = null;
  for (const child of el.list.children) {
    if (Number((child as HTMLElement).dataset.seq) < e.seq) {
      before = child as HTMLLIElement;
      break;
    }
  }
  el.list.insertBefore(li, before);
  listItems.set(e.seq, li);
}

function renderAfterScore(pipeline: Pipeline, seq: number | null): void {
  const store = pipeline.store;
  const value = store.needle();
  if (value !== null) {
    el.needle.classList.remove("idle");
    el.needle.style.transform = `rotate(${needleDegrees(value).toFixed(2)}deg)`;
    el.gaugeValue.textContent = `${value.toFixed(1)} ${bandLabel(value)}`;
  }
  const showing = store.needleSentence();
  writeMarked(el.showing, showing?.text ?? "", showing?.marks);
  if (value !== null && reportPipeline === pipeline && !el.report.dataset.ended) {
    el.reportSub.textContent = `Live needle ${value.toFixed(1)} ${bandLabel(value)}`;
  }
  if (reportPipeline === pipeline) report.render();
  // Saved as it goes, so a reload mid-speech keeps what was heard.
  if (running?.pipeline === pipeline) saved.save(saved.snapshot(store, pipeline.startedAt, performance.now() - pipeline.startedAt, null));

  const hot = store.hottest();
  if (hot) {
    el.hottest.className = "";
    el.hottest.replaceChildren(rowHtml(hot));
  }

  if (seq !== null) {
    const found = store.get(seq);
    const entry = found && (found.status === "scored" || found.status === "noclaim") ? found : null;
    if (entry && !listItems.has(seq)) insertListItem(entry);
    // Lag ends when the DOM carries the score. The paint follows on the next
    // frame (~16 ms) while the page is visible. requestAnimationFrame is not
    // used because Chrome pauses it in a hidden or covered window, which would
    // count the time the window was covered as lag.
    if (entry && entry.lagMs === undefined) {
      const lag = performance.now() - entry.finalAt;
      store.setLag(seq, lag);
      (window as unknown as { __meterLags: number[] }).__meterLags.push(lag);
      document.querySelectorAll<HTMLElement>(`.lag[data-seq="${seq}"]`).forEach((n) => {
        n.textContent = `lag ${Math.round(lag)} ms`;
      });
    }
  }
}
(window as unknown as { __meterLags: number[] }).__meterLags = [];

el.debug.addEventListener("change", () => {
  document.querySelectorAll<HTMLElement>(".lag").forEach((n) => (n.hidden = !el.debug.checked));
});

// Every Listen starts from a clean slate, so one broadcast never mixes into
// the next (Max's live test, 2026-10-07, Deadwood then a speech). This also
// clears listItems, whose keys restart at 0 with each new pipeline.
function resetDisplay(): void {
  el.list.replaceChildren();
  listItems.clear();
  el.hottest.className = "row empty";
  el.hottest.innerHTML = '<p class="sentence">Nothing scored yet.</p>';
  setText(el.showing, "");
  setText(el.interim, "");
  el.needle.classList.add("idle");
  el.needle.style.transform = "";
  el.gaugeValue.textContent = "Waiting for the first sentence";
  el.synopsis.hidden = true;
  report.reset();
  el.report.hidden = false;
  el.rescore.hidden = true;
  delete el.report.dataset.ended;
  el.reportKicker.textContent = "The speech so far";
  el.reportTitle.textContent = "Listening";
  el.synVerdict.textContent = "";
  el.reportSub.textContent = "Waiting for the first scored line";
  el.styleName.textContent = "Named when the speech ends";
  el.synSummary.hidden = true;
  el.synWhy.hidden = true;
  (window as unknown as { __meterLags: number[] }).__meterLags = [];
}

// ── end-of-listen synopsis ───────────────────────────────────────────────────
// Recap lines carry the marks the page already holds for that line.
function proofItem(pipeline: Speech, l: api.SynopsisLine): HTMLLIElement {
  const li = document.createElement("li");
  li.append(rowHtml({ ...l, marks: pipeline.store.get(l.seq)?.marks ?? [], status: "scored" }));
  return li;
}

// Live Stop: finish the pipeline, ask for the report, show it, save it.
async function showSynopsis(pipeline: Pipeline): Promise<void> {
  beginRecap("What you just listened to");
  await pipeline.finish();
  const durationMs = performance.now() - pipeline.startedAt;
  const result = await fetchReport(pipeline);
  renderRecap(pipeline, result, durationMs);
  saved.save(saved.snapshot(pipeline.store, pipeline.startedAt, durationMs, result));
}

function beginRecap(kicker: string): void {
  el.synopsis.hidden = false;
  el.report.dataset.ended = "1";
  el.reportKicker.textContent = kicker;
  el.reportTitle.textContent = "Adding it up\u2026";
  el.reportSub.textContent = "";
  el.synVerdict.textContent = "";
  el.synSummary.textContent = "";
  el.synSummary.hidden = true;
  el.synAllWrap.hidden = true;
  el.synWhy.textContent = "";
  el.synCounts.textContent = "";
  el.synHot.replaceChildren();
  el.synCalm.replaceChildren();
  el.rescore.hidden = true;
}

async function fetchReport(pipeline: Speech): Promise<api.Synopsis | null> {
  const lines = pipeline.store
    .scored()
    .reverse()
    .map((e) => ({ seq: e.seq, text: e.text, score: e.score!, reason: e.reason ?? "" }));
  let result: api.Synopsis;
  // One retry: a dropped connection (venue wifi, or the local dev proxy, seen
  // 2026-10-07) should not cost the listener the verdict.
  try {
    result = await api.synopsis(lines, pipeline.store.transcript());
  } catch (first) {
    console.warn("synopsis failed, retrying once", first);
    try {
      result = await api.synopsis(lines, pipeline.store.transcript());
    } catch (err) {
      console.warn(err);
      return null;
    }
  }
  return result;
}

function renderRecap(pipeline: Speech, result: api.Synopsis | null, durationMs: number, scroll = true): void {
  el.rescore.hidden = false;
  if (!result) {
    el.reportTitle.textContent = "The summary could not be made.";
    report.end();
    return;
  }
  const s = result.summary;
  if (!s) {
    el.reportTitle.textContent = "Not enough was said to judge.";
    el.synWhy.textContent = "Fewer than three lines made a claim.";
    el.synWhy.hidden = false;
    report.end();
    return;
  }
  // What was said, before any verdict, as the site's facts panel comes first.
  el.synSummary.textContent = result.summary_text ?? "";
  el.synSummary.hidden = !result.summary_text;
  const v = result.verdict;
  // Two numbers, roles named: the whole speech scored the site's way leads;
  // the plain line average follows so the listener can weigh both.
  el.synVerdict.textContent = v ? `${v.band} ${v.score.toFixed(1)}` : `${s.band} ${s.score.toFixed(1)}`;
  el.reportSub.textContent = v ? "Whole speech, scored the LITMUS way" : "Line average; the whole-speech score could not be made";
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  el.reportTitle.textContent = `${minutes} minute${minutes === 1 ? "" : "s"}, ${s.lines} scored lines`;
  el.styleName.textContent = result.style_name ?? "No style name this time";
  // Retry-then-none, as on the site: no Why line beats a Why that cites nothing.
  el.synWhy.textContent = result.why ?? "";
  el.synWhy.hidden = !result.why;
  const counts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([band, n]) => `${n} ${band}`)
    .join(", ");
  const raised = v && v.raised.length ? ` Raised for ${v.raised.join("; ")}.` : "";
  el.synCounts.textContent = v
    ? `Whole speech scored the LITMUS way.${raised} Line by line it averaged ${s.score.toFixed(1)} over ${s.lines} scored lines: ${counts}.`
    : `The whole-speech score could not be made, so this is the average of ${s.lines} scored lines: ${counts}.`;
  el.synHot.replaceChildren(...s.hottest.map((l) => proofItem(pipeline, l)));
  el.synCalm.replaceChildren(...s.calmest.map((l) => proofItem(pipeline, l)));
  // The whole speech, hyperbolic words underlined, one line per row.
  const spoken = pipeline.store.spoken().filter((e) => e.status === "scored" || e.status === "noclaim");
  el.synAllCount.textContent = `Read the whole speech, ${spoken.length} lines, hyperbolic words underlined`;
  el.synAll.replaceChildren(
    ...spoken.map((e) => {
      const li = document.createElement("li");
      li.append(rowHtml(e));
      return li;
    }),
  );
  el.synAllWrap.hidden = spoken.length === 0;
  report.end();
  if (scroll) el.report.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── messages ─────────────────────────────────────────────────────────────────
function showError(msg: string | null): void {
  el.error.hidden = !msg;
  el.error.textContent = msg ?? "";
}

function showBudget(): void {
  budgetReached = true;
  el.banner.hidden = false;
  el.banner.textContent = "Meter budget reached";
  el.btnTab.disabled = true;
  el.btnMic.disabled = true;
}

function showWarn(): void {
  if (budgetReached) return;
  el.banner.hidden = false;
  el.banner.textContent = `Budget warning: more than $${session?.rates.warn_usd ?? 40} of the $${session?.rates.cap_usd ?? 50} meter budget is spent.`;
}

function applySpend(s: api.SpendFields): void {
  if (s.capped) showBudget();
  else if (s.warn) showWarn();
}

// ── a listening session ──────────────────────────────────────────────────────
interface Running {
  pipeline: Pipeline;
  socket: TranscriptSocket | null;
  capture: Capture | null;
  timers: ReturnType<typeof setInterval>[];
  audioSeconds: number;
  untickedSeconds: number;
  sessionCost: number;
  stubStartedAt: number | null;
}

let running: Running | null = null;

function updateReadout(r: Running): void {
  const rate = session?.rates.deepgram_usd_per_min ?? 0;
  const cost = (r.audioSeconds / 60) * rate + r.sessionCost;
  el.minutes.textContent = `${(r.audioSeconds / 60).toFixed(1)} min listened`;
  el.cost.textContent = `$${cost.toFixed(3)} this session`;
}

async function sendTick(r: Running): Promise<void> {
  const seconds = r.untickedSeconds;
  if (seconds <= 0) return;
  r.untickedSeconds = 0;
  try {
    applySpend(await api.listenTick(seconds));
    if (budgetReached) stopSession();
  } catch (err) {
    r.untickedSeconds += seconds; // retry with the next tick
    console.warn(err);
  }
}

function stopSession(): void {
  const r = running;
  if (!r) return;
  running = null;
  r.socket?.close();
  r.capture?.stop();
  r.timers.forEach(clearInterval);
  void sendTick(r);
  el.btnStop.hidden = true;
  el.btnTab.hidden = false;
  el.btnMic.hidden = false;
  el.hint.hidden = true;
  setText(el.interim, "");
  void showSynopsis(r.pipeline);
}

async function startSession(source: "tab" | "mic"): Promise<void> {
  if (running || budgetReached) return;
  showError(null);
  resetDisplay();
  // Created inside the click so mobile Safari allows audio to run.
  const ctx = session?.stub ? null : new AudioContext();
  const pipeline: Pipeline = new Pipeline(api.scoreSentence, {
    interim: (t) => setText(el.interim, t),
    changed: (seq, mergedSeq) => {
      // The folded-in line leaves the list; the merged line takes its place.
      if (mergedSeq !== undefined) {
        listItems.get(mergedSeq)?.remove();
        listItems.delete(mergedSeq);
      }
      renderAfterScore(pipeline, seq);
    },
    // Charged to this listen even when the answer lands after Stop.
    cost: (usd) => {
      r.sessionCost += usd;
      updateReadout(r);
    },
    warn: showWarn,
    budget: () => {
      showBudget();
      stopSession();
    },
  });
  const r: Running = {
    pipeline,
    socket: null,
    capture: null,
    timers: [],
    audioSeconds: 0,
    untickedSeconds: 0,
    sessionCost: 0,
    stubStartedAt: null,
  };
  running = r;
  reportPipeline = pipeline;
  el.btnTab.hidden = true;
  el.btnMic.hidden = true;
  el.btnStop.hidden = false;
  el.hint.hidden = source !== "tab" || !!session?.stub;

  try {
    if (session?.stub) {
      const token = await api.deepgramToken();
      applySpend(token);
      r.stubStartedAt = performance.now();
      r.socket = openFakeDeepgram((m) => pipeline.handleMessage(m), () => stopSession());
      r.timers.push(
        setInterval(() => {
          const elapsed = (performance.now() - r.stubStartedAt!) / 1000;
          r.untickedSeconds += elapsed - r.audioSeconds;
          r.audioSeconds = elapsed;
          updateReadout(r);
        }, 250),
      );
    } else {
      const stream = source === "tab" ? await getTabStream() : await getMicStream();
      if (running !== r) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      el.hint.hidden = true;
      const token = await api.deepgramToken();
      applySpend(token);
      r.socket = await openDeepgram(
        token.access_token,
        (m) => pipeline.handleMessage(m),
        (reason) => {
          showError(reason);
          stopSession();
        },
      );
      if (running !== r) {
        r.socket.close();
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      r.capture = await startPcm(
        ctx!,
        stream,
        (pcm) => {
          r.socket?.send(pcm);
          const secs = pcm.byteLength / BYTES_PER_SAMPLE / SAMPLE_RATE;
          r.audioSeconds += secs;
          r.untickedSeconds += secs;
        },
        () => stopSession(),
      );
      r.timers.push(setInterval(() => updateReadout(r), 500));
    }
    r.timers.push(setInterval(() => void sendTick(r), TICK_MS));
  } catch (err) {
    void ctx?.close();
    if (err instanceof api.BudgetReached) showBudget();
    else showError(err instanceof CaptureError || err instanceof Error ? err.message : String(err));
    stopSession();
  }
}

el.btnTab.addEventListener("click", () => void startSession("tab"));
el.btnMic.addEventListener("click", () => void startSession("mic"));
el.btnStop.addEventListener("click", () => stopSession());

// ── the last listen, kept in this browser ───────────────────────────────────
function showSaved(listen: saved.SavedListen): void {
  const store = saved.restore(listen);
  const speech: Speech = { store, startedAt: 0 };
  reportPipeline = speech;
  report.reset();
  el.report.hidden = false;
  beginRecap(`Your last listen, saved ${new Date(listen.savedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  if (listen.result) renderRecap(speech, listen.result, listen.durationMs, false);
  else {
    el.reportTitle.textContent = "Interrupted before the end";
    el.rescore.hidden = false;
    report.end();
  }
}

// Re-scores every saved line in order, with the same context the live meter
// sends, at the original timing, then remakes the end report. Real calls:
// about two cents a minute of speech.
async function rescoreSaved(): Promise<void> {
  const listen = saved.load();
  if (!listen || running || budgetReached) return;
  el.rescore.disabled = true;
  el.rescore.textContent = "Re-scoring\u2026";
  let clock = 0;
  const pipeline: Pipeline = new Pipeline(api.scoreSentence, {
    interim: () => {},
    changed: () => report.render(),
    cost: () => {},
    warn: showWarn,
    budget: () => showBudget(),
  }, () => clock);
  reportPipeline = pipeline;
  report.reset();
  beginRecap("Re-scored with the current meter");
  for (const e of [...listen.entries].sort((a, b) => a.seq - b.seq)) {
    clock = e.tMs;
    pipeline.handleMessage({ type: "Results", is_final: true, speech_final: true, channel: { alternatives: [{ transcript: e.heard }] } });
    pipeline.handleMessage({ type: "UtteranceEnd" });
  }
  await pipeline.finish();
  const result = await fetchReport(pipeline);
  renderRecap(pipeline, result, listen.durationMs);
  saved.save(saved.snapshot(pipeline.store, 0, listen.durationMs, result));
  el.rescore.disabled = false;
  el.rescore.textContent = "Re-score this speech";
}

el.rescore.addEventListener("click", () => void rescoreSaved());

// ── passcode gate ────────────────────────────────────────────────────────────
async function showMeter(): Promise<void> {
  session = await api.getSession();
  if (!session) return showGate();
  el.gate.hidden = true;
  el.meter.hidden = false;
  applySpend(session);
  const last = saved.load();
  if (last && last.entries.length > 0 && !running) showSaved(last);
}

function showGate(): void {
  el.meter.hidden = true;
  el.gate.hidden = false;
  el.passcode.focus();
}

el.gateForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  el.gateError.hidden = true;
  if (await api.login(el.passcode.value)) {
    el.passcode.value = "";
    await showMeter();
  } else {
    el.gateError.hidden = false;
    el.gateError.textContent = "That passcode did not work.";
  }
});

drawArcs();
el.needle.classList.add("idle");
showMeter().catch((err) => {
  showGate();
  el.gateError.hidden = false;
  el.gateError.textContent = String(err);
});
