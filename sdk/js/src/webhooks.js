/**
 * Webhook signature verification (docs/api-contract.md §6 «Verifying»).
 * Header `ImageStep-Signature: t=<epoch s>,v1=<hex hmac-sha256>` over `"<t>.<raw body>"`.
 * Uses Web Crypto, the global `crypto` — Node 18 keeps it behind a flag, so `engines` says 20 — and runs on Node and edge runtimes alike.
 */
const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseSignatureHeader(header) {
  const parts = Object.fromEntries(
    String(header || "")
      .split(",")
      .map((kv) => kv.trim().split("="))
      .filter(([k, v]) => k && v)
  );
  return { timestamp: Number(parts.t), signature: parts.v1 || null };
}

/**
 * @param {string} rawBody the request body exactly as received (not re-serialised)
 * @param {string} header the `ImageStep-Signature` header
 * @param {string} secret the endpoint secret shown once at creation
 * @param {{ toleranceSeconds?: number, now?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(rawBody, header, secret, opts = {}) {
  // An unset secret is a configuration error, not a failed signature (#479): an empty key's HMAC is one anybody can
  // compute, and `null` used to become the string "null" — so a forgery checked out against a missing env var. Thrown,
  // not `false`, so it cannot be mistaken for one bad delivery and shrugged off.
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("ImageStep: verifyWebhookSignature needs the endpoint's secret — it is empty or not a string");
  }
  const { timestamp, signature } = parseSignatureHeader(header);
  if (!timestamp || !signature) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  return timingSafeEqual(toHex(mac), signature.toLowerCase());
}

/**
 * Parse + verify in one call; throws when the signature does not check out.
 * @returns {Promise<{ id: string, type: string, createdAt: string, data: object }>}
 */
export async function constructWebhookEvent(rawBody, header, secret, opts) {
  if (!(await verifyWebhookSignature(rawBody, header, secret, opts))) {
    throw new Error("ImageStep webhook signature verification failed");
  }
  return JSON.parse(rawBody);
}
