/** _helpers.js — minimal PostgREST-shaped response for profile-api tests (mirrors the dashboard's). */
function resp(status, body) {
  return { ok: status >= 200 && status < 400, status, text: async () => (body == null ? "" : JSON.stringify(body)) };
}
module.exports = { resp };
