/**
 * events-ingest.js — VA-side telemetry intake (Stage 1 piping, Stage 3 endpoint).
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <profile SSO token>
 *       { kind, surface?, session_id?, meta? }
 *   -> 200 { ok:true, recorded:boolean }
 *   -> 403 { ok:false, error:"ack_required" }  — NOTHING is recorded for a VA
 *      who has not acknowledged the current privacy document. Enforced here,
 *      server-side, not by the gate's UI.
 *   -> 401 / 400 / 500 as the other endpoints.
 *
 * Identity: va_key from the verified token only. session_id is an opaque id
 * the gate keeps in sessionStorage for the tab's life — analytics grouping,
 * not auth. If the acknowledgment cannot be READ we refuse to record (fail
 * closed) but still answer 200 {recorded:false}: telemetry is never a user-
 * facing failure.
 */

const { openRequest, json } = require("./_profile-api-common");
const ack = require("./_ack-db");
const events = require("./_events-db");

const FN = "events-ingest";

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  const b = o.body;
  const ev = {
    audience: o.audience,
    subject_key: o.subject_key,
    kind: String(b.kind || ""),
    surface: b.surface == null ? undefined : String(b.surface),
    session_id: b.session_id == null ? undefined : String(b.session_id).slice(0, 64),
    meta: b.meta && typeof b.meta === "object" && !Array.isArray(b.meta) ? b.meta : undefined,
  };
  const bad = events.validate(ev);
  if (bad) return json(400, { ok: false, error: bad }, o.origin, FN);

  let acknowledged = false;
  try {
    acknowledged = (await ack.status({ audience: o.audience, subject_key: o.subject_key }, deps.dbOpts || {})).acknowledged;
  } catch (e) {
    console.warn(`${FN}: could not read acknowledgment — not recording. ${e && e.message}`);
    return json(200, { ok: true, recorded: false }, o.origin, FN);
  }
  if (!acknowledged) return json(403, { ok: false, error: "ack_required" }, o.origin, FN);

  const recorded = await events.record(ev, deps.dbOpts || {});
  return json(200, { ok: true, recorded }, o.origin, FN);
};
