"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

/**
 * Webhook signature verification (docs/api-contract.md §6 «Verifying»).
 * Header `ImageStep-Signature: t=<epoch s>,v1=<hex hmac-sha256>` over `"<t>.<raw body>"`.
 * Node-only (node:crypto) — this package never runs at the edge.
 */
function parseSignatureHeader(header) {
  const parts = {};
  for (const kv of String(header || "").split(",")) {
    const i = kv.indexOf("=");
    if (i <= 0) continue;
    parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return { timestamp: Number(parts.t), signature: parts.v1 || null };
}

/**
 * @param {string|Buffer} rawBody the request body exactly as received (not re-serialised)
 * @param {string} header the `ImageStep-Signature` header
 * @param {string} secret the endpoint secret shown once at creation
 * @param {{ toleranceSeconds?: number, now?: number }} [opts]
 * @returns {boolean}
 */
function verifySignature(rawBody, header, secret, opts = {}) {
  const { timestamp, signature } = parseSignatureHeader(header);
  if (!timestamp || !signature || !secret) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  const given = signature.toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
}

module.exports = { parseSignatureHeader, verifySignature };
