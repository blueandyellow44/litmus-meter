// Mints a short-lived Deepgram JWT so the browser never sees the API key.
// https://developers.deepgram.com/reference/token-based-auth-api/grant-token
// The token only has to be valid when the WebSocket opens; the stream stays
// open after it expires.

export const DEEPGRAM_TOKEN_TTL_SECONDS = 30;

export interface DeepgramToken {
  access_token: string;
  expires_in: number;
}

export async function grantDeepgramToken(apiKey: string): Promise<DeepgramToken> {
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: DEEPGRAM_TOKEN_TTL_SECONDS }),
  });
  if (!res.ok) throw new Error(`deepgram grant ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as Partial<DeepgramToken>;
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("deepgram grant returned no access_token");
  }
  return { access_token: body.access_token, expires_in: Number(body.expires_in ?? DEEPGRAM_TOKEN_TTL_SECONDS) };
}
