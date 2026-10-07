// Score -> band and ramp colour, using the rubric's own band table so the
// screen cannot drift from what the scorer was told.

import { BANDS } from "../../server/rubric.ts";

const RAMP = ["--ph-proportional", "--ph-grounded", "--ph-mixed", "--ph-hot", "--ph-hyperbolic"] as const;

export function bandIndex(score: number): number {
  const s = Math.max(1, Math.min(5, score));
  const i = BANDS.findIndex((b) => s < b.below);
  return i === -1 ? BANDS.length - 1 : i;
}

export function bandColor(score: number): string {
  return `var(${RAMP[bandIndex(score)]})`;
}

export function bandLabel(score: number): string {
  return BANDS[bandIndex(score)]!.label;
}

export const BAND_EDGES = BANDS.map((b, i) => ({ from: b.min, to: Math.min(b.below, 5), color: `var(${RAMP[i]})` }));

// Needle rotation in degrees: -90 points at 1.0 (left), +90 at 5.0 (right).
export function needleDegrees(score: number): number {
  const s = Math.max(1, Math.min(5, score));
  return -90 + ((s - 1) / 4) * 180;
}
