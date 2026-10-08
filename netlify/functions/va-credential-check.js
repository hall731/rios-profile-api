/**
 * va-credential-check.js — the gate's server-to-server credential check
 * (docs/stories/va-secure-login.md).
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <profile SSO token WITH purpose:"credentials">
 *   { action:"login",        secret }                 -> 200 { ok:true, state:"none"|"password"|"passcode" } | 401 { ok:false }
 *   { action:"set_password", passcode, new_password } -> 200 { ok:true } | 401 { ok:false } | 400 { ok:false, reason:"weak" }
 *   anything else                                      -> 400
 *   DB unreachable                                     -> 502 generic
 *
 * The token's purpose claim is the whole point: the gate mints it BEFORE the
 * VA has proven a password, so it must not be able to read anything. The
 * verifier refuses a purpose token on every other endpoint, and refuses a
 * plain profile token here. Identity (va_key) comes only from the verified
 * claim. No response ever carries a hash or echoes a secret.
 */

const { openRequest, json } = require("./_profile-api-common");
const creds = require("./_credentials-db");

const FN = "va-credential-check";

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, { ...deps, expectedPurpose: "credentials" });
  if (o.early) return o.early;
  if (o.audience !== "va" || !o.va_key) return json(401, { ok: false }, o.origin, FN);
  const body = o.body || {};
  const dbOpts = deps.dbOpts || {};
  try {
    if (body.action === "login") {
      const r = await creds.login({ vaKey: o.va_key, secret: body.secret }, dbOpts);
      return r.ok ? json(200, { ok: true, state: r.state }, o.origin, FN) : json(401, { ok: false }, o.origin, FN);
    }
    if (body.action === "set_password") {
      const r = await creds.setPassword({ vaKey: o.va_key, passcode: body.passcode, newPassword: body.new_password }, dbOpts);
      if (r.ok) return json(200, { ok: true }, o.origin, FN);
      if (r.reason === "weak") return json(400, { ok: false, reason: "weak" }, o.origin, FN);
      return json(401, { ok: false }, o.origin, FN);
    }
    return json(400, { ok: false, error: "Bad request." }, o.origin, FN);
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return json(500, { ok: false, error: "Server misconfiguration." }, o.origin, FN); }
    console.error(`${FN}: store failed — ${msg.slice(0, 200)}`);
    return json(502, { ok: false, error: "Couldn't check right now. Please try again." }, o.origin, FN);
  }
};
