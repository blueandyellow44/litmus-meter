// Cuts Deepgram FINAL transcript text into sentences.
//
// A final segment can hold one sentence, several, or the first half of one.
// Each complete sentence is released the moment the final that ends it
// arrives; the unfinished tail waits for the next final. When Deepgram says
// the speaker paused (speech_final or UtteranceEnd) the tail is released as a
// sentence even without closing punctuation. Interim text never comes here.

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "gov", "sen", "rep", "gen",
  "col", "lt", "sgt", "prof", "inc", "co", "corp", "ltd", "no", "etc", "approx",
]);

// True when the "." at the end of `word` closes a sentence rather than an
// abbreviation (Dr.), an initialism (U.S.) or an initial (J.).
function endsSentence(word: string): boolean {
  if (/[?!]["')\]]*$/.test(word)) return true;
  if (!/\.["')\]]*$/.test(word)) return false;
  const bare = word.replace(/["')\]]+$/, "").replace(/\.$/, "");
  if (ABBREVIATIONS.has(bare.toLowerCase())) return false;
  if (/^([A-Za-z]\.)*[A-Za-z]$/.test(bare)) return false; // U.S / J / a.m
  return true;
}

export function splitSentences(text: string): { complete: string[]; rest: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const complete: string[] = [];
  let current: string[] = [];
  for (const w of words) {
    current.push(w);
    if (endsSentence(w)) {
      complete.push(current.join(" "));
      current = [];
    }
  }
  return { complete, rest: current.join(" ") };
}

export class SentenceAssembler {
  private tail = "";

  // Feed the text of one is_final result. Returns every sentence it completed.
  addFinal(text: string, speechFinal: boolean): string[] {
    const joined = [this.tail, text.trim()].filter(Boolean).join(" ");
    const { complete, rest } = splitSentences(joined);
    this.tail = rest;
    if (speechFinal) complete.push(...this.flush());
    return complete;
  }

  // The speaker paused: whatever is waiting is a sentence now.
  flush(): string[] {
    const t = this.tail.trim();
    this.tail = "";
    return t ? [t] : [];
  }

  get pending(): string {
    return this.tail;
  }
}
