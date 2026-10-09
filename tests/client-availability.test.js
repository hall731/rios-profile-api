/**
 * client-availability.test.js — docs/stories/va-availability.md, acceptance 1–3 (profile-api layer).
 * The client's own VA(s), the next 90 days: holidays (ALL/MX) and approved
 * time off, by DATE ONLY. Fictional identities only.
 *
 * The PostgREST stub honours the identity filters the endpoint relies on the
 * database for (client_id, unassigned_at, va_key) and IGNORES the date and
 * deleted_at filters, so the endpoint's own window / tombstone checks are what
 * is under test. Every row carries kind / note / id / counted so the response
 * literal is what keeps them out.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const { resp } = require("./_helpers");

const nowSec = () => Math.floor(Date.now() / 1000);
const NOW = Date.parse("2026-10-09T15:00:00Z");          // window 2026-10-09 .. 2027-01-07
const FROM = "2026-10-09", TO = "2027-01-07";

const clientTok = (over = {}, secret = "client-secret") => jwt.sign({ client_id: "c-harper", va_keys: ["Maya Restrepo", "Nadia Okafor"], iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-client", jti: "j", ...over }, secret);
const vaTok = (over = {}) => jwt.sign({ va_key: "Maya Restrepo", iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j", ...over }, "gate-secret");
const loginTok = () => jwt.sign({ purpose: "client-login", iat: nowSec(), exp: nowSec() + 90, aud: "rios-profile", iss: "rios-client", jti: "j" }, "client-secret");

function load() {
  Object.assign(process.env, { PROFILE_SSO_SECRET: "gate-secret", CLIENT_SSO_SECRET: "client-secret", SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc" });
  for (const f of ["client-availability", "_profile-api-common", "_calendar-db", "_clients-db"]) {
    try { delete require.cache[require.resolve(`../netlify/functions/${f}`)]; } catch {}
  }
  return require("../netlify/functions/client-availability").handler;
}
const post = (t, body = {}) => ({ httpMethod: "POST", headers: t == null ? { origin: "https://va.remoteinsightos.com" } : { authorization: "Bearer " + t, origin: "https://va.remoteinsightos.com" }, body: JSON.stringify(body) });

const ASSIGNMENTS = [
  { id: "asg-1", client_id: "c-harper", va_key: "Maya Restrepo", unassigned_at: null },
  { id: "asg-2", client_id: "c-harper", va_key: "Tomás Ibarra", unassigned_at: null },
  { id: "asg-3", client_id: "c-harper", va_key: "Nadia Okafor", unassigned_at: "2026-10-01T00:00:00Z" },   // moved away
  { id: "asg-4", client_id: "c-other", va_key: "Nadia Okafor", unassigned_at: null },
];
const row = (id, va_key, start_day, end_day, kind, note, extra = {}) => ({ id, va_key, start_day, end_day, kind, note, counted: 3, allowance: 6, created_by_admin_email: "admin-xq@example.com", created_at: "2026-09-30T00:00:00Z", deleted_at: null, ...extra });
const TIME_OFF = [
  row("tof-id-m1", "Maya Restrepo", "2026-10-20", "2026-10-22", "vacation", "QUOKKA-NOTE-7731"),
  row("tof-id-m2", "Maya Restrepo", "2026-10-05", "2026-10-10", "sick", "PANGOLIN-NOTE-2210"),       // spans the window start
  row("tof-id-m3", "Maya Restrepo", "2026-10-01", "2026-10-08", "vacation", "ended yesterday"),       // ends yesterday
  row("tof-id-m4", "Maya Restrepo", "2027-01-08", "2027-01-09", "vacation", "starts day 91"),         // starts day 91
  row("tof-id-m5", "Maya Restrepo", "2026-11-02", "2026-11-03", "other", "TOMBSTONED-NOTE", { deleted_at: "2026-10-02T00:00:00Z" }),
  row("tof-id-m6", "Maya Restrepo", "2027-01-07", "2027-01-12", "vacation", "spans the end"),         // spans the window end
  row("tof-id-t1", "Tomás Ibarra", "2026-12-24", "2026-12-24", "other", "WALRUS-NOTE-4410"),
  row("tof-id-n1", "Nadia Okafor", "2026-10-15", "2026-10-16", "vacation", "NADIA-NOTE-5050"),
];
const hol = (id, day, name, region, extra = {}) => ({ id, day, name, region, created_by_admin_email: "admin-xq@example.com", created_at: "2026-09-24T00:00:00Z", deleted_at: null, ...extra });
const HOLIDAYS = [
  hol("hol-id-1", "2026-11-16", "Revolution Day", "MX"),
  hol("hol-id-2", "2026-12-25", "Christmas Day", "ALL"),
  hol("hol-id-3", "2026-11-26", "Thanksgiving", "US"),
  hol("hol-id-4", "2026-12-25", "Christmas Day", "ALL"),                                  // duplicate
  hol("hol-id-5", "2026-10-08", "Yesterday Holiday", "MX"),                               // before the window
  hol("hol-id-6", "2026-12-12", "Tombstoned Holiday", "MX", { deleted_at: "2026-10-01T00:00:00Z" }),
  hol("hol-id-7", "2027-01-01", "New Year's Day", "ALL"),
  hol("hol-id-8", "2027-01-08", "Day Ninety One Holiday", "ALL"),                         // after the window
];

function stub({ assignments = ASSIGNMENTS, fail = null } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = decodeURIComponent(url);
    if (url.includes("/client_assignments")) {
      if (fail === "assign") return resp(500, { message: "boom" });
      const cid = (/client_id=eq\.([^&]+)/.exec(u) || [])[1];
      const live = u.includes("unassigned_at=is.null");
      return resp(200, assignments.filter((a) => (!cid || a.client_id === cid) && (!live || !a.unassigned_at)));
    }
    if (url.includes("/va_time_off")) {
      if (fail === "timeoff") return resp(500, { message: "boom" });
      const k = (/va_key=eq\.([^&]+)/.exec(u) || [])[1];
      return resp(200, TIME_OFF.filter((r) => !k || r.va_key === k));
    }
    if (url.includes("/holidays")) {
      if (fail === "holidays") return resp(500, { message: "boom" });
      return resp(200, HOLIDAYS);
    }
    return resp(404, { message: "unexpected " + url });
  };
  return { urls, deps: { now: () => NOW, sleep: async () => {}, dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl } } };
}

test("client token: only its LIVE-assigned VAs (not the token's va_keys), real dates for rows overlapping the window, ALL/MX holidays — exact literal", async () => {
  const h = load();
  const st = stub();
  const res = await h(post(clientTok()), null, st.deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true, from: FROM, to: TO,
    vas: [
      { va: "Maya Restrepo", timeOff: [
        { start: "2026-10-05", end: "2026-10-10" },
        { start: "2026-10-20", end: "2026-10-22" },
        { start: "2027-01-07", end: "2027-01-12" },
      ] },
      { va: "Tomás Ibarra", timeOff: [{ start: "2026-12-24", end: "2026-12-24" }] },
    ],
    holidays: [
      { day: "2026-11-16", name: "Revolution Day" },
      { day: "2026-12-25", name: "Christmas Day" },
      { day: "2027-01-01", name: "New Year's Day" },
    ],
  });
  // The assignment read is the client's own, live only.
  const a = st.urls.find((u) => u.includes("/client_assignments"));
  assert.match(a, /client_id=eq\.c-harper/); assert.match(a, /unassigned_at=is\.null/);
  // Time off: one read per live VA, scoped to the window, live rows, and the
  // columns asked for never include the kind or the note.
  const t = st.urls.filter((u) => u.includes("/va_time_off"));
  assert.equal(t.length, 2);
  for (const u of t) {
    assert.match(u, /deleted_at=is\.null/);
    assert.match(u, new RegExp(`end_day=gte\\.${FROM}`)); assert.match(u, new RegExp(`start_day=lte\\.${TO}`));
    const sel = decodeURIComponent((/select=([^&]+)/.exec(u) || [])[1] || "");
    assert.ok(sel && !/\*|kind|note|\bid\b|created_by/.test(sel), "time-off select must not ask for kind/note/id/creator: " + sel);
  }
  assert.ok(!st.urls.some((u) => /Nadia/.test(decodeURIComponent(u))), "a VA not live-assigned is never even read");
  const hq = st.urls.find((u) => u.includes("/holidays"));
  assert.match(hq, new RegExp(`day=gte\\.${FROM}`)); assert.match(hq, new RegExp(`day=lte\\.${TO}`));
});

test("privacy: the RAW body never carries kind, note text, ids, counts, creator, region, another client's VA or a US holiday", async () => {
  const h = load();
  const res = await h(post(clientTok()), null, stub().deps);
  assert.equal(res.statusCode, 200);
  for (const bad of [/sick/i, /vacation/i, /other/i, /kind/i, /note/i, /QUOKKA|PANGOLIN|WALRUS|TOMBSTONED|NADIA/i, /tof-id|hol-id|asg-/, /"id"/, /counted/i, /allowance/i, /created/i, /admin-xq/, /region/i, /"US"|"MX"|"ALL"/, /Thanksgiving/, /Nadia|Okafor/, /deleted/i, /Yesterday Holiday|Day Ninety One|Tombstoned Holiday/, /c-harper/]) {
    assert.doesNotMatch(res.body, bad);
  }
});

test("a VA token is 403 'Clients only.' and reads nothing", async () => {
  const h = load();
  const st = stub();
  const res = await h(post(vaTok()), null, st.deps);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "Clients only." });
  assert.equal(st.urls.length, 0);
});

test("no token, bad signature, expired, wrong issuer, purpose tokens => 401, nothing read", async () => {
  const h = load();
  const st = stub();
  const cases = {
    "no token": null,
    "garbage": "not.a.token",
    "bad signature": clientTok({}, "wrong-secret"),
    "expired": clientTok({ iat: nowSec() - 600, exp: nowSec() - 300 }),
    "gate-issued client shape": clientTok({ iss: "rios-gate" }),
    "client-login purpose": loginTok(),
    "VA credentials purpose": vaTok({ purpose: "credentials" }),
  };
  for (const [name, t] of Object.entries(cases)) {
    const res = await h(post(t), null, st.deps);
    assert.equal(res.statusCode, 401, name);
    assert.equal(JSON.parse(res.body).ok, false, name);
  }
  assert.equal(st.urls.length, 0);
});

test("OPTIONS => 204; GET => 405", async () => {
  const h = load();
  assert.equal((await h({ httpMethod: "OPTIONS", headers: {} }, null, stub().deps)).statusCode, 204);
  assert.equal((await h({ httpMethod: "GET", headers: {} }, null, stub().deps)).statusCode, 405);
});

test("zero live VAs => 200 with empty lists, and no calendar read", async () => {
  const h = load();
  const st = stub({ assignments: [] });
  const res = await h(post(clientTok()), null, st.deps);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, from: FROM, to: TO, vas: [], holidays: [] });
  assert.ok(!st.urls.some((u) => u.includes("/va_time_off") || u.includes("/holidays")));
});

test("a database failure (assignments, time off or holidays) => 502 with a plain error, never a partial list", async () => {
  const h = load();
  for (const fail of ["assign", "timeoff", "holidays"]) {
    const res = await h(post(clientTok()), null, stub({ fail }).deps);
    assert.equal(res.statusCode, 502, fail);
    const b = JSON.parse(res.body);
    assert.equal(b.ok, false); assert.equal(typeof b.error, "string");
    assert.doesNotMatch(res.body, /boom|REST|va_time_off|holidays|client_assignments/, fail);
  }
});

test("a single transient database error is retried, not shown", async () => {
  const h = load();
  const st = stub();
  let first = true;
  const inner = st.deps.dbOpts.fetchImpl;
  st.deps.dbOpts.fetchImpl = async (url) => {
    if (first && url.includes("/client_assignments")) { first = false; return resp(503, { message: "blip" }); }
    return inner(url);
  };
  const res = await h(post(clientTok()), null, st.deps);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).vas.length, 2);
});

test("missing database config => 500 'Server misconfiguration.'", async () => {
  const h = load();
  const res = await h(post(clientTok()), null, { now: () => NOW, sleep: async () => {}, dbOpts: { url: "", key: "" } });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "Server misconfiguration." });
});

test("the window is today (UTC) through today + WINDOW_DAYS inclusive", async () => {
  load();
  const m = require("../netlify/functions/client-availability");
  assert.equal(m.WINDOW_DAYS, 90);
  assert.deepEqual(m.windowFor(Date.parse("2026-10-09T23:59:59Z")), { from: "2026-10-09", to: "2027-01-07" });
  assert.deepEqual(m.windowFor(Date.parse("2028-02-01T00:00:00Z")), { from: "2028-02-01", to: "2028-05-01" });
});
