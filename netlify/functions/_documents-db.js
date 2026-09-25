/**
 * _documents-db.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * Service-role access to `documents`, `document_views` and the private Storage
 * bucket `va-documents` (supabase/migrations/20260924130000_documents.sql).
 * PostgREST for rows; the Storage REST API for objects. Plain fetch, config
 * at call time, injectable for tests — the same door as every other *-db.
 *
 * BYTES NEVER PASS THROUGH A FUNCTION. Uploads: we mint a SIGNED UPLOAD URL,
 * the browser PUTs straight to Storage, then calls confirm and we verify the
 * object exists with the declared size. Reads: a 60-second signed URL.
 *
 * LIMITS (DECIDED 2026-09-24): 100 MB / file, 5 GB / VA total, types in
 * ALLOWED_TYPES (mirrors the CHECK). VIEW DURATION = closed_at - opened_at;
 * an unclosed view older than ORPHAN_MINUTES reads as "unknown", never as
 * running or infinite.
 *
 * Env (SERVER ONLY): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

const crypto = require("node:crypto");

const BUCKET = "va-documents";
const MAX_FILE_BYTES = 100 * 1024 * 1024;          // 100 MB
const MAX_VA_BYTES = 5 * 1024 * 1024 * 1024;       // 5 GB
const SIGNED_READ_SEC = 60;
const ORPHAN_MINUTES = 30;
const ALLOWED_TYPES = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const DOCS = "/documents";
const VIEWS = "/document_views";
const DOC_COLS = "id,profile_id,va_key,title,storage_path,file_type,size_bytes,uploaded_by_kind,uploaded_by_client_id,uploaded_by_admin_email,visible_to_client,confirmed_at,created_at,updated_at,deleted_at";

function config(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.SUPABASE_URL;
  const key = opts.key !== undefined ? opts.key : process.env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!url || !key) { const missing = !url ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY"; throw new Error(`_documents-db: missing ${missing} — refusing to talk to Supabase without it.`); }
  return { url: String(url).replace(/\/+$/, ""), key, fetchImpl };
}
async function call(base, path, { method = "GET", headers = {}, body } = {}, opts = {}) {
  const { url, key, fetchImpl } = config(opts);
  const res = await fetchImpl(`${url}${base}${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) { const e = new Error(`_documents-db ${method} ${base}${path} failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : null;
}
const rest = (path, init, opts) => call("/rest/v1", path, init, opts);
const storage = (path, init, opts) => call("/storage/v1", path, init, opts);

/* ---------- validation ---------- */
function extFor(type) { return ALLOWED_TYPES[type] || null; }
function validateUpload({ title, file_type, size_bytes }) {
  const t = String(title || "").trim();
  if (!t || t.length > 200) return "A title is required (up to 200 characters).";
  if (!extFor(file_type)) return "That file type isn't allowed. Use PDF, Word, Excel, PowerPoint, text, CSV, PNG, JPG, WEBP or GIF.";
  const n = Number(size_bytes);
  if (!Number.isFinite(n) || n <= 0) return "File size is missing.";
  if (n > MAX_FILE_BYTES) return "Files can be up to 100 MB.";
  return null;
}
function objectPath(profileId, docId, file_type) { return `profiles/${profileId}/${docId}.${extFor(file_type)}`; }

/* ---------- rows ---------- */
async function listDocs({ profile_id, visibleToClientOnly = false, includeUnconfirmed = false } = {}, opts = {}) {
  let q = `${DOCS}?select=${DOC_COLS}&profile_id=eq.${encodeURIComponent(profile_id)}&deleted_at=is.null&order=created_at.desc`;
  if (!includeUnconfirmed) q += `&confirmed_at=not.is.null`;
  if (visibleToClientOnly) q += `&visible_to_client=eq.true`;
  const rows = await rest(q, {}, opts);
  return Array.isArray(rows) ? rows : [];
}
async function getDoc(id, opts = {}) {
  const rows = await rest(`${DOCS}?select=${DOC_COLS}&id=eq.${encodeURIComponent(id)}&limit=1`, {}, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function liveBytesFor(profile_id, opts = {}) {
  const rows = await rest(`${DOCS}?select=size_bytes&profile_id=eq.${encodeURIComponent(profile_id)}&deleted_at=is.null`, {}, opts);
  return (Array.isArray(rows) ? rows : []).reduce((n, r) => n + Number(r.size_bytes || 0), 0);
}
async function insertDoc(fields, opts = {}) {
  const rows = await rest(DOCS, { method: "POST", headers: { Prefer: "return=representation" }, body: fields }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function updateDoc(id, patch, opts = {}) {
  const rows = await rest(`${DOCS}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: { ...patch, updated_at: new Date().toISOString() } }, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* ---------- storage ---------- */
/** signedUploadUrl(path) -> absolute URL the browser PUTs the file to (with x-upsert:false). */
async function signedUploadUrl(path, opts = {}) {
  const r = await storage(`/object/upload/sign/${BUCKET}/${path}`, { method: "POST", body: {} }, opts);
  const rel = r && (r.url || r.signedURL);
  if (!rel) throw new Error("_documents-db: storage did not return a signed upload url");
  return `${config(opts).url}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`;
}
/** signedReadUrl(path) -> absolute 60s URL. */
async function signedReadUrl(path, opts = {}) {
  const r = await storage(`/object/sign/${BUCKET}/${path}`, { method: "POST", body: { expiresIn: SIGNED_READ_SEC } }, opts);
  const rel = r && (r.signedURL || r.url);
  if (!rel) throw new Error("_documents-db: storage did not return a signed url");
  return `${config(opts).url}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`;
}
/** objectSize(path) -> bytes | null when the object does not exist. */
async function objectSize(path, opts = {}) {
  const i = path.lastIndexOf("/");
  const prefix = path.slice(0, i), name = path.slice(i + 1);
  const items = await storage(`/object/list/${BUCKET}`, { method: "POST", body: { prefix, limit: 100, search: name } }, opts);
  const hit = (Array.isArray(items) ? items : []).find((x) => x && x.name === name);
  if (!hit) return null;
  const size = hit.metadata && (hit.metadata.size ?? hit.metadata.contentLength);
  return Number.isFinite(Number(size)) ? Number(size) : null;
}
async function deleteObject(path, opts = {}) {
  try { await storage(`/object/${BUCKET}`, { method: "DELETE", body: { prefixes: [path] } }, opts); return true; }
  catch (e) { console.warn(`_documents-db: could not delete object ${path} — ${e.message}`); return false; }
}

/* ---------- views ---------- */
async function openView({ document_id, va_key }, opts = {}) {
  const close_secret = crypto.randomBytes(16).toString("hex");
  const rows = await rest(VIEWS, { method: "POST", headers: { Prefer: "return=representation" }, body: { document_id, va_key, close_secret } }, opts);
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  return row ? { id: row.id, close_secret } : null;
}
/** closeView(id, close_secret) -> true when a matching OPEN view was closed. Idempotent. */
async function closeView(id, close_secret, opts = {}) {
  if (!id || !close_secret) return false;
  const rows = await rest(
    `${VIEWS}?id=eq.${encodeURIComponent(id)}&close_secret=eq.${encodeURIComponent(close_secret)}&closed_at=is.null`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: { closed_at: new Date().toISOString() } },
    opts
  );
  return Array.isArray(rows) && rows.length > 0;
}
async function listViews(document_ids, opts = {}) {
  if (!document_ids.length) return [];
  const list = document_ids.map((d) => encodeURIComponent(d)).join(",");
  const rows = await rest(`${VIEWS}?select=document_id,va_key,opened_at,closed_at&document_id=in.(${list})&order=opened_at.desc&limit=5000`, {}, opts);
  return Array.isArray(rows) ? rows : [];
}

/**
 * metrics(views, { now }) -> Map<document_id, { opens, first_opened_at,
 *   last_opened_at, known_seconds, unknown_opens, open_now }>
 * PURE. Duration by subtraction. An unclosed view older than ORPHAN_MINUTES is
 * "unknown" (counted, not timed); a younger one is "open now" (also not timed).
 */
function metrics(views, { now = Date.now() } = {}) {
  const out = new Map();
  for (const v of views || []) {
    const m = out.get(v.document_id) || { opens: 0, first_opened_at: null, last_opened_at: null, known_seconds: 0, unknown_opens: 0, open_now: 0 };
    const o = Date.parse(v.opened_at); if (Number.isNaN(o)) continue;
    m.opens++;
    if (!m.first_opened_at || o < Date.parse(m.first_opened_at)) m.first_opened_at = v.opened_at;
    if (!m.last_opened_at || o > Date.parse(m.last_opened_at)) m.last_opened_at = v.opened_at;
    if (v.closed_at) {
      const c = Date.parse(v.closed_at);
      if (!Number.isNaN(c) && c >= o) m.known_seconds += Math.round((c - o) / 1000);
      else m.unknown_opens++;
    } else if (now - o > ORPHAN_MINUTES * 60 * 1000) m.unknown_opens++;
    else m.open_now++;
    out.set(v.document_id, m);
  }
  return out;
}

/** view for a browser (any audience): explicit literal, never the storage path. */
function docView(d) {
  return {
    id: d.id, va_key: d.va_key, title: d.title, file_type: d.file_type, size_bytes: Number(d.size_bytes),
    uploaded_by: d.uploaded_by_kind, visible_to_client: !!d.visible_to_client, created_at: d.created_at,
  };
}

module.exports = {
  BUCKET, MAX_FILE_BYTES, MAX_VA_BYTES, SIGNED_READ_SEC, ORPHAN_MINUTES, ALLOWED_TYPES,
  config, rest, storage, extFor, validateUpload, objectPath,
  listDocs, getDoc, liveBytesFor, insertDoc, updateDoc,
  signedUploadUrl, signedReadUrl, objectSize, deleteObject,
  openView, closeView, listViews, metrics, docView,
};
