/**
 * document-view-close.js — close a document view (Stage 6). profile-api.
 * ---------------------------------------------------------------------------
 * POST { view_id, close_secret }   — NO Bearer: sent with navigator.sendBeacon
 * on pagehide, which cannot set headers. The close_secret was handed out by
 * documents-portal `open` for THIS view only, so the only thing this call can
 * ever do is stamp closed_at on that one row, once. Body may arrive as
 * text/plain (beacon); we parse JSON either way. Idempotent. Always 200.
 */

const { corsHeaders } = require("./_profile-api-common");
const docs = require("./_documents-db");

const FN = "document-view-close";

exports.handler = async (event, _ctx, deps = {}) => {
  const headers = (event && event.headers) || {};
  const origin = headers.origin || headers.Origin || "";
  const h = { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin, FN) };
  if ((event && event.httpMethod) === "OPTIONS") return { statusCode: 204, headers: corsHeaders(origin, FN), body: "" };
  if ((event && event.httpMethod) !== "POST") return { statusCode: 405, headers: h, body: JSON.stringify({ ok: false }) };
  let body = {};
  try { body = JSON.parse((event && event.body) || "{}") || {}; } catch { return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, closed: false }) }; }
  let closed = false;
  try { closed = await docs.closeView(String(body.view_id || ""), String(body.close_secret || ""), deps.dbOpts || {}); }
  catch (e) { console.warn(`${FN}: ${e && e.message}`); }
  return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, closed }) };
};
