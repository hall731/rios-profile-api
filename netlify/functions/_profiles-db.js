/**
 * _profiles-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Service-role data access for the `profiles` table. Mirrors `_admins-db.js`:
 * plain fetch over PostgREST, no @supabase/supabase-js, config read at CALL
 * time and injectable via `opts` so it is trivially stubbable in tests.
 *
 * THIS FILE IS THE READ HALF (VA self-view, Stage 2b). The admin write half
 * (saveProfile / set-active / rename) is Stage 2a — same file, separate
 * functions, added later.
 *
 * THE WHITELIST IS THE SECURITY BOUNDARY (spec §2.1/§2.2):
 *   - We select ONLY `SAFE_VA_COLS`. `payment_clabe_encrypted` is never in the
 *     select list, so the ciphertext never leaves the database — there is no
 *     decrypt path on the VA side and no "reveal CLABE" endpoint at all.
 *   - The returned object is built as an EXPLICIT LITERAL. No row is ever
 *     spread, so a column added to the table later cannot leak by accident.
 *   - `profile_history` (audit), `is_active` (departed flag) and `id` are
 *     admin-only / internal and are never selected.
 *   - The query is `va_key=eq.<verified claim>` with a single-row limit: a VA
 *     can only ever read themselves, and no `list` exists on this side.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const TABLE = "/profiles";

// Exactly the columns a VA may see about themselves. Note what is ABSENT:
// payment_clabe_encrypted, dob, is_active, id, and every other VA's row.
// `dob` is deliberately omitted for launch (spec open question B) — it is the
// VA's own datum but adds shoulder-surf surface for little value.
//
// EVERY NAME HERE MUST EXIST IN supabase/migrations/20260824170000_va_profiles.sql.
// PostgREST answers an unknown column in `select=` with a 400, so a name that
// drifts from the schema does not degrade — it kills the whole read for every
// VA. `tests/va-profile-read.test.js` reads the migration and asserts this list
// is a subset of it, because a human comparing two lists by eye is exactly how
// `htqv3` happened.
const SAFE_VA_COLS = [
  "va_key",
  "full_legal_name",
  "role",
  "start_date",
  "engagement_type",
  "personal_email",
  "phone",
  "address_line1",
  "address_line2",
  "address_city",
  "address_state",
  "address_postal_code",
  "address_country",
  "emergency_contact_name",
  "emergency_contact_relation",
  "emergency_contact_phone",
  "payment_bank_name",
  "payment_clabe_last4",
];

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key =
    opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!url || !key) {
    const missing = !url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY";
    throw new Error(
      `_profiles-db: missing ${missing} — refusing to talk to Supabase without it. ` +
        "This is a server misconfiguration, not empty data."
    );
  }
  return { url: String(url).replace(/\/+$/, ""), key, fetchImpl };
}

async function rest(path, { method = "GET", headers = {}, body } = {}, opts = {}) {
  const { url, key, fetchImpl } = config(opts);
  const res = await fetchImpl(`${url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`profiles ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * maskClabe(last4, bank) — the single source of truth for payment display.
 * The browser only ever receives last4 + bank name (both stored plaintext);
 * the full 18-digit CLABE is never reconstructed, decrypted, or sent.
 */
function maskClabe(last4, bank) {
  const l4 = String(last4 == null ? "" : last4).trim();
  if (!/^[0-9]{4}$/.test(l4)) return null;       // never invent digits
  const b = String(bank == null ? "" : bank).trim();
  return b ? `•••• ${l4} · ${b}` : `•••• ${l4}`;
}

/**
 * getVaSafeProfile(va_key, opts) -> { ...safe, payment: {...masked} } | null
 * One row, this VA only, whitelisted columns, masked payment. Returns null when
 * the VA has no profile row yet (the caller renders an honest empty state —
 * never a skeleton of blank fields).
 */
async function getVaSafeProfile(vaKey, opts = {}) {
  const key = String(vaKey == null ? "" : vaKey).trim();
  if (!key) return null;
  const q = `${TABLE}?select=${SAFE_VA_COLS.join(",")}&va_key=eq.${encodeURIComponent(key)}&limit=1`;
  const rows = await rest(q, {}, opts);
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r) return null;

  // EXPLICIT LITERAL — never spread the row.
  return {
    va_key: r.va_key ?? null,
    identity: {
      full_legal_name: r.full_legal_name ?? null,
      role: r.role ?? null,
      start_date: r.start_date ?? null,
    },
    engagement: {
      engagement_type: r.engagement_type ?? "Independent Contractor",
    },
    contact: {
      personal_email: r.personal_email ?? null,
      phone: r.phone ?? null,
    },
    address: {
      line1: r.address_line1 ?? null,
      line2: r.address_line2 ?? null,
      city: r.address_city ?? null,
      state: r.address_state ?? null,
      postal_code: r.address_postal_code ?? null,
      country: r.address_country ?? null,
    },
    emergency: {
      name: r.emergency_contact_name ?? null,
      relation: r.emergency_contact_relation ?? null,
      phone: r.emergency_contact_phone ?? null,
    },
    payment: {
      // masked ONLY. No ciphertext, no full number, ever.
      bank_name: r.payment_bank_name ?? null,
      last4: r.payment_clabe_last4 ?? null,
      masked: maskClabe(r.payment_clabe_last4, r.payment_bank_name),
    },
  };
}

module.exports = { getVaSafeProfile, maskClabe, SAFE_VA_COLS, rest, config };
