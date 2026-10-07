# LITMUS Live (meter v1)

A standalone page that listens to broadcast audio (a Chrome tab or a microphone) and moves a needle on the LITMUS P/H scale, Proportionate to Hyperbolic, one sentence at a time. Separate from the LITMUS site and repo.

## How it works

1. Passcode screen. `POST /api/login` checks `METER_PASSCODE` and sets an HttpOnly, 12-hour session cookie. Every other `/api` route returns 401 without it.
2. The browser captures audio, turns it into 16 kHz PCM (`public/pcm-worklet.js`) and streams it to Deepgram over a WebSocket opened with a 30-second JWT from `POST /api/deepgram-token`. The Deepgram key never reaches the browser.
3. Interim transcripts fill the "Speaker now" line and are never scored. Each sentence completed by a FINAL transcript is sent on its own to `POST /api/score`, which asks `claude-haiku-4-5` for `{ text, score, reason }` through a forced tool call. Requests run in parallel; answers are placed by sentence order.
4. The needle shows the average of the two latest-spoken scored sentences, with a 600 ms transition.

The rubric is in `server/rubric.ts`; its header names the LITMUS source file and commit.

## Prices (checked 2026-10-07)

| Item | Rate | Source |
|---|---|---|
| Deepgram Nova-3 English streaming, Pay As You Go | **$0.0077/min regular**; $0.0048/min "limited-time promotional" current price, no end date stated | https://deepgram.com/pricing |
| Claude Haiku 4.5 | $1 / MTok input, $5 / MTok output | https://platform.claude.com/docs/en/about-claude/pricing |

The spend cap charges Deepgram at the regular $0.0077/min, so it over-counts while the promotion lasts rather than under-counting when it ends. Rates live in `server/prices.ts`.

Estimated cost per hour of listening: about **$1.50** (range $1.30 to $2.00).
- Deepgram: 60 min x $0.0077 = $0.46.
- Scoring: about 1,300 input tokens per sentence (system prompt and tool schema about 700, Anthropic's forced-tool overhead 588, the sentence about 30) and about 80 output tokens, so about $0.0017 per sentence. Broadcast speech runs about 10 sentences a minute, so 600 an hour, about $1.03. Fast talk-show speech with short sentences can reach 15 a minute, about $1.55.
- At that rate the $50 cap is roughly 25 to 35 hours of listening.

## Spend cap

Running total in KV key `spend_total_usd`. Before minting a Deepgram token or making a scoring call the server checks it: at $50.00 it refuses with "Meter budget reached"; at $40.00 the page shows a warning banner. `GET /api/spend` (passcode-protected) returns the total.

- Anthropic cost comes from the `usage` fields of every response, including responses the meter drops as malformed.
- Deepgram cost comes from audio seconds the browser reports every 10 s (`POST /api/listen-tick`, at most 60 s per report). The browser talks to Deepgram directly, so the server cannot count the audio itself.
- KV allows one write per second per key and has no atomic add, so charges are batched per isolate into one write every 1.5 s, and the cap check counts charges not yet written. Two isolates flushing in the same instant can still lose one flush (cents).
- A corrupt stored total fails closed (500), never reads as $0.
- Runs on Workers Paid (confirmed by Max 2026-10-07): 1 million KV writes a month included. The meter writes about 600 times an hour of listening. The Free plan's 1,000 writes a day would last about 1.5 hours.

## Local run (stubbed, no paid calls)

```sh
npm install
cp .dev.vars.example .dev.vars   # set METER_PASSCODE, and STUB_MODE=1
npm test                         # typecheck + 40 unit tests
npm run dev                      # http://127.0.0.1:8788
```

With `STUB_MODE=1` the server fakes Deepgram and Anthropic (realistic delays and usage numbers, and about one malformed answer in eleven), and the page plays a scripted broadcast through the real pipeline. Stub mode is refused on any host other than localhost. The stub's scores come from a keyword list and say nothing about the real rubric. Tick "Show lag" to see final-transcript-to-display time per sentence.

## Deploy (Max runs these; nothing here has been run)

```sh
# 1. Create the Pages project and the KV namespace (writes the id into wrangler.toml)
./scripts/create-project.sh

# 2. Set the three secrets (each prompts for the value)
npx wrangler pages secret put DEEPGRAM_API_KEY --project-name litmus-meter
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name litmus-meter
npx wrangler pages secret put METER_PASSCODE --project-name litmus-meter

# 3. Deploy
npm run deploy
```

The Deepgram key needs at least Member permission to mint tokens.
