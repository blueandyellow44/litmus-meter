// The speech report (Max, 2026-10-07: round 3 Version 1, filling in live
// the way Version 3 does). One function draws all of it from the store, so
// the live screen and the end-of-listen report are the same picture:
//   - the heat graph: every scored line placed by when it was said and how
//     hot it was, over the bands, with the two hottest labelled at the end;
//   - persuasive style: share of scored lines leaning on each appeal;
//   - rhetorical moves and fallacies: ranked counts from the fixed lists,
//     each with its hottest example line, click to light its moments.
// Every number here is counted in code from the scorer's per-line labels.

import { BANDS } from "../../server/rubric.ts";
import { FALLACY_DEF, MOVE_DEF, type Appeal } from "../../server/labels.ts";
import { bandIndex, bandLabel } from "./bands.ts";
import { writeMarked } from "./dom.ts";
import type { Entry, MeterStore } from "./meterStore.ts";

export interface ReportEls {
  graph: HTMLElement;
  read: HTMLElement;
  appeals: HTMLElement;
  appealKey: HTMLElement;
  moves: HTMLElement;
  fallacies: HTMLElement;
}

// The drawing is 1000 units wide on a desktop; on a phone it is drawn
// 420 wide at the same height, so the graph keeps its height and labels.
const WIDE = 1000;
const NARROW = 420;
const NARROW_BELOW_PX = 560;
const PAD = { l: 34, r: 14, t: 26, b: 26 };
const MIN_SPAN_S = 60; // the graph never squeezes a short listen into a sliver
const SVG_NS = "http://www.w3.org/2000/svg";

const RAMP = ["#C0C9CE", "#B7AE8E", "#C1893C", "#C05A16", "#AD3118"]; // tokens.css ramp
const APPEAL_COLOR: Record<Appeal, string> = { pathos: RAMP[3]!, ethos: RAMP[2]!, logos: RAMP[0]! };
const APPEAL_NAME: Record<Appeal, string> = { pathos: "Pathos, emotion", ethos: "Ethos, trust in the speaker", logos: "Logos, facts" };

function mmss(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export class Report {
  private highlight: string | null = null;
  private ended = false;

  constructor(
    private readonly els: ReportEls,
    private readonly store: () => MeterStore | null,
    private readonly startedAt: () => number,
  ) {}

  reset(): void {
    this.highlight = null;
    this.ended = false;
    this.els.graph.replaceChildren();
    this.els.read.innerHTML = '<span class="label">Hover or tap the graph to read any moment</span>';
    this.els.appeals.replaceChildren();
    this.els.appealKey.replaceChildren();
    this.els.moves.innerHTML = '<p class="def">None yet.</p>';
    this.els.fallacies.innerHTML = '<p class="def">None yet.</p>';
  }

  end(): void {
    this.ended = true;
    this.render();
  }

  render(): void {
    const store = this.store();
    if (!store) return;
    const lines = store.spoken().filter((e) => e.status === "scored");
    this.drawGraph(lines);
    this.drawAppeals(lines);
    this.drawList(this.els.moves, lines, "move", MOVE_DEF);
    this.drawList(this.els.fallacies, lines, "fallacy", FALLACY_DEF);
  }

  private at(e: Entry): number {
    return (e.finalAt - this.startedAt()) / 1000;
  }

  private drawGraph(lines: Entry[]): void {
    const H = 240;
    const W = (this.els.graph.clientWidth || WIDE) < NARROW_BELOW_PX ? NARROW : WIDE;
    const span = Math.max(MIN_SPAN_S, ...lines.map((e) => this.at(e) + 5));
    const x = (s: number) => PAD.l + (s / span) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - 1) / 4) * (H - PAD.t - PAD.b);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "How hot the speech ran over time" });

    BANDS.forEach((b, i) => {
      const lo = b.min, hi = i === BANDS.length - 1 ? 5 : b.below;
      svg.append(el("rect", { x: PAD.l, y: y(hi), width: W - PAD.l - PAD.r, height: y(lo) - y(hi), fill: RAMP[i]!, opacity: 0.14 }));
    });
    for (const v of [1, 2, 3, 4, 5]) {
      const t = el("text", { x: PAD.l - 8, y: y(v) + 4, "font-size": 11, "text-anchor": "end", fill: "#63646A" });
      t.textContent = String(v);
      svg.append(t);
    }
    const stepS = span <= 180 ? 30 : span <= 900 ? 120 : 300;
    for (let s = 0; s <= span; s += stepS) {
      const t = el("text", { x: x(s), y: H - 6, "font-size": 11, "text-anchor": "middle", fill: "#63646A" });
      t.textContent = mmss(s);
      svg.append(t);
    }

    // Sentences cut from one transcript chunk share a timestamp; spread them
    // a few pixels apart so the line steps forward instead of a vertical cliff.
    const MIN_GAP_PX = 10;
    const pts = lines.map((e) => ({ e, px: x(this.at(e)), py: y(e.score!) }));
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]!.px < pts[i - 1]!.px + MIN_GAP_PX) pts[i]!.px = pts[i - 1]!.px + MIN_GAP_PX;
    }
    if (pts.length > 1) {
      let d = `M${pts[0]!.px},${pts[0]!.py}`;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        const cx = (a.px + b.px) / 2;
        d += ` C${cx},${a.py} ${cx},${b.py} ${b.px},${b.py}`;
      }
      svg.append(el("path", { d: `${d} L${pts[pts.length - 1]!.px},${y(1)} L${pts[0]!.px},${y(1)} Z`, fill: "rgba(192,90,22,0.16)" }));
      svg.append(el("path", { d, fill: "none", stroke: "#1E1F22", "stroke-width": 2.5, "stroke-linejoin": "round" }));
    }
    // Dot fills are hex from RAMP: SVG attributes do not read CSS variables.
    for (const p of pts) {
      const on = !!this.highlight && (p.e.devices ?? []).some((d) => d.label === this.highlight);
      svg.append(el("circle", { cx: p.px, cy: p.py, r: on ? 8 : 5, fill: RAMP[bandIndex(p.e.score!)]!, stroke: on ? "#1E1F22" : "#FAF9F7", "stroke-width": on ? 2.5 : 2 }));
    }
    // The two hottest moments carry their words once the speech is over.
    if (this.ended && !this.highlight) {
      const top = [...pts].sort((a, b) => b.e.score! - a.e.score! || a.e.seq - b.e.seq).slice(0, 2);
      top.forEach((p, k) => {
        const words = p.e.marks?.[0] ?? p.e.text.split(" ").slice(0, 4).join(" ");
        const t = el("text", { x: p.px + (k ? 10 : -10), y: Math.max(14, p.py - 12), "font-size": 13, "text-anchor": k ? "start" : "end", fill: "#1E1F22", "font-family": "Newsreader, Georgia, serif" });
        t.textContent = `“${words}” ${p.e.score!.toFixed(1)}`;
        svg.append(t);
      });
    }

    const hit = el("rect", { x: PAD.l, y: 0, width: W - PAD.l - PAD.r, height: H, fill: "transparent" });
    const read = (clientX: number) => {
      if (!pts.length) return;
      const box = svg.getBoundingClientRect();
      const vx = ((clientX - box.left) / box.width) * W;
      const near = pts.reduce((a, b) => (Math.abs(b.px - vx) < Math.abs(a.px - vx) ? b : a));
      this.readout(near.e);
    };
    hit.addEventListener("mousemove", (ev) => read(ev.clientX));
    hit.addEventListener("click", (ev) => read(ev.clientX));
    svg.append(hit);
    this.els.graph.replaceChildren(svg);
  }

  private readout(e: Entry): void {
    const meta = document.createElement("div");
    meta.className = "meta";
    const labels = (e.devices ?? []).map((d) => d.label).join(", ");
    meta.textContent = `${mmss(this.at(e))} · ${e.score!.toFixed(1)} ${bandLabel(e.score!)}${labels ? ` · ${labels}` : ""}`;
    const ln = document.createElement("div");
    ln.className = "ln";
    writeMarked(ln, e.text, e.marks);
    this.els.read.replaceChildren(meta, ln);
  }

  private drawAppeals(lines: Entry[]): void {
    const counted = lines.filter((e) => e.appeal);
    if (!counted.length) {
      this.els.appeals.replaceChildren();
      this.els.appealKey.replaceChildren();
      return;
    }
    const keys: Appeal[] = ["pathos", "ethos", "logos"];
    const share = keys.map((k) => [k, counted.filter((e) => e.appeal === k).length / counted.length] as const);
    this.els.appeals.replaceChildren(
      ...share.filter(([, v]) => v > 0).map(([k, v]) => {
        const d = document.createElement("div");
        d.style.flex = String(v);
        d.style.background = APPEAL_COLOR[k];
        d.textContent = v >= 0.12 ? `${Math.round(v * 100)}%` : "";
        return d;
      }),
    );
    this.els.appealKey.replaceChildren(
      ...share.flatMap(([k, v]) => {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = APPEAL_COLOR[k];
        const name = document.createElement("span");
        name.textContent = APPEAL_NAME[k];
        const pct = document.createElement("b");
        pct.textContent = `${Math.round(v * 100)}%`;
        return [sw, name, pct];
      }),
    );
  }

  private drawList(target: HTMLElement, lines: Entry[], kind: "move" | "fallacy", defs: Record<string, string>): void {
    const counts = new Map<string, Entry[]>();
    for (const e of lines) for (const d of e.devices ?? []) if (d.kind === kind) counts.set(d.label, [...(counts.get(d.label) ?? []), e]);
    const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (!ranked.length) {
      target.innerHTML = '<p class="def">None yet.</p>';
      return;
    }
    const max = ranked[0]![1].length;
    target.replaceChildren(
      ...ranked.map(([label, es]) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `row${this.highlight === label ? " on" : ""}`;
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = label;
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = `×${es.length}`;
        const def = document.createElement("span");
        def.className = "def";
        def.textContent = defs[label] ?? "";
        // The hottest line using it is the example, with its words underlined.
        const ex = [...es].sort((a, b) => b.score! - a.score! || a.seq - b.seq)[0]!;
        const exEl = document.createElement("span");
        exEl.className = "ex";
        writeMarked(exEl, ex.text, ex.marks);
        const bar = document.createElement("span");
        bar.className = `bar${kind === "fallacy" ? " f" : ""}`;
        bar.style.width = `${(es.length / max) * 100}%`;
        row.append(name, count, def, exEl, bar);
        row.addEventListener("click", () => {
          this.highlight = this.highlight === label ? null : label;
          this.render();
        });
        return row;
      }),
    );
  }
}
