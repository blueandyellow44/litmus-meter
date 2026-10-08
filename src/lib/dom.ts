// Writes `text` into `node` with each mark in the site's loaded highlight.
// Built from text nodes, never innerHTML, so a transcript cannot inject markup.
export function writeMarked(node: HTMLElement, text: string, marks: string[] = []): void {
  node.replaceChildren();
  const lower = text.toLowerCase();
  const spans = marks
    .map((m) => [lower.indexOf(m.toLowerCase()), m.length] as const)
    .filter(([at]) => at >= 0)
    .sort((a, b) => a[0] - b[0]);
  let i = 0;
  for (const [at, len] of spans) {
    if (at < i) continue; // overlapping marks were refused upstream; skip defensively
    if (at > i) node.append(text.slice(i, at));
    const mark = document.createElement("mark");
    mark.className = "hl-loaded";
    mark.textContent = text.slice(at, at + len);
    node.append(mark);
    i = at + len;
  }
  if (i < text.length) node.append(text.slice(i));
  if (!text) node.textContent = "\u00a0";
}

