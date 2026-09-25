/**
 * _events-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Append-only session telemetry for the `events` table
 * (supabase/migrations/20260924090000_events.sql). Service-role, server-side,
 * plain fetch over PostgREST — the same door as _admins-db.js.
 *
 * TWO RULES THAT MATTER MORE THAN THE DATA:
 *   1. `record()` NEVER THROWS. Telemetry must never break a login, a message
 *      send, or a page. Missing env, a 500 from Supabase, a bad shape — all
 *      become a console.warn and `false`. The caller does not await on the
 *      critical path unless it wants to.
 *   2. Nothing in `meta` is PII or content. No names, no emails, no message
 *      bodies, no document titles. Shape-only extras (a thread kind, a count).
 *
 * VOCABULARY (mirrors the CHECK constraints — change both or neither):
 *   audience : 'va' | 'client' | 'admin'
 *   kind     : 'login' | 'active' | 'surface' | 'message_sent' | 'logout'
 *   surface  : 'home' | 'va_read' | 'chat' | 'docs' | 'nps' | 'survey' |
 *              'profile' | 'calendar' | 'settings'
 *
 * WHO WRITES WHAT (so every stage emits the same shapes):
 *   admin  — admin-login.js writes `login` with the session `sid`; events.js
 *            `touch` writes `surface`/`active` from the dashboard.
 *   va     — Stage 3+: profile-api writes `login` when the gate mints a
 *            session; `surface`/`active`/`message_sent` from the gate/chat via
 *            profile-api. Never before the Stage-2 acknowledgment exists.
 *   client — Stage 4+: the same, from rios-client via profile-api.
 *
 * "Session duration" is DERIVED in summarize(): max(at) - min(at) per
 * session_id, capped at SESSION_CAP_SEC so an orphaned session (no logout, tab
 * left open) never reads as a day. This is analytics, not a stopwatch.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const crypto = require("node:crypto");

const TABLE = "/events";
const AUDIENCES = ["va", "client", "admin"];
const EVENT_KINDS = ["login", "active", "surface", "message_sent", "logout"];
const SURFACES = ["home", "va_read", "chat", "docs", "nps", "survey", "profile", "calendar", "settings"];

// Derivation constants (summarize). One place, named.
const SESSION_CAP_SEC = 8 * 60 * 60;          // an orphaned session never counts more than 8h
const SESSION_MIN_SEC = 30;                   // a lone login with no follow-up counts as 30s
const TIER_HIGH_PER_30D = 8;                  // >= 8 sessions / 30 days -> high
const TIER_MED_PER_30D = 3;                   // >= 3 -> med, else low

let warnedMissingEnv = false;

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key = opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  return { url, key, fetchImpl, ok: !!(url && key) };
}

/** newSessionId() — opaque, random, safe to put in a signed session token. */
function newSessionId() {
  return crypto.randomBytes(12).toString("hex");
}

/** Validate an event shape. Returns an error string or null. */
function validate(ev) {
  if (!ev || typeof ev !== "object") return "event must be an object";
  if (!AUDIENCES.includes(ev.audience)) return `bad audience: ${ev.audience}`;
  if (typeof ev.subject_key !== "string" || !ev.subject_key.trim()) return "subject_key required";
  if (!EVENT_KINDS.includes(ev.kind)) return `bad kind: ${ev.kind}`;
  if (ev.surface != null && !SURFACES.includes(ev.surface)) return `bad surface: ${ev.surface}`;
  if ((ev.kind === "surface" || ev.kind === "active") && !ev.surface) return `${ev.kind} needs a surface`;
  if (ev.session_id != null && (typeof ev.session_id !== "string" || ev.session_id.length > 64))
    return "session_id must be a short string";
  if (ev.meta != null && (typeof ev.meta !== "object" || Array.isArray(ev.meta))) return "meta must be an object";
  return null;
}

/**
 * record(ev, opts) -> Promise<boolean>. NEVER throws (rule 1 above).
 * ev: { audience, subject_key, kind, surface?, session_id?, meta?, at? }
 */
async function record(ev, opts = {}) {
  const bad = validate(ev);
  if (bad) {
    console.warn(`_events-db: dropped event — ${bad}`);
    return false;
  }
  const { url, key, fetchImpl, ok } = config(opts);
  if (!ok) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.warn("_events-db: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — telemetry disabled (nothing else is).");
    }
    return false;
  }
  const row = {
    audience: ev.audience,
    subject_key: ev.subject_key,
    kind: ev.kind,
    surface: ev.surface || null,
    session_id: ev.session_id || null,
    meta: ev.meta || {},
  };
  if (ev.at) row.at = ev.at;
  try {
    const res = await fetchImpl(`${url}/rest/v1${TABLE}`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.warn(`_events-db: insert failed (${res.status}) — event dropped, nothing else affected.`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`_events-db: insert threw (${e && e.message}) — event dropped, nothing else affected.`);
    return false;
  }
}

/**
 * listSince({ sinceIso, audience? }, opts) -> rows (throws on failure — this is
 * the admin read path, where a failure SHOULD surface).
 */
async function listSince({ sinceIso, audience } = {}, opts = {}) {
  const { url, key, fetchImpl, ok } = config(opts);
  if (!ok) throw new Error("_events-db: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.");
  if (!sinceIso) throw new Error("_events-db.listSince: sinceIso required");
  let q = `${TABLE}?select=at,audience,subject_key,session_id,kind,surface&at=gte.${encodeURIComponent(sinceIso)}&order=at.asc&limit=50000`;
  if (audience) {
    if (!AUDIENCES.includes(audience)) throw new Error(`_events-db.listSince: bad audience ${audience}`);
    q += `&audience=eq.${audience}`;
  }
  const res = await fetchImpl(`${url}/rest/v1${q}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const err = new Error(`_events-db REST GET failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  const rows = text ? JSON.parse(text) : [];
  return Array.isArray(rows) ? rows : [];
}

function tierFor(sessions, periodDays) {
  const per30 = periodDays > 0 ? (sessions * 30) / periodDays : sessions;
  if (per30 >= TIER_HIGH_PER_30D) return "high";
  if (per30 >= TIER_MED_PER_30D) return "med";
  return "low";
}

/**
 * summarize(rows, { periodDays }) -> [{ audience, subject_key, last_login,
 *   last_active, sessions, total_seconds, messages_sent, surfaces, tier }]
 * PURE. Sorted by last_active desc. One row per (audience, subject_key).
 */
function summarize(rows, { periodDays = 30 } = {}) {
  const users = new Map();
  for (const r of rows || []) {
    if (!r || !r.audience || !r.subject_key) continue;
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) continue;                 // a row with no usable time is noise, not a user
    const k = `${r.audience}\u0000${r.subject_key}`;
    let u = users.get(k);
    if (!u) {
      u = {
        audience: r.audience,
        subject_key: r.subject_key,
        last_login: null,
        last_active: null,
        sessions: 0,
        total_seconds: 0,
        messages_sent: 0,
        surfaces: new Set(),
        _sessions: new Map(),   // session_id -> { min, max }
        _loginsNoSid: 0,
      };
      users.set(k, u);
    }
    if (u.last_active == null || t > u.last_active) u.last_active = t;
    if (r.kind === "login" && (u.last_login == null || t > u.last_login)) u.last_login = t;
    if (r.kind === "message_sent") u.messages_sent += 1;
    if (r.surface) u.surfaces.add(r.surface);
    if (r.session_id) {
      const s = u._sessions.get(r.session_id) || { min: t, max: t };
      if (t < s.min) s.min = t;
      if (t > s.max) s.max = t;
      u._sessions.set(r.session_id, s);
    } else if (r.kind === "login") {
      u._loginsNoSid += 1;
    }
  }
  const out = [];
  for (const u of users.values()) {
    let secs = 0;
    for (const s of u._sessions.values()) {
      const d = Math.round((s.max - s.min) / 1000);
      secs += Math.min(SESSION_CAP_SEC, Math.max(SESSION_MIN_SEC, d));
    }
    secs += u._loginsNoSid * SESSION_MIN_SEC;
    const sessions = u._sessions.size + u._loginsNoSid;
    out.push({
      audience: u.audience,
      subject_key: u.subject_key,
      last_login: u.last_login == null ? null : new Date(u.last_login).toISOString(),
      last_active: u.last_active == null ? null : new Date(u.last_active).toISOString(),
      sessions,
      total_seconds: secs,
      messages_sent: u.messages_sent,
      surfaces: Array.from(u.surfaces).sort(),
      tier: tierFor(sessions, periodDays),
    });
  }
  out.sort((a, b) => (Date.parse(b.last_active || 0) || 0) - (Date.parse(a.last_active || 0) || 0));
  return out;
}

module.exports = {
  TABLE,
  AUDIENCES,
  EVENT_KINDS,
  SURFACES,
  SESSION_CAP_SEC,
  SESSION_MIN_SEC,
  TIER_HIGH_PER_30D,
  TIER_MED_PER_30D,
  config,
  newSessionId,
  validate,
  record,
  listSince,
  summarize,
  tierFor,
};
