/**
 * _profile-api-common.js — SHARED (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * The three things every profile-api endpoint does before its own work:
 *   1. CORS against the gate-origin allowlist (fail safe: unknown origin gets
 *      NO Allow-Origin header — never an echo, never "the first in the list").
 *   2. Read the Bearer token.
 *   3. Verify it fail-closed with _profile-sso-verify (no_secret -> 500,
 *      everything else -> one generic 401).
 * Extracted from va-profile-read.js (which keeps re-exporting these for its
 * tests) so ack-status / ack-accept / events-ingest cannot drift from it.
 *
 * Env (SERVER ONLY): PROFILE_SSO_SECRET (gate edge), CLIENT_SSO_SECRET (portal
 * edge, Stage 4), PROFILE_GATE_ORIGINS / PROFILE_CLIENT_ORIGINS (comma-separated
 * extra origins, e.g. deploy previews, the portal host).
 */

const { verifyProfileToken } = require("./_profile-sso-verify");
const { verifyClientToken } = require("./_client-sso-verify");

/* The baseline is the host a real VA is served the gate from — settled by DNS
 * (va.remoteinsightos.com CNAMEs to the gate), not by grep. Apex/www are kept
 * against a later repoint. Everything else is PROFILE_GATE_ORIGINS. */
const DEFAULT_GATE_ORIGINS = [
  "https://va.remoteinsightos.com",
  "https://remoteinsightos.com",
  "https://www.remoteinsightos.com",
];

function allowedOrigins() {
  const extra = [process.env.PROFILE_GATE_ORIGINS, process.env.PROFILE_CLIENT_ORIGINS].map((v) => String(v || "")).join(",")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return DEFAULT_GATE_ORIGINS.concat(extra);
}

function corsHeaders(origin, fnName = "profile-api") {
  const list = allowedOrigins();
  const clean = String(origin || "").replace(/\/+$/, "");
  const base = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (!list.includes(clean)) {
    if (clean)
      console.warn(
        `${fnName}: origin ${clean} is not allowed. Add it to PROFILE_GATE_ORIGINS ` +
          `(comma-separated) on this site if it is a real gate origin — e.g. a deploy-preview host.`
      );
    return base;
  }
  return { ...base, "Access-Control-Allow-Origin": clean };
}

function json(code, obj, origin, fnName) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin, fnName) },
    body: JSON.stringify(obj),
  };
}

function bearer(headers = {}) {
  const raw = headers.authorization || headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : "";
}

/**
 * openRequest(event, fnName, deps) -> { origin, early } | { origin, va_key, body }
 *   Handles OPTIONS (204), non-POST (405), missing secret (500), bad token
 *   (401), bad JSON (400). `early` is a ready response when set.
 */
function openRequest(event, fnName, deps = {}) {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin || "";
  const method = (event && event.httpMethod) || "";
  if (method === "OPTIONS") return { origin, early: { statusCode: 204, headers: corsHeaders(origin, fnName), body: "" } };
  if (method !== "POST") return { origin, early: json(405, { ok: false, error: "POST only" }, origin, fnName) };

  // Two trust edges share these endpoints: the gate (VA tokens, PROFILE_SSO_SECRET)
  // and the client portal (client identity tokens, CLIENT_SSO_SECRET). Try the
  // gate's first; on any failure try the portal's. Each verifier is fail-closed
  // on its own; a token that satisfies neither is one generic 401. The result
  // carries `audience` + `subject_key`, the pair every store keys on.
  const token = bearer(headers);
  const quiet = { warn() {}, error() {} };
  const vaSecret = process.env.PROFILE_SSO_SECRET || "";
  const clientSecret = process.env.CLIENT_SSO_SECRET || "";
  if (!vaSecret && !clientSecret) {
    (deps.log || console).error("PROFILE_API_MISSING_SECRET: neither PROFILE_SSO_SECRET nor CLIENT_SSO_SECRET is set — refusing to verify.");
    return { origin, early: json(500, { ok: false, error: "Server misconfiguration." }, origin, fnName) };
  }
  let ident = null;
  // expectedPurpose (va-credential-check only): the token must carry
  // purpose:"credentials"; everywhere else a token carrying any purpose is
  // refused by the verifier. A purpose-scoped request never falls through to
  // the client verifier.
  const expectedPurpose = deps.expectedPurpose || null;
  if (vaSecret) {
    const v = verifyProfileToken({ token, secret: vaSecret, log: clientSecret ? quiet : deps.log, expectedPurpose });
    if (v.ok) ident = { audience: "va", subject_key: v.va_key, va_key: v.va_key, va_keys: [v.va_key] };
  }
  if (!ident && clientSecret && !expectedPurpose) {
    const c = verifyClientToken({ token, secret: clientSecret, log: deps.log });
    if (c.ok && c.client_id) ident = { audience: "client", subject_key: c.client_id, client_id: c.client_id, va_keys: c.va_keys };
  }
  if (!ident) {
    (deps.log || console).warn(`${fnName}: token rejected by every configured verifier`);
    return { origin, early: json(401, { ok: false, error: "Not authorized." }, origin, fnName) };
  }
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}") || {}; }
  catch { return { origin, early: json(400, { ok: false, error: "Bad request." }, origin, fnName) }; }
  return { origin, ...ident, body };
}

module.exports = { DEFAULT_GATE_ORIGINS, allowedOrigins, corsHeaders, json, bearer, openRequest };
