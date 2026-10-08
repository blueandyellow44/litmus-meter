// Hyperbolic-word marks (Max, 2026-10-07: "i do want the hyperbolic text
// underlined live and in the recap"). Shared by the server, which checks each
// line, and the page, which re-checks marks against a merged thought.

export const MAX_MARKS = 3;
const MAX_MARK_WORDS = 8;

// Ranges of the line that sit inside quotation marks: words the speaker
// attributes to someone else, which are never marked (the site's quote silo).
// Speech has no quotation marks, so a spoken "quote" also opens a quoted
// stretch, closed by "unquote" / "end quote" or the end of the line
// ("Senator Hale said, quote, this is a catastrophe", stub run 2026-10-07).
function quotedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const printed = /["\u201c]([^"\u201d]*)["\u201d]/g;
  let m: RegExpExecArray | null;
  while ((m = printed.exec(text))) out.push([m.index, m.index + m[0].length]);
  const spoken = /\bquote\b[,:]?/gi;
  while ((m = spoken.exec(text))) {
    const start = m.index;
    if (/\b(un|end )$/i.test(text.slice(Math.max(0, start - 4), start))) continue; // "unquote" / "end quote" closes, never opens
    const close = /\b(unquote|end quote)\b/i.exec(text.slice(m.index + m[0].length));
    const end = close ? m.index + m[0].length + close.index : text.length;
    out.push([start, end]);
  }
  return out;
}

// Keeps only marks that are verbatim text of the shown line (any case),
// short, outside quotation marks and not overlapping one another; returns
// them in the line's own spelling. A mark the model invented never shows.
export function validateMarks(line: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const lower = line.toLowerCase();
  const quoted = quotedRanges(line);
  const taken: Array<[number, number]> = [];
  const out: string[] = [];
  for (const m of raw) {
    if (out.length >= MAX_MARKS) break;
    if (typeof m !== "string") continue;
    const mark = m.trim();
    if (!mark || mark.split(/\s+/).length > MAX_MARK_WORDS) continue;
    const at = lower.indexOf(mark.toLowerCase());
    if (at === -1) continue;
    const span: [number, number] = [at, at + mark.length];
    const overlaps = (r: [number, number]) => span[0] < r[1] && r[0] < span[1];
    if (quoted.some(overlaps) || taken.some(overlaps)) continue;
    taken.push(span);
    out.push(line.slice(span[0], span[1]));
  }
  return out;
}

