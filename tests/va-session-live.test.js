/**
 * va-session-live.test.js — docs/stories/session-bound-to-credentials.md.
 * The gate asks profile-api, on every authenticated request, whether a gate
 * session is still live: the VA still has a va_credentials row AND the session
 * was issued at or after that row's created_at. The answer is a bare boolean;
 * nothing about the row leaves profile-api. Fictional identities only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { resp } = require("./_helpers");

const SECRET = "profile-sso-test-secret";
const nowSec = () => Math.floor(Date.now() / 1000);
const mk = (over = {}, secret = SECRET) =>
  jwt.sign({ va_key: "Maya Restrepo", iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j1", ...over }, secret);
const cred = (over = {}) => mk({ purpose: "credentials", ...over });

function load(env = {}) {
  const base = { PROFILE_SSO_SECRET: SECRET, SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc", PROFILE_GATE_ORIGINS: undefined, CLIENT_SSO_SECRET: undefined };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const f of ["va-credential-check", "_profile-api-common", "_credentials-db", "_profiles-db", "_profile-sso-verify"]) { try { delete require.cache[require.resolve(`../netlify/functions/${f}`)]; } catch (e) {} }
  return require("../netlify/functions/va-credential-check").handler;
}
const post = (token, body = {}) => ({ httpMethod: "POST", headers: { ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });

/** A va_credentials store that records every request it sees. */
function store(row, { fail = false } = {}) {
  const st = { row: row ? { ...row } : null, gets: [], writes: 0 };
  st.fetchImpl = async (url, o = {}) => {
    const u = String(url), m = o.method || "GET";
    if (fail) return resp(503, { message: "down" });
    if (m !== "GET") { st.writes++; return resp(200, []); }
    if (u.includes("/va_credentials")) { st.gets.push(u); return resp(200, st.row ? [st.row] : []); }
    return resp(404, { error: "no route " + u });
  };
  st.deps = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: st.fetchImpl } };
  return st;
}
const CREATED = "2026-10-09T15:00:00.400Z";            // the row an admin created by issuing a code
const createdSec = Math.floor(Date.parse(CREATED) / 1000);
const ROW = { va_key: "Maya Restrepo", created_at: CREATED, password_hash: "scrypt$x", temp_passcode_hash: null, must_reset: false };
const ask = async (st, body) => { const r = await load()(post(cred(), { action: "session", ...body }), {}, st.deps); return { status: r.statusCode, body: JSON.parse(r.body), raw: r.body }; };

test("no credentials row (wiped, or never issued) -> live:false; nothing written", async () => {
  const st = store(null);
  const r = await ask(st, { iat: nowSec() });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, live: false });
  assert.equal(st.writes, 0);
});

test("a session issued BEFORE the row was created is dead; at or after it is live (second precision)", async () => {
  const st = store(ROW);
  assert.deepEqual((await ask(st, { iat: createdSec - 3600 })).body, { ok: true, live: false }, "a pre-wipe session against a re-issued row");
  assert.deepEqual((await ask(st, { iat: createdSec - 1 })).body, { ok: true, live: false });
  assert.deepEqual((await ask(st, { iat: createdSec })).body, { ok: true, live: true }, "the same second counts (iat is whole seconds)");
  assert.deepEqual((await ask(st, { iat: createdSec + 600 })).body, { ok: true, live: true }, "signed in after the code was issued");
});

test("a missing or malformed iat reads as a dead session (legacy tokens are expired)", async () => {
  const st = store(ROW);
  for (const iat of [undefined, null, "", "abc", NaN, -1, 1.5e20, {}]) {
    const r = await ask(st, iat === undefined ? {} : { iat });
    assert.equal(r.status, 200, String(iat)); assert.deepEqual(r.body, { ok: true, live: false }, String(iat));
  }
});

test("the answer is a bare boolean: no created_at, no hash, no row field leaves profile-api; the read selects created_at only", async () => {
  const st = store(ROW);
  const r = await ask(st, { iat: createdSec + 5 });
  assert.deepEqual(Object.keys(r.body).sort(), ["live", "ok"]);
  assert.doesNotMatch(r.raw, /scrypt|created|2026-10-09|hash/);
  assert.equal(st.gets.length, 1);
  assert.match(st.gets[0], /select=created_at(&|$)/, "never select=* for a session check");
  assert.match(st.gets[0], /va_key=eq\.Maya%20Restrepo/, "identity from the verified claim");
});

test("identity comes only from the verified token: a va_key in the body is ignored", async () => {
  const st = store(ROW);
  await ask(st, { iat: createdSec + 5, va_key: "Tomás Ibarra" });
  assert.match(st.gets[0], /va_key=eq\.Maya%20Restrepo/);
  assert.doesNotMatch(st.gets[0], /Tom/);
});

test("purpose-scoped like the rest of the check: a plain profile token or a wrong audience is refused", async () => {
  const st = store(ROW);
  const h = load();
  assert.equal((await h(post(mk(), { action: "session", iat: nowSec() }), {}, st.deps)).statusCode, 401);
  assert.equal((await h(post(mk({ aud: "rios-chat", purpose: "credentials" }), { action: "session", iat: nowSec() }), {}, st.deps)).statusCode, 401);
  assert.equal(st.gets.length, 0, "refused before any read");
});

test("store unreachable -> 502 (the gate refuses the request without signing the VA out)", async () => {
  const st = store(ROW, { fail: true });
  const quiet = console.error; console.error = () => {};
  try {
    const r = await ask(st, { iat: nowSec() });
    assert.equal(r.status, 502); assert.equal(r.body.ok, false); assert.equal(r.body.live, undefined);
  } finally { console.error = quiet; }
});
