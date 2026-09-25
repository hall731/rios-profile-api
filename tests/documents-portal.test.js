const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("../netlify/functions/_jwt");
const adocs = require("../netlify/functions/_ack-docs");
const { resp } = require("./_helpers");
const now = () => Math.floor(Date.now() / 1000);
const vaTok = (k = "Ana Núñez") => jwt.sign({ va_key: k, iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-gate", jti: "j" }, "gate-secret");
const clTok = (keys = ["Ana Núñez"], id = "c-1") => jwt.sign({ client_id: id, va_keys: keys, iat: now(), exp: now() + 90, aud: "rios-profile", iss: "rios-client", jti: "j" }, "client-secret");
function load(name) {
  Object.assign(process.env, { PROFILE_SSO_SECRET: "gate-secret", CLIENT_SSO_SECRET: "client-secret", SUPABASE_URL: "https://db.example.co", SUPABASE_SERVICE_ROLE_KEY: "svc" });
  for (const f of [name, "_profile-api-common", "_documents-db", "_ack-db", "_profiles-db"]) delete require.cache[require.resolve(`../netlify/functions/${f}`)];
  return require(`../netlify/functions/${name}`).handler;
}
const post = (t, body) => ({ httpMethod: "POST", headers: { ...(t ? { authorization: "Bearer " + t } : {}), origin: "https://va.remoteinsightos.com" }, body: JSON.stringify(body) });
const cur = adocs.current("va");
const ADMIN_DOC = { id: "d1", profile_id: "p-ana", va_key: "Ana Núñez", title: "Contract", storage_path: "profiles/p-ana/d1.pdf", file_type: "application/pdf", size_bytes: 1000, uploaded_by_kind: "admin", uploaded_by_admin_email: "a@x", visible_to_client: false, confirmed_at: "x" };
const CLIENT_DOC = { ...ADMIN_DOC, id: "d2", storage_path: "profiles/p-ana/d2.pdf", uploaded_by_kind: "client", uploaded_by_admin_email: null, uploaded_by_client_id: "c-1", visible_to_client: true };
const OTHER_VA_DOC = { ...ADMIN_DOC, id: "d3", profile_id: "p-bob", va_key: "Bob Lee", visible_to_client: true };
function deps({ ackRows = [{ doc_version: cur.version, doc_sha256: cur.sha256, accepted_at: "x" }], rows = [ADMIN_DOC, CLIENT_DOC, OTHER_VA_DOC] } = {}) {
  const calls = [];
  return { calls, dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url, o = {}) => {
    const m = o.method || "GET"; const body = o.body ? JSON.parse(o.body) : null; calls.push({ url, m, body });
    if (url.includes("/rest/v1/profiles")) { const k = decodeURIComponent((url.match(/va_key=eq\.([^&]+)/) || [])[1] || ""); return resp(200, k === "Ana Núñez" ? [{ id: "p-ana", va_key: k }] : k === "Bob Lee" ? [{ id: "p-bob", va_key: k }] : []); }
    if (url.includes("/rest/v1/acknowledgments")) return resp(200, ackRows);
    if (url.includes("/rest/v1/document_views")) return m === "POST" ? resp(201, [{ id: "v1", ...body }]) : resp(200, []);
    if (url.includes("/rest/v1/documents")) {
      if (m === "GET") { const id = (url.match(/[?&]id=eq\.([^&]+)/) || [])[1]; const pid = (url.match(/profile_id=eq\.([^&]+)/) || [])[1]; let r = rows; if (id) r = r.filter((d) => d.id === id); if (pid) r = r.filter((d) => d.profile_id === pid); if (url.includes("visible_to_client=eq.true")) r = r.filter((d) => d.visible_to_client); return resp(200, r); }
      if (m === "POST") return resp(201, [{ ...body }]); if (m === "PATCH") return resp(200, [{ ...rows[0], ...body }]);
    }
    if (url.includes("/object/upload/sign/")) return resp(200, { url: "/object/upload/sign/va-documents/x?token=T" });
    if (url.includes("/object/sign/")) return resp(200, { signedURL: "/object/sign/va-documents/x?token=R" });
    if (url.includes("/object/list/")) return resp(200, [{ name: "d2.pdf", metadata: { size: 1000 } }]);
    return resp(500, null);
  } } };
}

test("VA: lists only own docs; open records a view + returns a close secret; open refused before acknowledgment; other VA's doc => 404", async () => {
  const h = load("documents-portal");
  let d = deps();
  let res = await h(post(vaTok(), { action: "list" }), null, d);
  assert.deepEqual(JSON.parse(res.body).documents.map((x) => x.id).sort(), ["d1", "d2"]);
  assert.doesNotMatch(res.body, /storage_path|metrics/);
  res = await h(post(vaTok(), { action: "open", document_id: "d1" }), null, d);
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.match(b.url, /storage\/v1\/object\/sign/); assert.equal(b.view_id, "v1"); assert.match(b.close_secret, /^[0-9a-f]{32}$/);
  const view = d.calls.find((c) => c.m === "POST" && c.url.includes("document_views")).body;
  assert.equal(view.va_key, "Ana Núñez"); assert.equal(view.document_id, "d1");
  assert.equal((await h(post(vaTok(), { action: "open", document_id: "d3" }), null, d)).statusCode, 404);
  d = deps({ ackRows: [] });
  res = await h(post(vaTok(), { action: "open", document_id: "d1" }), null, d);
  assert.equal(res.statusCode, 403); assert.equal(JSON.parse(res.body).error, "ack_required");
  assert.ok(!d.calls.some((c) => c.m === "POST" && c.url.includes("document_views")));
  assert.equal((await h(post(vaTok(), { action: "upload-init" }), null, d)).statusCode, 400);   // VAs never upload
});

test("CLIENT: lists only visible docs across assigned VAs; upload targets a VA in the session; a VA outside the session => 404; open never records a view; remove only own", async () => {
  const h = load("documents-portal");
  let d = deps();
  let res = await h(post(clTok(["Ana Núñez"]), { action: "list" }), null, d);
  const list = JSON.parse(res.body).documents;
  assert.deepEqual(list.map((x) => x.id), ["d2"]); assert.equal(list[0].mine, true);
  res = await h(post(clTok(["Ana Núñez", "Bob Lee"]), { action: "list" }), null, d);
  assert.deepEqual(JSON.parse(res.body).documents.map((x) => x.id).sort(), ["d2", "d3"]);
  res = await h(post(clTok(["Ana Núñez"]), { action: "upload-init", va_key: "Bob Lee", title: "x", file_type: "application/pdf", size_bytes: 5 }), null, d);
  assert.equal(res.statusCode, 404);
  res = await h(post(clTok(["Ana Núñez"]), { action: "upload-init", va_key: "Ana Núñez", title: "Brief", file_type: "application/pdf", size_bytes: 5 }), null, d);
  assert.equal(res.statusCode, 200);
  const ins = d.calls.find((c) => c.m === "POST" && c.url.includes("/rest/v1/documents")).body;
  assert.equal(ins.uploaded_by_kind, "client"); assert.equal(ins.uploaded_by_client_id, "c-1"); assert.equal(ins.visible_to_client, true);
  res = await h(post(clTok(["Ana Núñez"]), { action: "open", document_id: "d2" }), null, d);
  assert.equal(res.statusCode, 200);
  assert.ok(!d.calls.some((c) => c.m === "POST" && c.url.includes("document_views")));
  assert.equal((await h(post(clTok(["Ana Núñez"]), { action: "open", document_id: "d1" }), null, d)).statusCode, 404);   // not shared
  assert.equal((await h(post(clTok(["Ana Núñez"], "c-9"), { action: "remove", document_id: "d2" }), null, d)).statusCode, 404);
  assert.equal((await h(post(clTok(["Ana Núñez"]), { action: "remove", document_id: "d2" }), null, d)).statusCode, 200);
});

test("document-view-close: no Bearer; closes only the matching open view; idempotent; always 200", async () => {
  const h = load("document-view-close");
  let patched = [];
  const d = { dbOpts: { url: "https://db.example.co", key: "svc", fetchImpl: async (url, o = {}) => { if (o.method === "PATCH") { patched.push(url); return resp(200, url.includes("close_secret=eq.good") ? [{ id: "v1" }] : []); } return resp(200, []); } } };
  let res = await h({ httpMethod: "POST", headers: { origin: "https://va.remoteinsightos.com" }, body: JSON.stringify({ view_id: "v1", close_secret: "good" }) }, null, d);
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).closed, true);
  assert.match(patched[0], /closed_at=is\.null/);
  res = await h({ httpMethod: "POST", headers: {}, body: JSON.stringify({ view_id: "v1", close_secret: "bad" }) }, null, d);
  assert.equal(JSON.parse(res.body).closed, false);
  res = await h({ httpMethod: "POST", headers: {}, body: "not json" }, null, d);
  assert.equal(res.statusCode, 200);
});
