// STUB_MODE fakes for local testing. No network, no real spend.
//
// The fake Anthropic returns a Messages-API-shaped response with realistic
// latency and usage fields, so validation and spend accounting run for real.
// About one sentence in eleven comes back malformed on purpose, to exercise
// the drop path.

import { SCORE_TOOL, VERDICT_TOOL } from "./rubric.ts";
import type { AnthropicResponse, CallAnthropic } from "./score.ts";

export function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const HOT = /\b(disaster|catastroph\w*|destroy\w*|outrage\w*|shameful|radical|chaos|reckless|never|worst|betray\w*|crisis|lies|war on|disgrace\w*)\b/gi;

function fakeScore(text: string): { score: number; reason: string } {
  const hits = text.match(HOT) ?? [];
  const jitter = (hash(text) % 7) / 10;
  const score = Math.min(5, 1.1 + hits.length * 1.3 + jitter);
  const reason = hits.length
    ? `the speaker's own words "${hits.slice(0, 2).join('", "')}" push the listener`
    : "plain statement of what happened, no loaded words";
  return { score: Math.round(score * 10) / 10, reason };
}

const LATENCY_MIN_MS = 600;
const LATENCY_SPREAD_MS = 800;

export function stubAnthropic(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): CallAnthropic {
  return async (body) => {
    const req = body as { tools: Array<{ name: string }>; messages: Array<{ content: string }> };
    const content = String(req.messages[0]?.content ?? "");
    const sentence = content.includes("Score this line:\n") ? content.split("Score this line:\n")[1]! : content;
    const h = hash(sentence);
    if (req.tools[0]?.name === VERDICT_TOOL.name) {
      await sleep(1500);
      const lines = content.split("\n").slice(1);
      const hotWord = new RegExp(HOT.source, "i");
      const hot = lines.filter((l) => hotWord.test(l));
      const heat = Math.min(4.5, 1.5 + hot.length * 0.4);
      const quote = (hot[0] ?? lines[0] ?? "").split(" ").slice(0, 5).join(" ");
      return {
        content: [{
          type: "tool_use",
          name: VERDICT_TOOL.name,
          input: {
            framing: heat, language: heat, sourcing: 2.0, fallacies: hot.length ? 2.5 : 1.5, structure: heat - 0.5,
            loaded_framing: hot.length > 2, emotional_open: false, fallacy_count: hot.length ? 1 : 0,
            one_sided_sourcing: false, advocacy_speech: false,
            why: `The heat came from lines like "${quote}".`,
            summary: `The speaker covered ${lines.length} lines of remarks. The speaker said a spending bill passed and described its funding. The speaker attacked critics and opponents. The speaker closed by handing back to the studio.`,
          },
        }],
        usage: { input_tokens: 2500, output_tokens: 150 },
      };
    }
    await sleep(LATENCY_MIN_MS + (h % LATENCY_SPREAD_MS));
    const usage = { input_tokens: 1180 + (h % 40), output_tokens: 55 + (h % 30) };
    if (h % 11 === 0) {
      return { content: [{ type: "tool_use", name: SCORE_TOOL.name, input: { text: sentence, score: "hot" } }], usage } as AnthropicResponse;
    }
    const { score, reason } = fakeScore(sentence);
    const claim = sentence.split(/\s+/).length >= 4;
    const text = sentence.replace(/Strait of Hormones/i, "Strait of Hormuz");
    // A line that starts lowercase picks up where the last one broke off.
    const continues = /^[a-z]/.test(sentence) && content.includes("Score this line:");
    const marks = sentence.match(new RegExp(HOT.source, "gi")) ?? [];
    return { content: [{ type: "tool_use", name: SCORE_TOOL.name, input: { text, claim, score, reason, continues, marks } }], usage };
  };
}
