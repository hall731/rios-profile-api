/**
 * _ack-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Service-role access to `acknowledgments`
 * (supabase/migrations/20260924100000_acknowledgments.sql). Same door as
 * _admins-db.js: plain fetch over PostgREST, config read at call time,
 * injectable for tests.
 *
 * FAIL CLOSED. Unlike telemetry, this is a GATE: if we cannot read whether a
 * person acknowledged the current document, they have not — the caller shows
 * the acknowledgment screen again. Missing env throws; a REST failure throws.
 * Nothing here ever returns "acknowledged" on a doubt.
 *
 * Identity discipline: subject_key is the canonical key for the audience and is
 * ALWAYS server-derived by the caller (a verified token claim, an admin
 * session) — never a request body value.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const docs = require("./_ack-docs");

const TABLE = "/acknowledgments";
const COLS = "id,audience,subject_key,doc_version,doc_sha256,accepted_at";

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key = opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!url || !key) {
    const missing = !url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY";
    throw new Error(`_ack-db: missing ${missing} — refusing to talk to Supabase without it.`);
  }
  return { url, key, fetchImpl };
}

async function rest(path, { method = "GET", headers = {}, body } = {}, opts = {}) {
  const { url, key, fetchImpl } = config(opts);
  const res = await fetchImpl(`${url}/rest/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`_ack-db REST ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function requireAudience(audience) {
  if (!docs.AUDIENCES.includes(audience)) throw new Error(`_ack-db: unknown audience ${audience}`);
}
function requireSubject(subject_key) {
  if (typeof subject_key !== "string" || !subject_key.trim()) throw new Error("_ack-db: subject_key required");
}

/** latest({ audience, subject_key }) -> newest row | null. Throws on failure. */
async function latest({ audience, subject_key } = {}, opts = {}) {
  requireAudience(audience);
  requireSubject(subject_key);
  const rows = await rest(
    `${TABLE}?audience=eq.${audience}&subject_key=eq.${encodeURIComponent(subject_key)}&select=${COLS}&order=accepted_at.desc&limit=1`,
    {},
    opts
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * status({ audience, subject_key }) ->
 *   { acknowledged:boolean, current:{version,sha256,draft}, accepted:{version,at}|null }
 * acknowledged is true ONLY when the newest row's version AND sha match the
 * current document. Throws on failure (fail closed at the caller).
 */
async function status({ audience, subject_key } = {}, opts = {}) {
  const cur = docs.current(audience);
  if (!cur) throw new Error(`_ack-db: unknown audience ${audience}`);
  const row = await latest({ audience, subject_key }, opts);
  const acknowledged = !!row && row.doc_version === cur.version && row.doc_sha256 === cur.sha256;
  return {
    acknowledged,
    current: { version: cur.version, sha256: cur.sha256, draft: cur.draft },
    accepted: row ? { version: row.doc_version, at: row.accepted_at } : null,
  };
}

/**
 * record({ audience, subject_key, doc_version, doc_sha256 }) -> row.
 * Refuses (throws) unless version+sha equal the CURRENT document — a stale
 * client cannot log acceptance of text that is no longer shown.
 */
async function record({ audience, subject_key, doc_version, doc_sha256 } = {}, opts = {}) {
  const cur = docs.current(audience);
  if (!cur) throw new Error(`_ack-db: unknown audience ${audience}`);
  requireSubject(subject_key);
  if (doc_version !== cur.version || doc_sha256 !== cur.sha256) {
    const err = new Error("_ack-db: acknowledgment does not match the current document (stale version or text)");
    err.status = 409;
    throw err;
  }
  const rows = await rest(
    TABLE,
    {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: { audience, subject_key, doc_version, doc_sha256 },
    },
    opts
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** listLatest({ audience? }) -> newest row per (audience, subject_key), annotated `current`. Admin use. */
async function listLatest({ audience } = {}, opts = {}) {
  let q = `${TABLE}?select=${COLS}&order=accepted_at.desc&limit=20000`;
  if (audience) {
    requireAudience(audience);
    q += `&audience=eq.${audience}`;
  }
  const rows = (await rest(q, {}, opts)) || [];
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.audience}\u0000${r.subject_key}`;
    if (seen.has(k)) continue;           // rows arrive newest-first
    const cur = docs.current(r.audience);
    seen.set(k, { ...r, current: !!cur && r.doc_version === cur.version && r.doc_sha256 === cur.sha256 });
  }
  return Array.from(seen.values());
}

module.exports = { TABLE, COLS, config, rest, latest, status, record, listLatest };
