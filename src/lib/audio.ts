// Audio capture: a browser tab (getDisplayMedia) or the microphone
// (getUserMedia), turned into 16 kHz PCM chunks by public/pcm-worklet.js.

export const SAMPLE_RATE = 16000;

export class CaptureError extends Error {}

export interface Capture {
  stop(): void;
}

// Chrome only offers tab audio alongside video; the video track is never used.
export async function getTabStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new CaptureError("This browser cannot share a tab. Use desktop Chrome, or use the microphone.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    throw new CaptureError("Tab sharing was cancelled.");
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError("Tab audio wasn't shared. Pick the tab again and tick “Share tab audio”.");
  }
  return stream;
}

export async function getMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CaptureError("This browser cannot use the microphone here. The page must be served over https.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new CaptureError("Microphone access was refused.");
  }
}

// `ctx` must be created inside the click handler so mobile Safari lets it run.
export async function startPcm(
  ctx: AudioContext,
  stream: MediaStream,
  onChunk: (pcm: ArrayBuffer) => void,
  onEnded: () => void,
): Promise<Capture> {
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  if (ctx.state === "suspended") await ctx.resume();
  const source = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const node = new AudioWorkletNode(ctx, "pcm-downsampler");
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(e.data);
  source.connect(node);
  // The worklet only runs while connected to the graph; a muted gain keeps the
  // captured audio from playing twice.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);

  // "Stop sharing" in Chrome's bar, or a mic unplugged, ends the session.
  stream.getTracks().forEach((t) => t.addEventListener("ended", onEnded, { once: true }));

  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
