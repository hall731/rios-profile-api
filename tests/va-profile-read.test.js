/**
 * va-profile-read.test.js — the VA-facing Profile read (Stage 2b).
 *
 * The load-bearing assertions: the verifier is fail-closed IN ORDER, a chat
 * token can never open a profile, the va_key comes only from the verified
 * claim, and the CLABE ciphertext / full number never leave the server.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { verifyProfileToken } = require("../netlify/functions/_profile-sso-verify");
const { getVaSafeProfile, maskClabe, SAFE_VA_COLS } = require("../netlify/functions/_profiles-db");

const SECRET = "profile-sso-test-secret";
const NOW = 1_800_000_000;
const mk = (over = {}, secret = SECRET) =>
  jwt.sign({ va_key: "Valentina Reyes", iat: NOW, exp: NOW + 90, aud: "rios-profile", iss: "rios-gate", jti: "j1", ...over }, secret);

function loadHandler(env = {}) {
  const base = { PROFILE_SSO_SECRET: SECRET, SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc", PROFILE_GATE_ORIGINS: undefined };
  for (const [k, v] of Object.entries({ ...base, ...env })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const p = require.resolve("../netlify/functions/va-profile-read");
  delete require.cache[p];
  return require("../netlify/functions/va-profile-read").handler;
}
const post = (token, headers = {}) => ({
  httpMethod: "POST",
  headers: { ...(token ? { authorization: "Bearer " + token } : {}), origin: "https://remoteinsightos.com", ...headers },
  body: "{}",
});

// A full profiles row as PostgREST would hand it back — including the columns
// that must NEVER reach a browser.
const ROW = {
  va_key: "Valentina Reyes", full_legal_name: "Valentina Reyes Torres",
  role: "Executive Assistant", start_date: "2024-03-01", engagement_type: "Independent Contractor",
  personal_email: "v@example.com", phone: "+52 33 1234 5678",
  address_line1: "Av. Chapultepec 480", address_line2: "Col. Centro", address_city: "Guadalajara",
  address_state: "Jalisco", address_postal_code: "44100", address_country: "México",
  emergency_contact_name: "Carmen Reyes", emergency_contact_relation: "Sibling", emergency_contact_phone: "+52 33 9876 5432",
  payment_bank_name: "BBVA", payment_clabe_last4: "4417", updated_at: "2026-09-01T10:00:00Z",
};
const SECRETS_THAT_MUST_NOT_LEAK = ["012345678901234417", "v1:deadbeefciphertext", "payment_clabe_encrypted"];

function dbStub(row, capture = {}) {
  return { url: "https://db.example.co", key: "svc", fetchImpl: async (url) => {
    capture.url = String(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(row ? [row] : []) };
  } };
}

// ── verifier: fail-closed, in order ────────────────────────────────────────
test("no secret => no_secret (never verify-less)", () => {
  assert.equal(verifyProfileToken({ token: mk(), secret: "", nowSec: NOW }).reason, "no_secret");
});
test("bad signature => signature", () => {
  assert.equal(verifyProfileToken({ token: mk({}, "wrong-secret"), secret: SECRET, nowSec: NOW }).reason, "signature");
});
test("missing claim => claims", () => {
  const t = jwt.sign({ iat: NOW, exp: NOW + 90, aud: "rios-profile", iss: "rios-gate" }, SECRET);
  assert.equal(verifyProfileToken({ token: t, secret: SECRET, nowSec: NOW }).reason, "claims");
});
test("expired beyond skew => expired", () => {
  assert.equal(verifyProfileToken({ token: mk(), secret: SECRET, nowSec: NOW + 200 }).reason, "expired");
});
test("A CHAT TOKEN CANNOT OPEN A PROFILE (aud is the boundary)", () => {
  const chatish = mk({ aud: "rios-chat" });
  assert.equal(verifyProfileToken({ token: chatish, secret: SECRET, nowSec: NOW }).reason, "aud");
});
test("wrong issuer => iss", () => {
  assert.equal(verifyProfileToken({ token: mk({ iss: "somewhere-else" }), secret: SECRET, nowSec: NOW }).reason, "iss");
});
test("valid token => the va_key comes from the CLAIM", () => {
  const out = verifyProfileToken({ token: mk(), secret: SECRET, nowSec: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.va_key, "Valentina Reyes");
});

// ── the read: whitelist + masking ──────────────────────────────────────────
test("the ciphertext column is never even SELECTED", async () => {
  const cap = {};
  await getVaSafeProfile("Valentina Reyes", dbStub(ROW, cap));
  assert.ok(!cap.url.includes("payment_clabe_encrypted"), "select list must not mention the ciphertext");
  assert.ok(!SAFE_VA_COLS.includes("payment_clabe_encrypted"));
  assert.ok(!SAFE_VA_COLS.includes("is_active"), "internal departed flag is not a VA field");
  assert.ok(!SAFE_VA_COLS.includes("dob"), "dob omitted for launch (open Q B)");
  assert.match(cap.url, /va_key=eq\./, "scoped to one VA");
  assert.match(cap.url, /limit=1/, "single row — no list on the VA side");
});

test("payment is masked: last4 + bank only, never the full number", async () => {
  const p = await getVaSafeProfile("Valentina Reyes", dbStub(ROW));
  assert.equal(p.payment.masked, "•••• 4417 · BBVA");
  const blob = JSON.stringify(p);
  for (const s of SECRETS_THAT_MUST_NOT_LEAK) assert.ok(!blob.includes(s), `must not contain ${s}`);
  assert.ok(!("payment_clabe_encrypted" in p.payment));
});

test("no last4 => 'not on file', never invented digits", () => {
  assert.equal(maskClabe(null, "BBVA"), null);
  assert.equal(maskClabe("12", "BBVA"), null, "a short value is not a mask");
  assert.equal(maskClabe("4417", ""), "•••• 4417");
});

test("a column added to the table later cannot leak (explicit literal, no spread)", async () => {
  const rogue = { ...ROW, secret_internal_note: "admin eyes only", payment_clabe_encrypted: "v1:deadbeefciphertext" };
  const p = await getVaSafeProfile("Valentina Reyes", dbStub(rogue));
  const blob = JSON.stringify(p);
  assert.ok(!blob.includes("admin eyes only"));
  assert.ok(!blob.includes("v1:deadbeefciphertext"));
});

// ── handler ────────────────────────────────────────────────────────────────
test("no token => generic 401 (and no DB call)", async () => {
  const h = loadHandler();
  let called = false;
  const r = await h(post(null), {}, { dbOpts: { url: "x", key: "y", fetchImpl: async () => { called = true; } } });
  assert.equal(r.statusCode, 401);
  assert.equal(JSON.parse(r.body).error, "Not authorized.");
  assert.equal(called, false, "nothing is read until the token proves identity");
});

test("every verification failure returns the SAME generic 401", async () => {
  const h = loadHandler();
  const bodies = [];
  for (const tok of [mk({}, "wrong"), mk({ aud: "rios-chat" }), mk({ iss: "x" })]) {
    const r = await h(post(tok), {}, { dbOpts: dbStub(ROW) });
    assert.equal(r.statusCode, 401);
    bodies.push(r.body);
  }
  assert.equal(new Set(bodies).size, 1, "the response never reveals WHICH step failed");
});

test("missing PROFILE_SSO_SECRET => 500, never a verify-less 200", async () => {
  const h = loadHandler({ PROFILE_SSO_SECRET: undefined });
  const r = await h(post(mk()), {}, { dbOpts: dbStub(ROW) });
  assert.equal(r.statusCode, 500);
});

test("valid token => masked profile, CORS set", async () => {
  const h = loadHandler();
  const r = await h(post(mk(), { origin: "https://remoteinsightos.com" }), {}, { dbOpts: dbStub(ROW) });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.ok, true);
  assert.equal(b.profile.payment.masked, "•••• 4417 · BBVA");
  assert.equal(b.profile.engagement.engagement_type, "Independent Contractor");
  assert.equal(r.headers["Access-Control-Allow-Origin"], "https://remoteinsightos.com");
  for (const s of SECRETS_THAT_MUST_NOT_LEAK) assert.ok(!r.body.includes(s));
});

/* ── The guard that would have caught the real bug ───────────────────────────
   Every test above stubs the HTTP layer, so they prove the code agrees with
   ITSELF. Nothing proved the column names agree with the DATABASE — and one of
   them ("preferred_name") did not exist, which 400s the whole read for every
   VA. This reads the migration and compares. */
test("SAFE_VA_COLS is a SUBSET of the real profiles table", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "supabase", "migrations", "20260824170000_va_profiles.sql"),
    "utf8"
  );
  const body = sql.slice(sql.indexOf("create table"));
  const real = new Set(
    body.slice(0, body.indexOf(");")).split("\n")
      .map((l) => (l.match(/^\s{2,}([a-z_][a-z0-9_]*)\s/) || [])[1])
      .filter(Boolean)
  );
  assert.ok(real.has("full_legal_name"), "sanity: the parse found real columns");
  const missing = SAFE_VA_COLS.filter((c) => !real.has(c));
  assert.deepEqual(missing, [],
    `these columns are selected but do not exist in the migration: ${missing.join(", ")}`);
});

test("the ciphertext and the audit table are absent from the REAL schema read", () => {
  assert.ok(!SAFE_VA_COLS.includes("payment_clabe_encrypted"));
  assert.ok(!SAFE_VA_COLS.some((c) => /history/.test(c)), "profile_history is never a VA surface");
});

/* ── CORS: an allowlist that echoes unknown origins is not an allowlist ─────── */
test("an unrecognised origin gets NO Allow-Origin header", async () => {
  const h = loadHandler();
  const r = await h(post(mk(), { origin: "https://evil.example.com" }), {}, { dbOpts: dbStub(ROW) });
  assert.equal(r.headers["Access-Control-Allow-Origin"], undefined,
    "never echo an unknown origin, and never fall back to the first allowed one");
});

/* The one that actually matters. va.remoteinsightos.com is where a real VA is
   served the gate — DNS says so, a CNAME to the gate's Netlify site. It was
   dropped from this list once because a review could not find the hostname in
   the source; a hostname's truth lives in DNS, not in grep. Without this entry
   the browser blocks every real VA's profile read. */
test("the REAL VA origin is allowed — without it no actual VA can load a profile", async () => {
  const h = loadHandler();
  const r = await h(post(mk(), { origin: "https://va.remoteinsightos.com" }), {}, { dbOpts: dbStub(ROW) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["Access-Control-Allow-Origin"], "https://va.remoteinsightos.com");
  assert.equal(JSON.parse(r.body).profile.payment.masked, "•••• 4417 · BBVA");
});

test("the apex and www stay allowed, in case the gate is moved there", async () => {
  const h = loadHandler();
  for (const o of ["https://remoteinsightos.com", "https://www.remoteinsightos.com"]) {
    const r = await h(post(mk(), { origin: o }), {}, { dbOpts: dbStub(ROW) });
    assert.equal(r.headers["Access-Control-Allow-Origin"], o);
  }
});

test("a sibling subdomain is NOT allowed just for sharing the domain", async () => {
  const h = loadHandler();
  for (const o of ["https://client.remoteinsightos.com", "https://app.remoteinsightos.com",
                   "https://va.remoteinsightos.com.evil.example"]) {
    const r = await h(post(mk(), { origin: o }), {}, { dbOpts: dbStub(ROW) });
    assert.equal(r.headers["Access-Control-Allow-Origin"], undefined, `${o} must not be echoed`);
  }
});

test("PROFILE_GATE_ORIGINS adds preview hosts, so a PR preview is reviewable", async () => {
  const preview = "https://deploy-preview-7--hall731-rios-gate.netlify.app";
  const h = loadHandler({ PROFILE_GATE_ORIGINS: " " + preview + " , https://other.example.com " });
  const r = await h(post(mk(), { origin: preview }), {}, { dbOpts: dbStub(ROW) });
  assert.equal(r.headers["Access-Control-Allow-Origin"], preview);
});

test("no profile row => honest empty state, not blank fields", async () => {
  const h = loadHandler();
  const r = await h(post(mk()), {}, { dbOpts: dbStub(null) });
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.profile, null);
  assert.equal(b.reason, "no_profile");
});

test("OPTIONS preflight is answered", async () => {
  const h = loadHandler();
  const r = await h({ httpMethod: "OPTIONS", headers: { origin: "https://remoteinsightos.com" } });
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

test("there is NO write path on this side", () => {
  const db = require("../netlify/functions/_profiles-db");
  for (const fn of ["saveProfile", "updateProfile", "setActive", "listProfiles"]) {
    assert.equal(db[fn], undefined, `${fn} must not exist in the VA read helper`);
  }
});
