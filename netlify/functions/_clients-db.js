/**
 * _clients-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Service-role access to `clients`, `client_assignments`, `client_history`
 * (supabase/migrations/20260924110000_clients.sql). Same door as
 * _admins-db.js: plain fetch over PostgREST, config read at call time,
 * injectable via opts for tests.
 *
 * Two callers, two halves:
 *   ADMIN (dashboard clients.js)   — everything.
 *   DOOR  (profile-api client-login) — matchClient() + liveVaKeys() only.
 *   BRIDGE (dashboard save-settings) — liveAssignmentsByVa() + clientsByEmail().
 *
 * Identity discipline: the login trio is stored AS ENTERED; matching folds
 * with norm() (byte-identical to _cfgKey / client-auth.js / _va-login.js);
 * the identity any surface carries is clients.id.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const CLIENTS = "/clients";
const ASSIGN = "/client_assignments";
const HISTORY = "/client_history";
const CLIENT_COLS = "id,first_name,last_name,email,company,is_active,created_by_admin_email,created_at,updated_at";
const ASSIGN_COLS = "id,client_id,va_key,assigned_at,assigned_by_admin_email,unassigned_at,unassigned_by";

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key = opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!url || !key) {
    const missing = !url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY";
    throw new Error(`_clients-db: missing ${missing} — refusing to talk to Supabase without it.`);
  }
  return { url: String(url).replace(/\/+$/, ""), key, fetchImpl };
}

async function rest(path, { method = "GET", headers = {}, body } = {}, opts = {}) {
  const { url, key, fetchImpl } = config(opts);
  const res = await fetchImpl(`${url}/rest/v1${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`_clients-db REST ${method} ${path} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/* Same normalisation as _cfgKey() in the admin dashboard, norm() in
   save-settings.js, client-auth.js (rios-client) and _va-login.js (gate).
   Forgiving about case, accents, spacing. Never about spelling. */
const norm = (s) => String(s || "").trim().toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

/** view(row) — explicit literal for the admin UI. */
function view(r) {
  if (!r) return null;
  return {
    id: r.id, first_name: r.first_name, last_name: r.last_name, email: r.email,
    company: r.company ?? null, is_active: r.is_active !== false,
    created_at: r.created_at ?? null, updated_at: r.updated_at ?? null,
  };
}

async function listClients(opts = {}) {
  const rows = await rest(`${CLIENTS}?select=${CLIENT_COLS}&order=last_name.asc,first_name.asc`, {}, opts);
  return Array.isArray(rows) ? rows : [];
}
async function getClient(id, opts = {}) {
  const rows = await rest(`${CLIENTS}?id=eq.${encodeURIComponent(id)}&select=${CLIENT_COLS}&limit=1`, {}, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function insertClient(fields, opts = {}) {
  const rows = await rest(CLIENTS, { method: "POST", headers: { Prefer: "return=representation" }, body: fields }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function updateClient(id, patch, opts = {}) {
  const body = { ...patch, updated_at: new Date().toISOString() };
  const rows = await rest(`${CLIENTS}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/** listAssignments({ client_id?, live? }) */
async function listAssignments({ client_id, live } = {}, opts = {}) {
  let q = `${ASSIGN}?select=${ASSIGN_COLS}&order=assigned_at.desc`;
  if (client_id) q += `&client_id=eq.${encodeURIComponent(client_id)}`;
  if (live) q += `&unassigned_at=is.null`;
  const rows = await rest(q, {}, opts);
  return Array.isArray(rows) ? rows : [];
}
async function insertAssignment({ client_id, va_key, assigned_by_admin_email }, opts = {}) {
  const rows = await rest(ASSIGN, { method: "POST", headers: { Prefer: "return=representation" }, body: { client_id, va_key, assigned_by_admin_email } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function tombstoneAssignment(id, by, opts = {}) {
  const rows = await rest(
    `${ASSIGN}?id=eq.${encodeURIComponent(id)}&unassigned_at=is.null`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: { unassigned_at: new Date().toISOString(), unassigned_by: by } },
    opts
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function appendHistory(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return;
  await rest(HISTORY, { method: "POST", headers: { Prefer: "return=minimal" }, body: rows }, opts);
}
async function listHistory(client_id, opts = {}) {
  const rows = await rest(`${HISTORY}?select=field,old_value,new_value,changed_by_admin_email,changed_at&client_id=eq.${encodeURIComponent(client_id)}&order=changed_at.desc&limit=500`, {}, opts);
  return Array.isArray(rows) ? rows : [];
}

/* ---------- THE DOOR (profile-api client-login) ---------- */

/**
 * matchClient({ first, last, email }) -> row | null. Throws AMBIGUOUS_CLIENT
 * when >1 live client matches (never guess). Blank fields never match.
 */
async function matchClient({ first, last, email } = {}, opts = {}) {
  const f = norm(first), l = norm(last), e = norm(email);
  if (!f || !l || !e) return null;
  const rows = await rest(`${CLIENTS}?select=${CLIENT_COLS}&is_active=eq.true`, {}, opts);
  const hits = (Array.isArray(rows) ? rows : []).filter((r) => norm(r.first_name) === f && norm(r.last_name) === l && norm(r.email) === e);
  if (hits.length > 1) {
    const err = new Error(`_clients-db: login trio matches ${hits.length} live clients — refusing to guess`);
    err.code = "AMBIGUOUS_CLIENT";
    throw err;
  }
  return hits[0] || null;
}

/** liveVaKeys(client_id) -> [va_key...] for the client's live assignments. */
async function liveVaKeys(client_id, opts = {}) {
  const rows = await listAssignments({ client_id, live: true }, opts);
  return rows.map((r) => r.va_key);
}

/* ---------- THE BRIDGE (save-settings publish overlay) ---------- */

/** liveAssignmentsByVa() -> Map<norm(va_key), { va_key, client:{first,last,email} }> */
async function liveAssignmentsByVa(opts = {}) {
  const [assigns, clients] = await Promise.all([listAssignments({ live: true }, opts), listClients(opts)]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const out = new Map();
  for (const a of assigns) {
    const c = byId.get(a.client_id);
    if (!c || c.is_active === false) continue;
    out.set(norm(a.va_key), { va_key: a.va_key, client: { first: c.first_name, last: c.last_name, email: c.email } });
  }
  return out;
}

/** clientsByEmail() -> Set<norm(email)> of EVERY client row (active or not) — "managed in Clients". */
async function clientsByEmail(opts = {}) {
  const clients = await listClients(opts);
  return new Set(clients.map((c) => norm(c.email)));
}

module.exports = {
  CLIENTS, ASSIGN, HISTORY, CLIENT_COLS, ASSIGN_COLS, config, rest, norm, view,
  listClients, getClient, insertClient, updateClient,
  listAssignments, insertAssignment, tombstoneAssignment, appendHistory, listHistory,
  matchClient, liveVaKeys, liveAssignmentsByVa, clientsByEmail,
};
