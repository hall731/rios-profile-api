/**
 * _credentials-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * The VA credential store (va_credentials + va_credential_events,
 * supabase/migrations/20261007150000_va_credentials.sql;
 * docs/stories/va-secure-login.md). Service-role, server-side, over the same
 * PostgREST door as _profiles-db.js.
 *
 * WHAT NEVER HAPPENS HERE: a plaintext password or passcode is never stored,
 * logged, or returned. Only scrypt hashes go in; only { ok, state } comes out.
 *
 * States for login(): "none" (no row — the gate treats this as a legacy VA),
 * "password" (the stored password verified), "passcode" (the stored temporary
 * passcode verified and is unexpired — NOT consumed here; set_password consumes
 * it). Every other outcome is { ok:false } with the counter bumped, and the
 * 10th consecutive failure locks the row for 15 minutes.
 */

const { rest } = require("./_profiles-db");
const { hashPassword, verifyPassword } = require("./_scrypt");

const TABLE = "/va_credentials";
const EVENTS = "/va_credential_events";
const MAX_FAILED = 10;
const LOCK_MINUTES = 15;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

async function getCredentials(vaKey, opts = {}) {
  const rows = await rest(`${TABLE}?select=*&va_key=eq.${encodeURIComponent(vaKey)}&limit=1`, {}, opts);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function patch(vaKey, fields, opts = {}) {
  return rest(`${TABLE}?va_key=eq.${encodeURIComponent(vaKey)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: { ...fields, updated_at: new Date().toISOString() },
  }, opts);
}

/** Audit row. Best effort: never throws, never carries a secret. */
async function recordEvent(vaKey, kind, actorAdminEmail, opts = {}) {
  try {
    await rest(EVENTS, { method: "POST", headers: { Prefer: "return=minimal" }, body: { va_key: vaKey, kind, actor_admin_email: actorAdminEmail || null } }, opts);
    return true;
  } catch (e) {
    console.warn(`_credentials-db: event ${kind} for a VA not recorded — ${e && e.message}`);
    return false;
  }
}

function isLocked(row, nowMs) {
  const t = row && row.locked_until ? Date.parse(row.locked_until) : NaN;
  return Number.isFinite(t) && t > nowMs;
}
function passcodeLive(row, nowMs) {
  if (!row || !row.temp_passcode_hash) return false;
  const t = row.temp_expires_at ? Date.parse(row.temp_expires_at) : NaN;
  return Number.isFinite(t) && t > nowMs;
}

/** One more failure: bump the counter; at MAX_FAILED lock for LOCK_MINUTES and record it. */
async function noteFailure(row, opts = {}, nowMs = Date.now()) {
  const n = (Number(row.failed_attempts) || 0) + 1;
  const fields = { failed_attempts: n };
  if (n >= MAX_FAILED) fields.locked_until = new Date(nowMs + LOCK_MINUTES * 60000).toISOString();
  await patch(row.va_key, fields, opts);
  if (n >= MAX_FAILED) await recordEvent(row.va_key, "locked", null, opts);
  return { ok: false };
}

/**
 * login({ vaKey, secret }) -> { ok:true, state:"none"|"password"|"passcode" } | { ok:false }
 * `secret` is whatever the VA typed in the one "password or temporary passcode"
 * field. Which it is gets decided by the row, never by the caller.
 */
async function login({ vaKey, secret }, opts = {}, nowMs = Date.now()) {
  const row = await getCredentials(vaKey, opts);
  if (!row) return { ok: true, state: "none" };
  if (isLocked(row, nowMs)) return { ok: false };
  const typed = typeof secret === "string" ? secret : "";
  if (!typed) return noteFailure(row, opts, nowMs);

  if (row.password_hash && !row.must_reset) {
    if (await verifyPassword(typed, row.password_hash)) {
      if (Number(row.failed_attempts) || row.locked_until) await patch(vaKey, { failed_attempts: 0, locked_until: null }, opts);
      return { ok: true, state: "password" };
    }
    return noteFailure(row, opts, nowMs);
  }
  if (passcodeLive(row, nowMs)) {
    if (await verifyPassword(typed, row.temp_passcode_hash)) return { ok: true, state: "passcode" };
    return noteFailure(row, opts, nowMs);
  }
  // A row with nothing live (expired passcode, or reset in progress): fail closed.
  return noteFailure(row, opts, nowMs);
}

function passwordProblem(newPassword, passcode) {
  if (typeof newPassword !== "string") return "weak";
  if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) return "weak";
  if (passcode && newPassword === passcode) return "weak";
  return null;
}

/**
 * setPassword({ vaKey, passcode, newPassword }) ->
 *   { ok:true } | { ok:false } (bad/expired passcode, locked) | { ok:false, reason:"weak" }
 * ONE update stores the hash and clears the passcode, so the passcode is
 * single-use by construction.
 */
async function setPassword({ vaKey, passcode, newPassword }, opts = {}, nowMs = Date.now()) {
  const row = await getCredentials(vaKey, opts);
  if (!row) return { ok: false };
  if (isLocked(row, nowMs)) return { ok: false };
  const typed = typeof passcode === "string" ? passcode : "";
  if (!typed || !passcodeLive(row, nowMs) || !(await verifyPassword(typed, row.temp_passcode_hash))) return noteFailure(row, opts, nowMs);
  const problem = passwordProblem(newPassword, typed);
  if (problem) return { ok: false, reason: problem };
  const password_hash = await hashPassword(newPassword);
  await patch(vaKey, {
    password_hash,
    password_set_at: new Date(nowMs).toISOString(),
    temp_passcode_hash: null,
    temp_expires_at: null,
    must_reset: false,
    failed_attempts: 0,
    locked_until: null,
  }, opts);
  await recordEvent(vaKey, "password_set", null, opts);
  return { ok: true };
}

module.exports = { login, setPassword, getCredentials, recordEvent, passwordProblem, MAX_FAILED, LOCK_MINUTES, PASSWORD_MIN, PASSWORD_MAX };
