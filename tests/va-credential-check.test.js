/**
 * va-credential-check.test.js — docs/stories/va-secure-login.md, criteria 1–4.
 * The credential check the gate calls server-to-server. Purpose-scoped token,
 * scrypt hashes only, non-enumerating failures, lockout, single-use passcode.
 * Fictional identities only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { resp } = require("./_helpers");
const { hashPassword } = require("../netlify/functions/_scrypt");

const SECRET = "profile-sso-test-secret";
const nowSec = () => Math.floor(Date.now() / 1000);
const mk = (over = {}, secret = SECRET) =>
  jwt.sign({ va_key: "Maya Restrepo", iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j1", ...over }, secret);
const cred = (over = {}) => mk({ purpose: "credentials", ...over });

function load(name, env = {}) {
  const base = { PROFILE_SSO_SECRET: SECRET, SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc", PROFILE_GATE_ORIGINS: undefined, CLIENT_SSO_SECRET: undefined };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const f of [name, "_profile-api-common", "_credentials-db", "_profiles-db", "_profile-sso-verify"]) { try { delete require.cache[require.resolve(`../netlify/functions/${f}`)]; } catch (e) {} }
  return require(`../netlify/functions/${name}`).handler;
}
const post = (token, body = {}) => ({ httpMethod: "POST", headers: { ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });

/** An in-memory va_credentials + va_credential_events store behind a PostgREST-shaped fetch. */
function store(row) {
  const st = { row: row ? { ...row } : null, patches: [], events: [] };
  st.fetchImpl = async (url, o = {}) => {
    const u = String(url);
    if (u.includes("/va_credential_events")) { st.events.push(JSON.parse(o.body)); return resp(201, []); }
    if (u.includes("/va_credentials")) {
      if ((o.method || "GET") === "GET") return resp(200, st.row ? [st.row] : []);
      if (o.method === "PATCH") { const p = JSON.parse(o.body); st.patches.push(p); if (st.row) Object.assign(st.row, p); return resp(200, [st.row]); }
    }
    return resp(404, { error: "no route " + u });
  };
  st.deps = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: st.fetchImpl } };
  return st;
}
const PASSCODE = "K7MX-4PQR-9WHT", PASSWORD = "sunny river tuesday";
// The store hashes the CANONICAL passcode (upper-case, letters+digits only), as the dashboard issues it.
const { canonPasscode } = require("../netlify/functions/_credentials-db");
const hashPasscode = () => hashPassword(canonPasscode(PASSCODE));
const future = () => new Date(Date.now() + 3 * 86400000).toISOString();
const past = () => new Date(Date.now() - 3600000).toISOString();

test("purpose claim: the credential endpoint refuses a plain profile token; profile-read and ack-status refuse a purpose token", async () => {
  const h = load("va-credential-check");
  const st = store(null);
  assert.equal((await h(post(mk(), { action: "login" }), {}, st.deps)).statusCode, 401, "no purpose -> 401");
  assert.equal((await h(post(cred({ purpose: "other" }), { action: "login" }), {}, st.deps)).statusCode, 401, "wrong purpose -> 401");
  assert.equal((await h(post(mk({ aud: "rios-chat", purpose: "credentials" }), { action: "login" }), {}, st.deps)).statusCode, 401);
  for (const name of ["va-profile-read", "ack-status"]) {
    const other = load(name);
    const r = await other(post(cred()), {}, { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async () => resp(200, []) } });
    assert.equal(r.statusCode, 401, name + " must refuse a credentials-purpose token");
  }
});

test("login: no row -> state none (nothing written); valid unexpired passcode -> state passcode, row untouched; right password -> state password", async () => {
  const h = load("va-credential-check");
  let st = store(null);
  let r = await h(post(cred(), { action: "login", secret: "anything" }), {}, st.deps);
  assert.equal(r.statusCode, 200); assert.deepEqual(JSON.parse(r.body), { ok: true, state: "none" }); assert.equal(st.patches.length, 0);
  st = store({ va_key: "Maya Restrepo", password_hash: null, temp_passcode_hash: await hashPasscode(), temp_expires_at: future(), must_reset: true, failed_attempts: 0, locked_until: null });
  r = await h(post(cred(), { action: "login", secret: PASSCODE }), {}, st.deps);
  assert.deepEqual(JSON.parse(r.body), { ok: true, state: "passcode" }); assert.equal(st.patches.length, 0, "a passcode check consumes nothing");
  r = await h(post(cred(), { action: "login", secret: " k7mx4pqr 9wht " }), {}, st.deps);
  assert.deepEqual(JSON.parse(r.body), { ok: true, state: "passcode" }, "lower-case, no dashes, stray spaces: still the same passcode");
  assert.equal(canonPasscode("k7mx-4pqr-9wht"), "K7MX4PQR9WHT");
  st = store({ va_key: "Maya Restrepo", password_hash: await hashPassword(PASSWORD), temp_passcode_hash: null, temp_expires_at: null, must_reset: false, failed_attempts: 2, locked_until: null });
  r = await h(post(cred(), { action: "login", secret: PASSWORD }), {}, st.deps);
  assert.deepEqual(JSON.parse(r.body), { ok: true, state: "password" });
  assert.equal(st.patches.length, 1); assert.equal(st.patches[0].failed_attempts, 0, "a good login clears the counter");
  assert.doesNotMatch(r.body, /scrypt\$|hash/);
});

test("login: wrong password, expired passcode, locked -> 401 { ok:false } and the counter climbs; the 10th failure locks for 15 minutes and records an event", async () => {
  const h = load("va-credential-check");
  let st = store({ va_key: "Maya Restrepo", password_hash: await hashPassword(PASSWORD), temp_passcode_hash: null, temp_expires_at: null, must_reset: false, failed_attempts: 0, locked_until: null });
  let r = await h(post(cred(), { action: "login", secret: "wrong password" }), {}, st.deps);
  assert.equal(r.statusCode, 401); assert.deepEqual(JSON.parse(r.body), { ok: false }); assert.equal(st.row.failed_attempts, 1); assert.equal(st.row.locked_until, null);
  st = store({ va_key: "Maya Restrepo", password_hash: null, temp_passcode_hash: await hashPasscode(), temp_expires_at: past(), must_reset: true, failed_attempts: 0, locked_until: null });
  r = await h(post(cred(), { action: "login", secret: PASSCODE }), {}, st.deps);
  assert.equal(r.statusCode, 401, "expired passcode"); assert.equal(st.row.failed_attempts, 1);
  st = store({ va_key: "Maya Restrepo", password_hash: await hashPassword(PASSWORD), temp_passcode_hash: null, temp_expires_at: null, must_reset: false, failed_attempts: 0, locked_until: future() });
  r = await h(post(cred(), { action: "login", secret: PASSWORD }), {}, st.deps);
  assert.equal(r.statusCode, 401, "locked: even the right password is refused"); assert.deepEqual(JSON.parse(r.body), { ok: false });
  st = store({ va_key: "Maya Restrepo", password_hash: await hashPassword(PASSWORD), temp_passcode_hash: null, temp_expires_at: null, must_reset: false, failed_attempts: 9, locked_until: null });
  r = await h(post(cred(), { action: "login", secret: "wrong again" }), {}, st.deps);
  assert.equal(r.statusCode, 401); assert.equal(st.row.failed_attempts, 10);
  const until = Date.parse(st.row.locked_until); assert.ok(until > Date.now() + 14 * 60000 && until < Date.now() + 16 * 60000, "15 minute lock");
  assert.deepEqual(st.events.map((e) => e.kind), ["locked"]);
});

test("set_password: valid passcode + good password -> hash stored, passcode cleared in the same update, must_reset false, counters reset, event; bad passcode -> 401 nothing written; weak -> 400 nothing written", async () => {
  const h = load("va-credential-check");
  const fresh = async () => store({ va_key: "Maya Restrepo", password_hash: null, temp_passcode_hash: await hashPasscode(), temp_expires_at: future(), must_reset: true, failed_attempts: 3, locked_until: null });
  let st = await fresh();
  let r = await h(post(cred(), { action: "set_password", passcode: PASSCODE, new_password: PASSWORD }), {}, st.deps);
  assert.equal(r.statusCode, 200, r.body); assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(st.patches.length, 1); const p = st.patches[0];
  assert.match(p.password_hash, /^scrypt\$/); assert.equal(p.temp_passcode_hash, null); assert.equal(p.temp_expires_at, null);
  assert.equal(p.must_reset, false); assert.equal(p.failed_attempts, 0); assert.equal(p.locked_until, null); assert.ok(p.password_set_at);
  assert.deepEqual(st.events.map((e) => e.kind), ["password_set"]);
  const { verifyPassword } = require("../netlify/functions/_scrypt");
  assert.equal(await verifyPassword(PASSWORD, p.password_hash), true); assert.equal(await verifyPassword(PASSCODE, p.password_hash), false);
  st = await fresh();
  r = await h(post(cred(), { action: "set_password", passcode: "XXXX-XXXX-XXXX", new_password: PASSWORD }), {}, st.deps);
  assert.equal(r.statusCode, 401); assert.deepEqual(JSON.parse(r.body), { ok: false }); assert.equal(st.patches.filter((x) => x.password_hash).length, 0);
  st = await fresh();
  r = await h(post(cred(), { action: "set_password", passcode: PASSCODE, new_password: "short" }), {}, st.deps);
  assert.equal(r.statusCode, 400); assert.equal(JSON.parse(r.body).reason, "weak"); assert.equal(st.patches.length, 0);
  st = await fresh();
  r = await h(post(cred(), { action: "set_password", passcode: PASSCODE, new_password: PASSCODE }), {}, st.deps);
  assert.equal(r.statusCode, 400, "a password equal to the passcode is refused"); assert.equal(st.patches.length, 0);
  st = await fresh();
  r = await h(post(cred(), { action: "set_password", passcode: PASSCODE, new_password: "x".repeat(201) }), {}, st.deps);
  assert.equal(r.statusCode, 400); assert.equal(st.patches.length, 0);
});

test("shape: unknown action -> 400; a DB failure -> 502 generic; no body ever carries a hash or the secrets sent in", async () => {
  const h = load("va-credential-check");
  const st = store(null);
  assert.equal((await h(post(cred(), { action: "nope" }), {}, st.deps)).statusCode, 400);
  const down = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async () => resp(500, { error: "boom" }) } };
  const r = await h(post(cred(), { action: "login", secret: PASSWORD }), {}, down);
  assert.equal(r.statusCode, 502); assert.doesNotMatch(r.body, new RegExp(PASSWORD));
});
