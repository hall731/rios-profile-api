/**
 * ack-status.js — has this VA acknowledged the CURRENT privacy document?
 * (Stage 2 mechanism, Stage 3 endpoint — lives on profile-api.)
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <profile SSO token minted by the gate>
 *   -> 200 { ok:true, acknowledged:boolean, doc:{ version, title, text, sha256, draft }, accepted:{version,at}|null }
 *   -> 401 generic for every verification failure; 500 misconfiguration;
 *      502 when the log cannot be read (the gate treats that as NOT acknowledged).
 *
 * Returns the document TEXT so the gate renders exactly what gets hashed —
 * there is no second copy of the wording anywhere a portal could drift from.
 * Identity: va_key from the verified claim only.
 */

const { openRequest, json } = require("./_profile-api-common");
const ack = require("./_ack-db");
const docs = require("./_ack-docs");

const FN = "ack-status";

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  try {
    const s = await ack.status({ audience: o.audience, subject_key: o.subject_key }, deps.dbOpts || {});
    const d = docs.current(o.audience);
    return json(200, {
      ok: true,
      acknowledged: s.acknowledged,
      doc: { version: d.version, title: d.title, text: d.text, sha256: d.sha256, draft: d.draft },
      accepted: s.accepted,
    }, o.origin, FN);
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return json(500, { ok: false, error: "Server misconfiguration." }, o.origin, FN); }
    console.error(`${FN}: read failed — ${msg}`);
    return json(502, { ok: false, error: "Couldn't check right now. Please try again." }, o.origin, FN);
  }
};
