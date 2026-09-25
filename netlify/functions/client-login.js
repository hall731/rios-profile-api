/**
 * client-login.js — the client portal's door into the client store (Stage 4).
 * profile-api only (the dashboard copy is the source of truth, never reachable
 * there behind the site password).
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <rios-client LOGIN-PURPOSE token>   { first, last, email }
 *   -> 200 { ok:true, client:{ id, first, last, email, va_keys:[...] } }
 *   -> 401 generic  — bad token, OR no match (SAME message; never say which)
 *   -> 409 { ok:false, error }  — the trio matches more than one live client
 *   -> 500 misconfiguration; 502 store unreachable
 *
 * Server-to-server: rios-client's own function calls this with a token that
 * carries no identity, only `purpose:"client-login"` signed with
 * CLIENT_SSO_SECRET. It proves the caller is the portal's server; the trio
 * match here decides who the client is. The identity returned is clients.id
 * plus the live va_keys — the portal writes THAT into its session, never the
 * typed input.
 *
 * Env (SERVER ONLY): CLIENT_SSO_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const { verifyClientToken } = require("./_client-sso-verify");
const { corsHeaders, bearer } = require("./_profile-api-common");
const db = require("./_clients-db");

const FN = "client-login";
const GENERIC = "Those details don't match an active account. Check the spelling against your welcome email — or reply to it and we'll sort it out.";
const json = (code, obj, origin) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin, FN) },
  body: JSON.stringify(obj),
});

exports.handler = async (event, _ctx, deps = {}) => {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin || "";
  if ((event && event.httpMethod) === "OPTIONS") return { statusCode: 204, headers: corsHeaders(origin, FN), body: "" };
  if ((event && event.httpMethod) !== "POST") return json(405, { ok: false, error: "POST only" }, origin);

  const secret = process.env.CLIENT_SSO_SECRET || "";
  const v = verifyClientToken({ token: bearer(headers), secret, log: deps.log });
  if (!v.ok) {
    if (v.reason === "no_secret") return json(500, { ok: false, error: "Server misconfiguration." }, origin);
    return json(401, { ok: false, error: "Not authorized." }, origin);
  }
  if (v.purpose !== "client-login") return json(401, { ok: false, error: "Not authorized." }, origin);

  let body;
  try { body = JSON.parse((event && event.body) || "{}") || {}; } catch { return json(400, { ok: false, error: "Bad request." }, origin); }
  const first = String(body.first || "").trim(), last = String(body.last || "").trim(), email = String(body.email || "").trim();
  if (!first || !last || !email) return json(401, { ok: false, error: GENERIC }, origin);

  try {
    let client;
    try { client = await db.matchClient({ first, last, email }, deps.dbOpts || {}); }
    catch (e) {
      if (e.code === "AMBIGUOUS_CLIENT") {
        console.error(`${FN}: AMBIGUOUS CLIENT LOGIN refused — trio matches multiple live clients. Fix the duplicate in Settings → Clients.`);
        return json(409, { ok: false, error: "We found more than one account with those details. Reply to your welcome email and we'll sort it out." }, origin);
      }
      throw e;
    }
    if (!client) return json(401, { ok: false, error: GENERIC }, origin);
    const va_keys = await db.liveVaKeys(client.id, deps.dbOpts || {});
    return json(200, { ok: true, client: { id: client.id, first: client.first_name, last: client.last_name, email: client.email, va_keys } }, origin);
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return json(500, { ok: false, error: "Server misconfiguration." }, origin); }
    console.error(`${FN}: store read failed — ${msg}`);
    return json(502, { ok: false, error: "We couldn't sign you in right now. Try again in a moment." }, origin);
  }
};
