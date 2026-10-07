// STUB_MODE only: plays a scripted broadcast as Deepgram-shaped messages,
// word by word as interims, then the segment as a final, so the real
// pipeline, assembler and screen run exactly as they would live.

import type { TranscriptSocket } from "./deepgramSocket.ts";

// Each entry is one Deepgram final segment. Some end mid-sentence, one holds
// two sentences, and `pause` marks where the speaker stops (speech_final).
const SCRIPT: Array<{ text: string; pause: boolean }> = [
  { text: "Good evening, I'm reporting from the Capitol.", pause: true },
  { text: "The Senate passed the spending bill tonight by a vote of 52 to 48.", pause: true },
  { text: "The bill funds the government through March", pause: false },
  { text: "and adds four billion dollars for disaster relief.", pause: true },
  { text: "Critics are calling it a reckless disaster that will destroy the budget.", pause: true },
  { text: "Senator Hale said, quote, this is a catastrophe for working families.", pause: true },
  { text: "Let's be honest, this is the worst betrayal of voters we have ever seen. It is a disgrace.", pause: true },
  { text: "The House is expected to take up the measure on Thursday.", pause: true },
  { text: "Markets closed slightly higher, with the Dow up 0.4 percent.", pause: true },
  { text: "This radical agenda is pure chaos and it will never work.", pause: true },
  { text: "Officials said the relief money will reach the Gulf Coast within thirty days.", pause: true },
  { text: "Back to you in the studio.", pause: true },
];

const WORD_MS = 230;
const FINAL_AFTER_MS = 350;
const GAP_MS = 700;

function results(transcript: string, isFinal: boolean, speechFinal: boolean) {
  return {
    type: "Results",
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript }] },
  };
}

export function openFakeDeepgram(onMessage: (msg: unknown) => void, onDone: () => void): TranscriptSocket {
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let t = 500;
  const at = (ms: number, fn: () => void) => timers.push(setTimeout(() => !cancelled && fn(), ms));

  for (const seg of SCRIPT) {
    const words = seg.text.split(" ");
    for (let i = 1; i <= words.length; i++) {
      const partial = words.slice(0, i).join(" ").replace(/[.,]$/, "");
      at(t, () => onMessage(results(partial, false, false)));
      t += WORD_MS;
    }
    t += FINAL_AFTER_MS;
    at(t, () => onMessage(results(seg.text, true, seg.pause)));
    if (seg.pause) at(t + 1000, () => onMessage({ type: "UtteranceEnd" }));
    t += seg.pause ? GAP_MS : 0;
  }
  at(t + 2500, onDone);

  return {
    send() {},
    close() {
      cancelled = true;
      timers.forEach(clearTimeout);
    },
  };
}
