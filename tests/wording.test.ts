// The scale was renamed on 2026-10-07. The old end labels, and this meter's retired
// first label, must not appear in
// anything a viewer sees or the model reads.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["index.html", "src", "server", "public", "functions"];
// "Proportional" was this meter's first label; Max chose LITMUS's "Proportionate" (2026-10-07).
const BANNED = /hysteric|practical|proportional/i;

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((f) => files(join(path, f)));
}

describe("retired scale words", () => {
  it("appear nowhere in the UI, prompts, or server code", () => {
    const hits = SCANNED.flatMap(files)
      .filter((f) => BANNED.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(ROOT, ""));
    expect(hits).toEqual([]);
  });
});

describe("the rubric never rules on truth (Max, 2026-10-07)", () => {
  it("both prompts forbid calling a claim true or false, and silo relayed speech without quotation marks", async () => {
    const { SYSTEM_PROMPT, VERDICT_PROMPT } = await import("../server/rubric.ts");
    for (const p of [SYSTEM_PROMPT, VERDICT_PROMPT]) {
      expect(p).toContain("NEVER RULE ON TRUTH");
      expect(p).toMatch(/without quotation marks|has no quotation marks/);
    }
  });
});
