/**
 * client-availability.js — when the client's own VA(s) are off, the next 90 days. profile-api.
 * ---------------------------------------------------------------------------
 * Story: docs/stories/va-availability.md.
 *
 * POST  Authorization: Bearer <portal client identity token>   {}
 *   -> 200 { ok:true, from, to,
 *            vas:[{ va, timeOff:[{ start, end }] }],
 *            holidays:[{ day, name }] }
 *   -> 403 for a VA token ("Clients only.")
 *   -> 401 no / bad / expired / purpose token; 500 misconfigured; 502 database down
 *
 * WHICH VAs: the client's LIVE assignments, read from client_assignments on
 * every request — NOT the va_keys copied into the 30-day session/token — so a
 * VA moved to another client drops off this list immediately.
 *
 * WINDOW: today (UTC date) through today + WINDOW_DAYS, inclusive. A time-off
 * row is shown when it overlaps the window, with its REAL start/end (not clipped).
 *
 * PRIVACY (hard rule 1 — the work, never the person): only DATES and the fact
 * that a VA is off leave here. Never the time-off `kind` ("sick" is health),
 * never the admin `note`, never ids, counted days, allowance, who entered it,
 * or a holiday's region. The response is an explicit literal built field by
 * field; rios-client's client-availability.js rebuilds it again (second layer).
 * The time-off read itself selects dates only (_calendar-db.listTimeOffRange).
 *
 * HOLIDAYS: live rows with region ALL or MX. Nothing records a VA's region
 * yet; the day-count math already assumes MX. US holidays are not shown.
 *
 * Failure: any read failing => 502, never a partial list (a missing time-off
 * read would read to the client as "your VA is available"). Each read is
 * retried once after a short pause on a 5xx / network error.
 */

const { openRequest, json } = require("./_profile-api-common");
const cal = require("./_calendar-db");
const clientsDb = require("./_clients-db");

const FN = "client-availability";
const WINDOW_DAYS = 90;
const CLIENT_HOLIDAY_REGIONS = ["ALL", "MX"];
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RETRY_ATTEMPTS = 2;          // first try + one retry
const RETRY_BASE_MS = 200;

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/** windowFor(nowMs) -> { from, to } as YYYY-MM-DD, UTC, inclusive. */
function windowFor(nowMs) {
  const d = new Date(nowMs);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { from: isoDay(today), to: isoDay(today + WINDOW_DAYS * DAY_MS) };
}

const validDay = (s) => typeof s === "string" && DATE_RE.test(s) && isoDay(Date.parse(`${s}T00:00:00Z`)) === s;

/** Retry a read once on a 5xx or a network error; never on a 4xx or missing config. */
async function withRetry(label, fn, sleep) {
  let last;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = String((e && e.message) || "");
      const retryable = !/missing SUPABASE/i.test(msg) && (!(e && e.status) || e.status >= 500);
      if (!retryable || i === RETRY_ATTEMPTS - 1) break;
      console.warn(`${FN}: ${label} failed, retrying — ${msg}`);
      await sleep(RETRY_BASE_MS * (i + 1));
    }
  }
  throw last;
}

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  const J = (code, obj) => json(code, obj, o.origin, FN);
  if (o.audience !== "client") return J(403, { ok: false, error: "Clients only." });

  const db = deps.dbOpts || {};
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = typeof deps.now === "function" ? Number(deps.now()) : Date.now();
  const { from, to } = windowFor(nowMs);

  try {
    // Live assignments, now. Deduped, order kept (most recent assignment first).
    const keys = [];
    for (const k of await withRetry("assignment read", () => clientsDb.liveVaKeys(o.client_id, db), sleep)) {
      if (typeof k === "string" && k.trim() && !keys.includes(k)) keys.push(k);
    }
    if (!keys.length) return J(200, { ok: true, from, to, vas: [], holidays: [] });

    const [holidayRows, perVa] = await Promise.all([
      withRetry("holiday read", () => cal.listHolidays({ from, to }, db), sleep),
      Promise.all(keys.map((va_key) => withRetry("time-off read", () => cal.listTimeOffRange({ va_key, from, to }, db), sleep))),
    ]);

    const vas = keys.map((va_key, i) => {
      const seen = new Set();
      const timeOff = [];
      for (const r of perVa[i] || []) {
        if (!r || r.deleted_at || r.va_key !== va_key) continue;
        if (!validDay(r.start_day) || !validDay(r.end_day) || r.end_day < r.start_day) {
          console.warn(`${FN}: skipping a time-off row with unreadable dates`);
          continue;
        }
        if (r.end_day < from || r.start_day > to) continue;          // overlap test; dates are not clipped
        const sig = `${r.start_day}|${r.end_day}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        timeOff.push({ start: r.start_day, end: r.end_day });
      }
      timeOff.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
      return { va: va_key, timeOff };
    });

    const hseen = new Set();
    const holidays = [];
    for (const hrow of holidayRows || []) {
      if (!hrow || hrow.deleted_at || !CLIENT_HOLIDAY_REGIONS.includes(hrow.region)) continue;
      if (!validDay(hrow.day) || hrow.day < from || hrow.day > to) continue;
      if (typeof hrow.name !== "string" || !hrow.name.trim()) continue;
      const sig = `${hrow.day}|${hrow.name}`;
      if (hseen.has(sig)) continue;
      hseen.add(sig);
      holidays.push({ day: hrow.day, name: hrow.name });
    }
    holidays.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return J(200, { ok: true, from, to, vas, holidays });
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return J(500, { ok: false, error: "Server misconfiguration." }); }
    console.error(`${FN}: read failed — ${msg}`);
    return J(502, { ok: false, error: "Couldn't check availability right now." });
  }
};

exports.WINDOW_DAYS = WINDOW_DAYS;
exports.CLIENT_HOLIDAY_REGIONS = CLIENT_HOLIDAY_REGIONS;
exports.windowFor = windowFor;
