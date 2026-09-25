/**
 * documents-portal.js — per-VA documents for the two portals (Stage 6). profile-api.
 * ---------------------------------------------------------------------------
 * POST  Authorization: Bearer <gate VA token | portal client identity token>
 * The token's audience decides what is allowed. Identity (va_key / client_id +
 * va_keys) comes ONLY from the token.
 *
 *   VA     list                                  -> own confirmed docs
 *          open   { document_id }                -> { ok, url, view_id, close_secret }  records a view
 *                                                   (403 ack_required until the privacy doc is acknowledged)
 *   CLIENT list                                  -> docs visible to the client, for each assigned VA
 *          upload-init    { va_key, title, file_type, size_bytes }  -> { ok, document, upload_url }  va_key ∈ session va_keys
 *          upload-confirm { document_id }        -> own upload only
 *          open   { document_id }                -> { ok, url }  (no view row — views are the VA's metric)
 *          remove { document_id }                -> own upload only (tombstone)
 *
 * Bytes never pass through here. Metrics never leave here. Close is a separate
 * beacon-friendly endpoint (document-view-close.js).
 */

const { openRequest, json } = require("./_profile-api-common");
const docs = require("./_documents-db");
const ack = require("./_ack-db");
const { rest: profilesRest } = require("./_profiles-db");

const FN = "documents-portal";

async function profileByKey(va_key, opts) {
  const rows = await profilesRest(`/profiles?select=id,va_key&va_key=eq.${encodeURIComponent(va_key)}&limit=1`, {}, opts);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

exports.handler = async (event, _ctx, deps = {}) => {
  const o = openRequest(event, FN, deps);
  if (o.early) return o.early;
  const db = deps.dbOpts || {};
  const action = String(o.body.action || "");
  const J = (code, obj) => json(code, obj, o.origin, FN);

  try {
    if (o.audience === "va") {
      const prof = await profileByKey(o.va_key, db);
      if (action === "list") {
        if (!prof) return J(200, { ok: true, documents: [] });
        const rows = await docs.listDocs({ profile_id: prof.id }, db);
        return J(200, { ok: true, documents: rows.map(docs.docView) });
      }
      if (action === "open") {
        const d = await docs.getDoc(String(o.body.document_id || ""), db);
        if (!d || d.deleted_at || !d.confirmed_at || !prof || d.profile_id !== prof.id) return J(404, { ok: false, error: "No such document." });
        let acknowledged = false;
        try { acknowledged = (await ack.status({ audience: "va", subject_key: o.va_key }, db)).acknowledged; }
        catch (e) { console.warn(`${FN}: could not read acknowledgment — ${e && e.message}`); return J(502, { ok: false, error: "Couldn't open that right now." }); }
        if (!acknowledged) return J(403, { ok: false, error: "ack_required" });
        const view = await docs.openView({ document_id: d.id, va_key: o.va_key }, db);
        const url = await docs.signedReadUrl(d.storage_path, db);
        return J(200, { ok: true, url, view_id: view ? view.id : null, close_secret: view ? view.close_secret : null });
      }
      return J(400, { ok: false, error: "Unknown action." });
    }

    if (o.audience === "client") {
      const keys = o.va_keys || [];
      if (action === "list") {
        const out = [];
        for (const k of keys) {
          const prof = await profileByKey(k, db);
          if (!prof) continue;
          const rows = await docs.listDocs({ profile_id: prof.id, visibleToClientOnly: true }, db);
          for (const d of rows) out.push({ ...docs.docView(d), mine: d.uploaded_by_client_id === o.client_id });
        }
        return J(200, { ok: true, documents: out });
      }
      if (action === "upload-init") {
        const va_key = String(o.body.va_key || "");
        if (!keys.includes(va_key)) return J(404, { ok: false, error: "No such VA." });
        const prof = await profileByKey(va_key, db);
        if (!prof) return J(404, { ok: false, error: "No such VA." });
        const bad = docs.validateUpload(o.body); if (bad) return J(400, { ok: false, error: bad });
        const used = await docs.liveBytesFor(prof.id, db);
        if (used + Number(o.body.size_bytes) > docs.MAX_VA_BYTES) return J(409, { ok: false, error: "This VA's documents are at the 5 GB limit." });
        const id = require("node:crypto").randomUUID();
        const storage_path = docs.objectPath(prof.id, id, o.body.file_type);
        const row = await docs.insertDoc({ id, profile_id: prof.id, va_key: prof.va_key, title: String(o.body.title).trim(), storage_path, file_type: o.body.file_type, size_bytes: Number(o.body.size_bytes), uploaded_by_kind: "client", uploaded_by_client_id: o.client_id, visible_to_client: true }, db);
        const upload_url = await docs.signedUploadUrl(storage_path, db);
        return J(200, { ok: true, document: docs.docView(row), upload_url });
      }
      if (action === "upload-confirm" || action === "remove" || action === "open") {
        const d = await docs.getDoc(String(o.body.document_id || ""), db);
        const mine = d && d.uploaded_by_client_id === o.client_id;
        const visible = d && d.visible_to_client && keys.includes(d.va_key);
        if (!d || d.deleted_at || (action !== "open" && !mine) || (action === "open" && !(visible && d.confirmed_at))) return J(404, { ok: false, error: "No such document." });
        if (action === "upload-confirm") {
          const size = await docs.objectSize(d.storage_path, db);
          if (size == null || size !== Number(d.size_bytes)) { await docs.updateDoc(d.id, { deleted_at: new Date().toISOString(), deleted_by: "upload-confirm" }, db); return J(409, { ok: false, error: "The upload didn't complete. Try again." }); }
          return J(200, { ok: true, document: docs.docView(await docs.updateDoc(d.id, { confirmed_at: new Date().toISOString() }, db)) });
        }
        if (action === "remove") {
          await docs.updateDoc(d.id, { deleted_at: new Date().toISOString(), deleted_by: `client:${o.client_id}` }, db);
          await docs.deleteObject(d.storage_path, db);
          return J(200, { ok: true });
        }
        return J(200, { ok: true, url: await docs.signedReadUrl(d.storage_path, db) });
      }
      return J(400, { ok: false, error: "Unknown action." });
    }
    return J(403, { ok: false, error: "Not available." });
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (/missing SUPABASE/i.test(msg)) { console.error(`${FN}: ${msg}`); return J(500, { ok: false, error: "Server misconfiguration." }); }
    console.error(`${FN}: ${action} failed — ${msg}`);
    return J(502, { ok: false, error: "Couldn't reach the document store right now." });
  }
};
