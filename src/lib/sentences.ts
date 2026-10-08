// Cuts Deepgram FINAL transcript text into sentences.
//
// A final segment can hold one sentence, several, or the first half of one.
// Each complete sentence is released the moment the final that ends it
// arrives; the unfinished tail waits for the next final. When Deepgram says
// the speaker paused (speech_final or UtteranceEnd) the tail is released as a
// sentence even without closing punctuation, unless it is too short to stand
// alone (see MIN_SENTENCE_WORDS). Interim text never comes here.

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

// A piece shorter than this that ends in a period is probably a speaker still
// mid-thought (Max's first live test, 2026-10-07: median 5 words, 47 of 71
// lines judged fragments). It waits and joins what comes next. Set at 4, not
// higher: a stub run at 5 glued "It is a disgrace." onto an unrelated next
// sentence, and fragments that slip through are now marked no-claim by the
// scorer, so they no longer move the needle. A question or exclamation is
// complete at any length.
export const MIN_SENTENCE_WORDS = 4;

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function isShortStatement(s: string): boolean {
  return wordCount(s) < MIN_SENTENCE_WORDS && !/[?!]["')\]]*$/.test(s.trim());
}

export class SentenceAssembler {
  private tail = "";

  // Feed the text of one is_final result. Returns every sentence it completed.
  addFinal(text: string, speechFinal: boolean): string[] {
    const joined = [this.tail, text.trim()].filter(Boolean).join(" ");
    const { complete, rest } = splitSentences(joined);
    const out: string[] = [];
    let held = "";
    for (const sentence of complete) {
      const candidate = [held, sentence].filter(Boolean).join(" ");
      if (isShortStatement(candidate)) held = candidate;
      else {
        out.push(candidate);
        held = "";
      }
    }
    this.tail = [held, rest].filter(Boolean).join(" ");
    // A short pause (speech_final) releases the tail only when it is long
    // enough to stand on its own; a longer silence (UtteranceEnd) releases all.
    if (speechFinal && this.tail && !isShortStatement(this.tail)) out.push(...this.flush());
    return out;
  }

  // The speaker stopped: whatever is waiting is a sentence now.
  flush(): string[] {
    const t = this.tail.trim();
    this.tail = "";
    return t ? [t] : [];
  }

  get pending(): string {
    return this.tail;
  }
}
