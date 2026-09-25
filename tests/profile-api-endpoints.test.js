/**
 * profile-api-endpoints.test.js — ack-status, ack-accept, events-ingest.
 * Same posture as va-profile-read.test.js: verify fail-closed, identity from
 * the token only, and (for telemetry) NOTHING recorded before acknowledgment.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const docs = require("../netlify/functions/_ack-docs");
const { resp } = require("./_helpers");

const SECRET = "profile-sso-test-secret";
const NOW = 1_800_000_000;
const nowSec = () => Math.floor(Date.now() / 1000);
const mk = (over = {}, secret = SECRET) =>
  jwt.sign({ va_key: "Valentina Reyes", iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j1", ...over }, secret);
const cur = docs.current("va");

function load(name, env = {}) {
  const base = { PROFILE_SSO_SECRET: SECRET, SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc", PROFILE_GATE_ORIGINS: undefined };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const f of [name, "_profile-api-common", "_ack-db", "_events-db"]) { const p = require.resolve(`../netlify/functions/${f}`); delete require.cache[p]; }
  return require(`../netlify/functions/${name}`).handler;
}
const post = (token, body = {}, headers = {}) => ({
  httpMethod: "POST",
  headers: { ...(token ? { authorization: "Bearer " + token } : {}), origin: "https://va.remoteinsightos.com", ...headers },
  body: JSON.stringify(body),
});
const ackRow = { doc_version: cur.version, doc_sha256: cur.sha256, accepted_at: "2026-09-24T00:00:00Z" };
const dbWith = (rows, onPost) => ({ dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url, o = {}) => (o.method === "POST" ? (onPost ? onPost(url, o) : resp(201, [{ ...JSON.parse(o.body), accepted_at: "now" }])) : resp(200, rows)) } });

test("all three: OPTIONS 204 with CORS for a known origin; no Allow-Origin for an unknown one; 405; 401 on bad token; chat token refused", async () => {
  for (const name of ["ack-status", "ack-accept", "events-ingest"]) {
    const h = load(name);
    const pre = await h({ httpMethod: "OPTIONS", headers: { origin: "https://va.remoteinsightos.com" } });
    assert.equal(pre.statusCode, 204, name);
    assert.equal(pre.headers["Access-Control-Allow-Origin"], "https://va.remoteinsightos.com", name);
    const unknown = await h({ httpMethod: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(unknown.headers["Access-Control-Allow-Origin"], undefined, name);
    assert.equal((await h({ httpMethod: "GET", headers: {} })).statusCode, 405, name);
    assert.equal((await h(post("garbage"))).statusCode, 401, name);
    assert.equal((await h(post(mk({}, "wrong-secret")))).statusCode, 401, name);
    assert.equal((await h(post(mk({ aud: "rios-chat" })))).statusCode, 401, name);
    assert.equal((await h(post(mk({ exp: nowSec() - 120 })))).statusCode, 401, name);
    assert.equal((await load(name, { PROFILE_SSO_SECRET: undefined })(post(mk()))).statusCode, 500, name);
  }
});

test("ack-status returns the CURRENT document text + hash and the acknowledged flag; 502 when the log is unreadable", async () => {
  const h = load("ack-status");
  let res = await h(post(mk()), null, dbWith([]));
  let b = JSON.parse(res.body);
  assert.equal(res.statusCode, 200); assert.equal(b.acknowledged, false);
  assert.equal(b.doc.sha256, cur.sha256); assert.equal(b.doc.text, cur.text); assert.equal(b.doc.draft, true);
  res = await h(post(mk()), null, dbWith([ackRow]));
  assert.equal(JSON.parse(res.body).acknowledged, true);
  res = await h(post(mk()), null, { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async () => resp(500, null) } });
  assert.equal(res.statusCode, 502);
});

test("ack-accept logs only the current version+sha for the token's va_key; stale => 409; bad body => 400", async () => {
  const h = load("ack-accept");
  let posted = null;
  const deps = dbWith([], (_u, o) => { posted = JSON.parse(o.body); return resp(201, [{ ...posted, accepted_at: "2026-09-24T01:00:00Z" }]); });
  let res = await h(post(mk(), { doc_version: cur.version, doc_sha256: cur.sha256, va_key: "Someone Else" }), null, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(posted.subject_key, "Valentina Reyes");  // from the token, not the body
  assert.equal(posted.audience, "va");
  res = await h(post(mk(), { doc_version: "old", doc_sha256: cur.sha256 }), null, deps);
  assert.equal(res.statusCode, 409);
  res = await h(post(mk(), { doc_version: cur.version }), null, deps);
  assert.equal(res.statusCode, 400);
});

test("events-ingest: 403 ack_required and NOTHING recorded before acknowledgment; records after; body cannot set identity", async () => {
  const h = load("events-ingest");
  let inserted = [];
  const mkDeps = (ackRows) => ({ dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url, o = {}) => {
    if (o.method === "POST") { inserted.push({ url, body: JSON.parse(o.body) }); return resp(201, null); }
    return resp(200, ackRows);
  } } });
  let res = await h(post(mk(), { kind: "surface", surface: "home", session_id: "s-1" }), null, mkDeps([]));
  assert.equal(res.statusCode, 403); assert.equal(JSON.parse(res.body).error, "ack_required");
  assert.equal(inserted.length, 0);
  res = await h(post(mk(), { kind: "surface", surface: "home", session_id: "s-1", subject_key: "Other", audience: "admin" }), null, mkDeps([ackRow]));
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).recorded, true);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].url, /\/events$/);
  assert.equal(inserted[0].body.subject_key, "Valentina Reyes");
  assert.equal(inserted[0].body.audience, "va");
  assert.equal(inserted[0].body.session_id, "s-1");
  res = await h(post(mk(), { kind: "dwell" }), null, mkDeps([ackRow]));
  assert.equal(res.statusCode, 400);
});

test("events-ingest: unreadable acknowledgment => 200 recorded:false, nothing written (fail closed, never user-facing)", async () => {
  const h = load("events-ingest");
  let posts = 0;
  const res = await h(post(mk(), { kind: "login" }), null, { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (_u, o = {}) => { if (o.method === "POST") posts++; return resp(500, null); } } });
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).recorded, false); assert.equal(posts, 0);
});
