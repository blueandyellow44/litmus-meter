import "./styles.css";
import * as api from "./lib/api.ts";
import { CaptureError, getMicStream, getTabStream, startPcm, SAMPLE_RATE, type Capture } from "./lib/audio.ts";
import { BAND_EDGES, bandColor, bandLabel, needleDegrees } from "./lib/bands.ts";
import { openDeepgram, type TranscriptSocket } from "./lib/deepgramSocket.ts";
import { openFakeDeepgram } from "./lib/fakeDeepgram.ts";
import type { Entry } from "./lib/meterStore.ts";
import { Pipeline } from "./lib/pipeline.ts";

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
  list: $<HTMLOListElement>("list"),
  minutes: $("minutes"),
  cost: $("cost"),
  debug: $<HTMLInputElement>("debug"),
};

let session: api.SessionInfo | null = null;
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

function rowHtml(e: Entry): HTMLElement {
  const frag = document.createElement("div");
  frag.className = "row";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = bandColor(e.score!);
  dot.title = bandLabel(e.score!);
  const score = document.createElement("span");
  score.className = "score";
  score.textContent = e.score!.toFixed(1);
  const sentence = document.createElement("p");
  sentence.className = "sentence";
  sentence.textContent = e.text;
  const reason = document.createElement("p");
  reason.className = "reason";
  reason.textContent = e.reason ?? "";
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
  setText(el.showing, store.needleSentence()?.text ?? "");

  const hot = store.hottest();
  if (hot) {
    el.hottest.className = "";
    el.hottest.replaceChildren(rowHtml(hot));
  }

  if (seq !== null) {
    const entry = store.scored().find((e) => e.seq === seq);
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
  r.pipeline.stop();
  r.socket?.close();
  r.capture?.stop();
  r.timers.forEach(clearInterval);
  void sendTick(r);
  el.btnStop.hidden = true;
  el.btnTab.hidden = false;
  el.btnMic.hidden = false;
  el.hint.hidden = true;
  setText(el.interim, "");
}

async function startSession(source: "tab" | "mic"): Promise<void> {
  if (running || budgetReached) return;
  showError(null);
  // Created inside the click so mobile Safari allows audio to run.
  const ctx = session?.stub ? null : new AudioContext();
  const pipeline = new Pipeline(api.scoreSentence, {
    interim: (t) => setText(el.interim, t),
    changed: (seq) => renderAfterScore(pipeline, seq),
    cost: (usd) => {
      if (running) running.sessionCost += usd;
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

// ── passcode gate ────────────────────────────────────────────────────────────
async function showMeter(): Promise<void> {
  session = await api.getSession();
  if (!session) return showGate();
  el.gate.hidden = true;
  el.meter.hidden = false;
  applySpend(session);
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
