/**
 * client-login.test.js — the portal's door (profile-api) + the client verifier.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { verifyClientToken } = require("../netlify/functions/_client-sso-verify");
const { resp } = require("./_helpers");

const SECRET = "client-sso-test-secret";
const now = () => Math.floor(Date.now() / 1000);
const loginTok = (over = {}, secret = SECRET) => jwt.sign({ purpose: "client-login", iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-client", jti: "j", ...over }, secret);
const identTok = (over = {}, secret = SECRET) => jwt.sign({ client_id: "c-1", va_keys: ["Ana Núñez"], iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-client", jti: "j", ...over }, secret);
const quiet = { warn() {}, error() {} };

test("verifyClientToken: fail-closed order; login-purpose vs identity shapes; gate tokens refused", () => {
  assert.equal(verifyClientToken({ token: loginTok(), secret: "", log: quiet }).reason, "no_secret");
  assert.equal(verifyClientToken({ token: loginTok({}, "other"), secret: SECRET, log: quiet }).reason, "signature");
  assert.equal(verifyClientToken({ token: loginTok({ exp: now() - 200 }), secret: SECRET, log: quiet }).reason, "expired");
  assert.equal(verifyClientToken({ token: loginTok({ aud: "rios-chat" }), secret: SECRET, log: quiet }).reason, "aud");
  assert.equal(verifyClientToken({ token: loginTok({ iss: "rios-gate" }), secret: SECRET, log: quiet }).reason, "iss");
  assert.deepEqual(verifyClientToken({ token: loginTok(), secret: SECRET, log: quiet }), { ok: true, purpose: "client-login" });
  const id = verifyClientToken({ token: identTok(), secret: SECRET, log: quiet });
  assert.equal(id.client_id, "c-1"); assert.deepEqual(id.va_keys, ["Ana Núñez"]);
  const gateShaped = jwt.sign({ va_key: "X", iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j" }, SECRET);
  assert.equal(verifyClientToken({ token: gateShaped, secret: SECRET, log: quiet }).reason, "iss");
  const noIdentity = jwt.sign({ iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-client", jti: "j" }, SECRET);
  assert.equal(verifyClientToken({ token: noIdentity, secret: SECRET, log: quiet }).reason, "claims");
});

function load(env = {}) {
  const base = { CLIENT_SSO_SECRET: SECRET, PROFILE_SSO_SECRET: "gate-secret", SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };
  for (const [k, v] of Object.entries({ ...base, ...env })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const f of ["client-login", "_profile-api-common", "_clients-db"]) delete require.cache[require.resolve(`../netlify/functions/${f}`)];
  return require("../netlify/functions/client-login").handler;
}
const post = (token, body) => ({ httpMethod: "POST", headers: { authorization: token ? "Bearer " + token : "", origin: "https://va.remoteinsightos.com" }, body: JSON.stringify(body) });
const CLIENTS = [{ id: "c-1", first_name: "Sarah", last_name: "Chen", email: "sarah@acme.com", is_active: true }, { id: "c-2", first_name: "Zoë", last_name: "Ramírez", email: "zoe@x.com", is_active: true }];
const dbOpts = (clients, assigns) => ({ dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url) => resp(200, url.includes("/client_assignments") ? assigns : clients) } });

test("client-login: only a LOGIN-purpose portal token opens the door; an identity token or a gate token does not", async () => {
  const h = load();
  assert.equal((await h(post(identTok(), { first: "Sarah", last: "Chen", email: "sarah@acme.com" }), null, dbOpts(CLIENTS, []))).statusCode, 401);
  assert.equal((await h(post(loginTok({}, "gate-secret"), { first: "Sarah", last: "Chen", email: "sarah@acme.com" }), null, dbOpts(CLIENTS, []))).statusCode, 401);
  assert.equal((await load({ CLIENT_SSO_SECRET: undefined })(post(loginTok(), {}))).statusCode, 500);
});

test("client-login: folds case/accents/spacing, returns clients.id + live va_keys; no match => generic 401; ambiguous => 409", async () => {
  const h = load();
  const res = await h(post(loginTok(), { first: "  zoe ", last: "RAMIREZ", email: "ZOE@x.com" }), null, dbOpts(CLIENTS, [{ id: "a1", client_id: "c-2", va_key: "Ana Núñez", unassigned_at: null }, { id: "a2", client_id: "c-2", va_key: "Bob Lee", unassigned_at: null }]));
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.client.id, "c-2"); assert.equal(b.client.first, "Zoë");
  assert.deepEqual(b.client.va_keys.sort(), ["Ana Núñez", "Bob Lee"]);
  const miss = await h(post(loginTok(), { first: "Zoe", last: "Ramirez", email: "wrong@x.com" }), null, dbOpts(CLIENTS, []));
  assert.equal(miss.statusCode, 401);
  const blank = await h(post(loginTok(), { first: "Zoe", last: "", email: "zoe@x.com" }), null, dbOpts(CLIENTS, []));
  assert.equal(blank.statusCode, 401);
  assert.equal(JSON.parse(miss.body).error, JSON.parse(blank.body).error);   // one message, no probing
  const dup = await h(post(loginTok(), { first: "Sarah", last: "Chen", email: "sarah@acme.com" }), null, dbOpts([...CLIENTS, { ...CLIENTS[0], id: "c-9" }], []));
  assert.equal(dup.statusCode, 409);
});

test("ack-status accepts a client identity token and keys the record by audience=client / clients.id", async () => {
  for (const f of ["ack-status", "_profile-api-common", "_ack-db"]) delete require.cache[require.resolve(`../netlify/functions/${f}`)];
  process.env.CLIENT_SSO_SECRET = SECRET; process.env.PROFILE_SSO_SECRET = "gate-secret";
  const h = require("../netlify/functions/ack-status").handler;
  let url = "";
  const res = await h(post(identTok(), {}), null, { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (u) => { url = u; return resp(200, []); } } });
  assert.equal(res.statusCode, 200);
  assert.match(url, /audience=eq\.client/); assert.match(url, /subject_key=eq\.c-1/);
  assert.match(JSON.parse(res.body).doc.text, /Messages sent through RIOS are stored and may be viewed by authorized Tele-Help-Ing team members/); assert.equal(JSON.parse(res.body).doc.version, "2026-10-02-draft");
});
