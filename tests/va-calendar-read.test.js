const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { resp } = require("./_helpers");
const now = () => Math.floor(Date.now() / 1000);
const va = (k = "Ana Núñez") => jwt.sign({ va_key: k, iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j" }, "gate-secret");
const client = () => jwt.sign({ client_id: "c-1", va_keys: ["Ana Núñez"], iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-client", jti: "j" }, "client-secret");
function load() {
  Object.assign(process.env, { PROFILE_SSO_SECRET: "gate-secret", CLIENT_SSO_SECRET: "client-secret", SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc" });
  for (const f of ["va-calendar-read", "_profile-api-common", "_calendar-db"]) delete require.cache[require.resolve(`../netlify/functions/${f}`)];
  return require("../netlify/functions/va-calendar-read").handler;
}
const post = (t, body = {}) => ({ httpMethod: "POST", headers: { authorization: "Bearer " + t, origin: "https://va.remoteinsightos.com" }, body: JSON.stringify(body) });

test("VA sees own year: used/remaining, entries WITHOUT the admin note, holidays; query scoped to the token's key; a client token => 403", async () => {
  const h = load();
  const urls = [];
  const deps = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url) => {
    urls.push(url);
    if (url.includes("/va_time_off")) return resp(200, [{ id: "t1", va_key: "Ana Núñez", start_day: "2026-09-14", end_day: "2026-09-18", kind: "vacation", note: "SECRET admin note" }]);
    return resp(200, [{ id: "h", day: "2026-09-16", name: "Independencia", region: "MX" }]);
  } } };
  const res = await h(post(va(), { year: 2026 }), null, deps);
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.allowance, 6); assert.equal(b.used, 4); assert.equal(b.remaining, 2);
  assert.equal(b.timeOff[0].counted, 4);
  assert.doesNotMatch(res.body, /SECRET admin note|"note"|"id":"t1"/);
  assert.match(urls.find((u) => u.includes("/va_time_off")), /va_key=eq\.Ana%20N/);
  assert.equal((await h(post(client(), {}), null, deps)).statusCode, 403);
});

test("a VA who started on/after July 1 sees 3 days for that year (and when they become usable)", async () => {
  const h = load();
  const deps = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url) => {
    if (url.includes("/va_time_off")) return resp(200, []);
    if (url.includes("/profiles")) return resp(200, [{ va_key: "Ana Núñez", start_date: "2026-08-04" }]);
    return resp(200, []);
  } } };
  const b = JSON.parse((await h(post(va(), { year: 2026 }), null, deps)).body);
  assert.equal(b.allowance, 3); assert.equal(b.remaining, 3); assert.equal(b.eligible_from, "2026-11-02");
});
