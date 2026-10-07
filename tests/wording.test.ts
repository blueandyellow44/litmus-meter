// The scale was renamed on 2026-10-07. The old end labels must not appear in
// anything a viewer sees or the model reads.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCANNED = ["index.html", "src", "server", "public", "functions"];
const BANNED = /hysteric|practical/i;

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
