/**
 * _calendar-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Service-role access to `holidays` and `va_time_off`
 * (supabase/migrations/20260924120000_calendar.sql), plus the PURE day-count
 * math both the admin Calendar tab and the VA's Profile panel use — one
 * implementation, so the two surfaces can never disagree about "days used".
 *
 * DECIDED constants (2026-09-24): 6 vacation days per calendar year, company
 * wide, no carryover. (2026-10-01, Cody) A VA who STARTS on or after July 1
 * gets 3 days for that first calendar year, and no vacation is usable until
 * 90 days after their start date. Start date comes from profiles.start_date;
 * no start date on file = the standard 6, no 90-day check. Counted days = Mon–Fri inside the entry ∩ the calendar
 * year, minus shared holidays whose region is ALL or the VA's region.
 * Only kind='vacation' counts. Tombstoned rows never count.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const VACATION_DAYS_PER_YEAR = 6;
const FIRST_YEAR_LATE_START_DAYS = 3;     // started on/after July 1
const LATE_START_FROM_MMDD = "07-01";
const ELIGIBLE_AFTER_DAYS = 90;           // first usable day = start + 90 days
const HOLIDAYS_SUBTRACT = true;
const REGIONS = ["MX", "US", "ALL"];
const KINDS = ["vacation", "sick", "other"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HOL = "/holidays";
const TOF = "/va_time_off";
const HOL_COLS = "id,day,name,region,created_by_admin_email,created_at";
const TOF_COLS = "id,va_key,start_day,end_day,kind,note,created_by_admin_email,created_at";

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key = opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!url || !key) {
    const missing = !url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY";
    throw new Error(`_calendar-db: missing ${missing} — refusing to talk to Supabase without it.`);
  }
  return { url: String(url).replace(/\/+$/, ""), key, fetchImpl };
}
async function rest(path, { method = "GET", headers = {}, body } = {}, opts = {}) {
  const { url, key, fetchImpl } = config(opts);
  const res = await fetchImpl(`${url}/rest/v1${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) { const e = new Error(`_calendar-db REST ${method} ${path} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : null;
}

/* ---------- pure date math (UTC, YYYY-MM-DD strings) ---------- */
function toUtc(d) { const [y, m, dd] = String(d).split("-").map(Number); return Date.UTC(y, m - 1, dd); }
function fromUtc(t) { return new Date(t).toISOString().slice(0, 10); }
function isWeekday(t) { const w = new Date(t).getUTCDay(); return w >= 1 && w <= 5; }

/**
 * countedDays(entry, holidays, { year, region }) -> number
 * Weekdays in [start_day, end_day] ∩ year, minus holidays (ALL or region).
 */
function countedDays(entry, holidays = [], { year, region = "MX" } = {}) {
  if (!entry || !DATE_RE.test(entry.start_day) || !DATE_RE.test(entry.end_day)) return 0;
  const y = year || Number(String(entry.start_day).slice(0, 4));
  const lo = Math.max(toUtc(entry.start_day), Date.UTC(y, 0, 1));
  const hi = Math.min(toUtc(entry.end_day), Date.UTC(y, 11, 31));
  if (hi < lo) return 0;
  const hol = new Set((holidays || []).filter((h) => h && !h.deleted_at && (h.region === "ALL" || h.region === region)).map((h) => h.day));
  let n = 0;
  for (let t = lo; t <= hi; t += 86400000) {
    if (!isWeekday(t)) continue;
    if (HOLIDAYS_SUBTRACT && hol.has(fromUtc(t))) continue;
    n++;
  }
  return n;
}

/** allowanceFor(startDay, year) -> 6 | 3 | 0 (not started yet that year). */
function allowanceFor(startDay, year) {
  if (!DATE_RE.test(String(startDay || ""))) return VACATION_DAYS_PER_YEAR;
  const sy = Number(startDay.slice(0, 4));
  if (sy > year) return 0;
  if (sy === year && startDay.slice(5) >= LATE_START_FROM_MMDD) return FIRST_YEAR_LATE_START_DAYS;
  return VACATION_DAYS_PER_YEAR;
}
/** eligibleFrom(startDay) -> first day vacation may be taken (YYYY-MM-DD) | null. */
function eligibleFrom(startDay) {
  if (!DATE_RE.test(String(startDay || ""))) return null;
  return fromUtc(toUtc(startDay) + ELIGIBLE_AFTER_DAYS * 86400000);
}

/**
 * summarizeYear(entries, holidays, { year, region, startDay }) ->
 *   { year, allowance, eligible_from, used, remaining, entries:[{...entry, counted, before_eligible}] }
 * PURE. Only live vacation entries count. remaining never goes below 0 (an
 * admin may record more than the allowance; the counter says so plainly).
 */
function summarizeYear(entries, holidays, { year, region = "MX", startDay = null } = {}) {
  const y = year || new Date().getUTCFullYear();
  const allowance = allowanceFor(startDay, y);
  const eligible = eligibleFrom(startDay);
  let used = 0;
  const out = [];
  for (const e of entries || []) {
    if (!e || e.deleted_at) continue;
    const counted = e.kind === "vacation" ? countedDays(e, holidays, { year: y, region }) : 0;
    if (e.kind === "vacation") used += counted;
    out.push({ ...e, counted, before_eligible: !!(eligible && e.kind === "vacation" && e.start_day < eligible) });
  }
  return { year: y, allowance, eligible_from: eligible, used, remaining: Math.max(0, allowance - used), entries: out };
}

/** startDates(vaKeys?) -> { va_key: "YYYY-MM-DD" | null }. One read of profiles. */
async function startDates(vaKeys = null, opts = {}) {
  let q = "/profiles?select=va_key,start_date";
  if (Array.isArray(vaKeys) && vaKeys.length === 1) q += `&va_key=eq.${encodeURIComponent(vaKeys[0])}`;
  const rows = await rest(q, {}, opts);
  const map = {};
  for (const r of Array.isArray(rows) ? rows : []) if (r && r.va_key) map[r.va_key] = r.start_date || null;
  return map;
}

/* ---------- holidays ---------- */
async function listHolidays({ from, to } = {}, opts = {}) {
  let q = `${HOL}?select=${HOL_COLS}&deleted_at=is.null&order=day.asc`;
  if (from) q += `&day=gte.${from}`;
  if (to) q += `&day=lte.${to}`;
  const rows = await rest(q, {}, opts);
  return Array.isArray(rows) ? rows : [];
}
async function addHoliday({ day, name, region, created_by_admin_email }, opts = {}) {
  const rows = await rest(HOL, { method: "POST", headers: { Prefer: "return=representation" }, body: { day, name, region, created_by_admin_email } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function removeHoliday(id, by, opts = {}) {
  const rows = await rest(`${HOL}?id=eq.${encodeURIComponent(id)}&deleted_at=is.null`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: { deleted_at: new Date().toISOString(), deleted_by: by } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* ---------- time off ---------- */
async function listTimeOff({ va_key, year } = {}, opts = {}) {
  let q = `${TOF}?select=${TOF_COLS}&deleted_at=is.null&order=start_day.asc`;
  if (va_key) q += `&va_key=eq.${encodeURIComponent(va_key)}`;
  if (year) q += `&end_day=gte.${year}-01-01&start_day=lte.${year}-12-31`;
  const rows = await rest(q, {}, opts);
  return Array.isArray(rows) ? rows : [];
}
async function addTimeOff({ va_key, start_day, end_day, kind, note, created_by_admin_id, created_by_admin_email }, opts = {}) {
  const rows = await rest(TOF, { method: "POST", headers: { Prefer: "return=representation" }, body: { va_key, start_day, end_day, kind, note: note || null, created_by_admin_id, created_by_admin_email } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function removeTimeOff(id, by, opts = {}) {
  const rows = await rest(`${TOF}?id=eq.${encodeURIComponent(id)}&deleted_at=is.null`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: { deleted_at: new Date().toISOString(), deleted_by: by } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

module.exports = {
  VACATION_DAYS_PER_YEAR, FIRST_YEAR_LATE_START_DAYS, ELIGIBLE_AFTER_DAYS, HOLIDAYS_SUBTRACT, REGIONS, KINDS, DATE_RE,
  config, rest, countedDays, summarizeYear, allowanceFor, eligibleFrom, startDates,
  listHolidays, addHoliday, removeHoliday, listTimeOff, addTimeOff, removeTimeOff,
};
