/**
 * va-calendar-read.js — the VA's own calendar, read-only (Stage 5). profile-api.
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <gate-minted profile token>   { year? }
 *   -> 200 { ok, year, allowance, used, remaining,
 *            timeOff:[{ start_day, end_day, kind, counted }],
 *            holidays:[{ day, name, region }] }
 *   -> 403 for a CLIENT token (clients see no calendar in V1)
 *   -> 401 / 500 / 502 as the other endpoints
 *
 * Identity: va_key from the verified token only. `note` is NEVER returned —
 * it is an admin's note about the entry, not the VA's.
 */

const { openRequest, json } = require("./_profile-api-common");
const cal = require("./_calendar-db");

const FN = "va-calendar-read";

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  if (o.audience !== "va") return json(403, { ok: false, error: "Not available." }, o.origin, FN);
  const year = Number(o.body.year) || new Date().getUTCFullYear();
  try {
    const [entries, holidays] = await Promise.all([
      cal.listTimeOff({ va_key: o.va_key, year }, deps.dbOpts || {}),
      cal.listHolidays({ from: `${year}-01-01`, to: `${year + 1}-12-31` }, deps.dbOpts || {}),
    ]);
    const s = cal.summarizeYear(entries, holidays, { year });
    return json(200, {
      ok: true, year: s.year, allowance: s.allowance, used: s.used, remaining: s.remaining,
      timeOff: s.entries.map((e) => ({ start_day: e.start_day, end_day: e.end_day, kind: e.kind, counted: e.counted })),   // explicit: no note, no id
      holidays: holidays.map((h) => ({ day: h.day, name: h.name, region: h.region })),
    }, o.origin, FN);
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return json(500, { ok: false, error: "Server misconfiguration." }, o.origin, FN); }
    console.error(`${FN}: read failed — ${msg}`);
    return json(502, { ok: false, error: "Couldn't load your calendar right now." }, o.origin, FN);
  }
};
