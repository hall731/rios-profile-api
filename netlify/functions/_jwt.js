/**
 * _jwt.js — SHARED helper (leading underscore: NOT a Netlify endpoint).
 * ---------------------------------------------------------------------------
 * Minimal, dependency-free JWT HS256 sign + signature-verify, built on Node's
 * `crypto`. Here it signs / verifies the admin session cookie (see
 * _admin-session.js). PORTED VERBATIM from the chat repo's proven _jwt.js —
 * Netlify functions can't import across repos, so the code is copied. The wire
 * format is identical.
 *
 * SECURITY NOTES
 * - `verifySignature` REJECTS any header whose `alg` is not exactly "HS256".
 *   This closes the classic `alg:"none"` / algorithm-confusion downgrade.
 * - Signature comparison is constant-time (crypto.timingSafeEqual).
 * - This module does signature + structural decode ONLY. Claim checks (exp,
 *   kind, role) are done by the caller.
 */

const crypto = require("crypto");

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecodeToString(str) {
  return Buffer.from(String(str), "base64url").toString("utf8");
}

function hmac256(input, secret) {
  return crypto.createHmac("sha256", secret).update(input).digest();
}

/**
 * sign(payload, secret) -> compact JWT string.
 * `payload` is an object of claims; caller sets iat/exp/etc.
 */
function sign(payload, secret) {
  if (!secret) throw new Error("_jwt.sign: missing secret");
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const sig = b64urlEncode(hmac256(signingInput, secret));
  return `${signingInput}.${sig}`;
}

/**
 * verifySignature(token, secret) -> { ok, payload, header, reason }
 * Verifies structure + HS256 signature ONLY. Never throws.
 */
function verifySignature(token, secret) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeToString(h));
    payload = JSON.parse(b64urlDecodeToString(p));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Reject anything that is not exactly HS256 — no alg:"none", no downgrade.
  if (!header || header.alg !== "HS256") return { ok: false, reason: "alg" };

  const expected = hmac256(`${h}.${p}`, secret);
  let given;
  try {
    given = Buffer.from(String(s), "base64url");
  } catch {
    return { ok: false, reason: "signature" };
  }
  if (given.length !== expected.length) return { ok: false, reason: "signature" };
  if (!crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }

  return { ok: true, header, payload };
}

module.exports = { sign, verifySignature, b64urlEncode };
