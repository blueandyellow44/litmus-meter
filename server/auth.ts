// Passcode gate and session cookie.
//
// The cookie is "<expiryMs>.<hmac>" signed with a key derived from
// METER_PASSCODE, so it carries no state on the server and changing the
// passcode invalidates every live session.

export const COOKIE_NAME = "meter_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares in time independent of where the strings first differ.
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function checkPasscode(submitted: unknown, configured: string | undefined): boolean {
  if (!configured) return false; // no passcode configured means nobody gets in
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  return constantTimeEqual(submitted, configured);
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`litmus-meter-session:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function issueSessionCookie(secret: string, nowMs: number, secure: boolean): Promise<string> {
  const expiry = String(nowMs + SESSION_TTL_SECONDS * 1000);
  const token = `${expiry}.${await sign(expiry, secret)}`;
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export async function hasValidSession(
  cookieHeader: string | null,
  secret: string | undefined,
  nowMs: number,
): Promise<boolean> {
  if (!secret) return false;
  const token = readCookie(cookieHeader, COOKIE_NAME);
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) <= nowMs) return false;
  return constantTimeEqual(mac, await sign(expiry, secret));
}
