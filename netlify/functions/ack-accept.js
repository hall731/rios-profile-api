/**
 * ack-accept.js — log this VA's acceptance of the CURRENT privacy document.
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <profile SSO token>   { doc_version, doc_sha256 }
 *   -> 200 { ok:true, acknowledged:true, accepted_at }
 *   -> 409 { ok:false, error:"stale" } when version/sha are not the current doc
 *      (the gate re-fetches ack-status and shows the new text)
 *   -> 401 / 500 / 502 as ack-status.
 *
 * The client sends back the version + sha it SHOWED; the server accepts only
 * if they equal the current document. So a tab left open across a version
 * bump cannot log acceptance of text nobody saw. Identity from the token only.
 */

const { openRequest, json } = require("./_profile-api-common");
const ack = require("./_ack-db");

const FN = "ack-accept";

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  const doc_version = String(o.body.doc_version || "");
  const doc_sha256 = String(o.body.doc_sha256 || "").toLowerCase();
  if (!doc_version || !/^[0-9a-f]{64}$/.test(doc_sha256))
    return json(400, { ok: false, error: "doc_version and doc_sha256 are required." }, o.origin, FN);
  try {
    const row = await ack.record({ audience: "va", subject_key: o.va_key, doc_version, doc_sha256 }, deps.dbOpts || {});
    return json(200, { ok: true, acknowledged: true, accepted_at: (row && row.accepted_at) || new Date().toISOString() }, o.origin, FN);
  } catch (e) {
    if (e && e.status === 409) return json(409, { ok: false, error: "stale" }, o.origin, FN);
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return json(500, { ok: false, error: "Server misconfiguration." }, o.origin, FN); }
    console.error(`${FN}: write failed — ${msg}`);
    return json(502, { ok: false, error: "Couldn't save right now. Please try again." }, o.origin, FN);
  }
};
