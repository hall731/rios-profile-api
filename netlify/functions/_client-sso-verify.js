/**
 * _client-sso-verify.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Verifier for tokens minted by rios-client (the client portal) for
 * profile-api. Same fail-closed ORDER as _profile-sso-verify.js, different
 * trust edge: DIFFERENT secret (CLIENT_SSO_SECRET), DIFFERENT issuer
 * ("rios-client"), same audience ("rios-profile"). A gate token can never pass
 * here (wrong secret AND wrong iss), and vice-versa.
 *
 * Two token shapes on this edge:
 *   identity : { client_id, va_keys?, iat, exp, aud, iss, jti }  — after login
 *   login    : { purpose:"client-login", iat, exp, aud, iss, jti } — BEFORE
 *              identity exists; it only proves "rios-client's server is
 *              asking", so client-login.js may run the trio match.
 *
 * Returns (never throws):
 *   { ok:true, client_id, va_keys }  |  { ok:true, purpose:"client-login" }
 *   { ok:false, reason }  "no_secret"|"signature"|"claims"|"expired"|"aud"|"iss"
 */

const jwt = require("./_jwt");

const EXPECTED_AUD = "rios-profile";
const EXPECTED_ISS = "rios-client";
const DEFAULT_SKEW_SEC = 30;
const REQUIRED_CLAIMS = ["iat", "exp", "aud", "iss", "jti"];

function verifyClientToken({ token, secret, nowSec = Math.floor(Date.now() / 1000), skewSec = DEFAULT_SKEW_SEC, log = console } = {}) {
  const skew = Math.min(Math.max(0, skewSec), DEFAULT_SKEW_SEC);
  if (!secret) {
    log.error("CLIENT_SSO_MISSING_SECRET: CLIENT_SSO_SECRET is not set — refusing to verify. A missing signing secret NEVER degrades into accepting unsigned tokens.");
    return { ok: false, reason: "no_secret" };
  }
  if (!token) return { ok: false, reason: "signature" };
  const v = jwt.verifySignature(token, secret);
  if (!v.ok) { log.warn(`CLIENT_SSO_VERIFY_FAIL step=signature detail=${v.reason}`); return { ok: false, reason: "signature" }; }
  const p = v.payload || {};
  const missing = REQUIRED_CLAIMS.filter((k) => p[k] === undefined || p[k] === null || p[k] === "");
  if (missing.length) { log.warn(`CLIENT_SSO_VERIFY_FAIL step=claims missing=${missing.join(",")}`); return { ok: false, reason: "claims" }; }
  if (!Number.isFinite(Number(p.exp)) || !Number.isFinite(Number(p.iat))) { log.warn("CLIENT_SSO_VERIFY_FAIL step=claims detail=non-numeric iat/exp"); return { ok: false, reason: "claims" }; }
  if (nowSec > Number(p.exp) + skew) { log.warn(`CLIENT_SSO_VERIFY_FAIL step=expired exp=${p.exp} now=${nowSec}`); return { ok: false, reason: "expired" }; }
  if (p.aud !== EXPECTED_AUD) { log.warn(`CLIENT_SSO_VERIFY_FAIL step=aud got=${String(p.aud)}`); return { ok: false, reason: "aud" }; }
  if (p.iss !== EXPECTED_ISS) { log.warn(`CLIENT_SSO_VERIFY_FAIL step=iss got=${String(p.iss)}`); return { ok: false, reason: "iss" }; }
  if (p.purpose === "client-login") return { ok: true, purpose: "client-login" };
  if (typeof p.client_id !== "string" || !p.client_id.trim()) { log.warn("CLIENT_SSO_VERIFY_FAIL step=claims detail=no client_id and no login purpose"); return { ok: false, reason: "claims" }; }
  const va_keys = Array.isArray(p.va_keys) ? p.va_keys.filter((k) => typeof k === "string" && k.trim()) : [];
  return { ok: true, client_id: p.client_id, va_keys };
}

module.exports = { verifyClientToken, EXPECTED_AUD, EXPECTED_ISS, DEFAULT_SKEW_SEC, REQUIRED_CLAIMS };
