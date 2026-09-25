/**
 * va-profile-read.js — the VA's own Profile, read-only (Stage 2b §1.2).
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <profile SSO token minted by the gate>
 *   -> 200 { ok:true, profile: {...whitelisted, masked...} }
 *   -> 200 { ok:true, profile:null, reason:"no_profile" }   (honest empty state)
 *   -> 401 generic, for EVERY verification failure
 *   -> 500 only for server misconfiguration (missing secret / Supabase env)
 *
 * WHY THIS LIVES IN THE DASHBOARD, NOT THE GATE (Stage 1 decision A):
 * the SUPABASE_SERVICE_ROLE_KEY lives in exactly ONE repo. The gate never gets
 * it. The gate proves "this is VA X" with a short-lived, audience-scoped signed
 * token; this endpoint verifies that token and does the privileged read.
 *
 * IDENTITY: `va_key` is taken ONLY from the verified token claim. It is never
 * read from the body, the query string, or a header — so a tampered client can
 * only ever be itself.
 *
 * Env (SERVER ONLY): PROFILE_SSO_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const { verifyProfileToken } = require("./_profile-sso-verify");
const { getVaSafeProfile } = require("./_profiles-db");

/* CORS allowlist, Bearer parsing and the fail-closed verify live in
 * _profile-api-common.js (shared with ack-status / ack-accept / events-ingest).
 * The history of WHY the allowlist is shaped this way — DNS, not grep — is in
 * that file. The exports below keep this endpoint's tests unchanged. */
const { DEFAULT_GATE_ORIGINS, allowedOrigins, corsHeaders: _cors, bearer } = require("./_profile-api-common");
const corsHeaders = (origin) => _cors(origin, "va-profile-read");

const json = (code, obj, origin) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin) },
  body: JSON.stringify(obj),
});

exports.handler = async (event, _ctx, deps = {}) => {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin || "";

  if ((event && event.httpMethod) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }
  if ((event && event.httpMethod) !== "POST") {
    return json(405, { ok: false, error: "POST only" }, origin);
  }

  const secret = process.env.PROFILE_SSO_SECRET || "";

  // Verify FIRST. Nothing is read, and no Supabase call is made, until the
  // token proves who this is.
  const v = verifyProfileToken({ token: bearer(headers), secret, log: deps.log });
  if (!v.ok) {
    if (v.reason === "no_secret") {
      // Server misconfiguration — loud 500, never a verify-less success.
      return json(500, { ok: false, error: "Server misconfiguration." }, origin);
    }
    // Every other failure is the SAME generic 401 — we never tell a caller
    // which step failed (signature vs expiry vs audience).
    return json(401, { ok: false, error: "Not authorized." }, origin);
  }

  try {
    const profile = await getVaSafeProfile(v.va_key, deps.dbOpts || {});
    if (!profile) {
      // Honest empty state, not a skeleton of blank fields.
      return json(200, { ok: true, profile: null, reason: "no_profile" }, origin);
    }
    return json(200, { ok: true, profile }, origin);
  } catch (err) {
    const msg = String((err && err.message) || "");
    if (/missing SUPABASE/i.test(msg)) {
      console.error(`va-profile-read: ${msg}`);
      return json(500, { ok: false, error: "Server misconfiguration." }, origin);
    }
    console.error(`va-profile-read: read failed — ${msg}`);
    return json(502, { ok: false, error: "Couldn't load your profile right now. Please try again." }, origin);
  }
};

exports._internal = { bearer, corsHeaders, allowedOrigins, DEFAULT_GATE_ORIGINS };
