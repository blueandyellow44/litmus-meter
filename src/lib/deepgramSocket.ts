// Deepgram live transcription over WebSocket, authenticated with the
// short-lived JWT from /api/deepgram-token (subprotocol ["bearer", token], the
// form Deepgram's own JS SDK 5.14 uses).

export const DEEPGRAM_PARAMS: Record<string, string> = {
  model: "nova-3",
  language: "en",
  punctuate: "true",
  smart_format: "true",
  interim_results: "true",
  // Finalize after 700 ms of silence. 300 ms cut rambling speakers into
  // fragments mid-thought (Max's live test, 2026-10-07); 700 trades about
  // 0.4 s of lag for lines that hold a whole thought.
  endpointing: "700",
  // Backstop for noisy audio where endpointing never fires. 1000 is
  // Deepgram's documented minimum.
  utterance_end_ms: "1000",
  vad_events: "true",
  encoding: "linear16",
  sample_rate: "16000",
  channels: "1",
};

// Names news speech recognition tends to mishear ("Strait of Hormones").
// Nova-3 keyterm prompting: up to 100 terms, 500 tokens per request
// (https://developers.deepgram.com/docs/keyterm). Add to it as mishearings show up.
export const KEYTERMS = [
  "Strait of Hormuz", "Hormuz", "Hezbollah", "Hamas", "Houthis", "Gaza", "Netanyahu", "Zelenskyy",
  "Kyiv", "Kremlin", "Putin", "Xi Jinping", "Taiwan", "Pyongyang", "Tehran", "Khamenei",
  "IDF", "NATO", "OPEC", "Pentagon", "Mar-a-Lago", "MAGA", "Schumer", "Jeffries", "Thune",
  "Vance", "Rubio", "Hegseth", "Medicaid", "Medicare", "tariffs", "filibuster", "reconciliation",
  "Supreme Court", "ICE", "DOGE", "Fed", "Powell",
];

export function deepgramUrl(): string {
  const params = new URLSearchParams(DEEPGRAM_PARAMS);
  for (const term of KEYTERMS) params.append("keyterm", term);
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export interface TranscriptSocket {
  send(pcm: ArrayBuffer): void;
  close(): void;
}

export function openDeepgram(
  token: string,
  onMessage: (msg: unknown) => void,
  onClosed: (reason: string) => void,
): Promise<TranscriptSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(deepgramUrl(), ["bearer", token]);
    ws.binaryType = "arraybuffer";
    let open = false;
    let closedByUs = false;
    ws.onopen = () => {
      open = true;
      resolve({
        send(pcm) {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        },
        close() {
          closedByUs = true;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close();
        },
      });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        console.warn("unparseable Deepgram message", e.data);
      }
    };
    ws.onerror = () => {
      if (!open) reject(new Error("Could not connect to the transcription service."));
    };
    ws.onclose = (e) => {
      if (!open) reject(new Error(`Transcription connection refused (${e.code}).`));
      else if (!closedByUs) onClosed(`Transcription connection closed (${e.code}${e.reason ? `: ${e.reason}` : ""}).`);
    };
  });
}
