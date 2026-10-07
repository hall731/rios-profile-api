/**
 * _profile-sso-verify.js — SHARED helper (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * The gate→dashboard SSO token verifier for the VA Profile read
 * (specs/va-profile-stage2b.md §1.2). Isolated from HTTP so it is unit-testable
 * without a live secret.
 *
 * It ports rios-chat's `_sso-verify.js` fail-closed ORDER verbatim, each step
 * with its own named, loud warning so a broken handoff never reads as "the VA
 * just doesn't have a profile":
 *
 *   1. Signature (PROFILE_SSO_SECRET). Bad/absent => hard reject. Never trust
 *      va_key — or any claim — without a valid signature.
 *   2. Required-claims presence (va_key, iat, exp, aud, iss).
 *   3. Expiry (exp) with a small clock skew (default ±30s).
 *   4. aud == "rios-profile" AND iss == "rios-gate".
 *   5. Only after ALL pass: va_key is the authenticated identity.
 *
 * AUDIENCE IS THE POINT: the chat token and the profile token are signed with
 * DIFFERENT secrets and carry DIFFERENT `aud`, so a chat token can never be
 * replayed here and vice-versa.
 *
 * jti / single-use — spec open question A, shipped as **A2 (short-lived only)**:
 * a profile read is idempotent and mutates nothing, so a ≤90s audience-scoped
 * token is accepted without a replay store. `jti` is still REQUIRED to be
 * present when the token carries one (so A1 can be dropped in later by wiring a
 * `burnJti` here) but no store is consulted. See §1.2.
 *
 * Returns (never throws):
 *   { ok: true,  va_key }
 *   { ok: false, reason }   "no_secret" | "signature" | "claims" | "expired" |
 *                           "aud" | "iss" | "purpose"
 * Every { ok:false } EXCEPT "no_secret" is a generic 401 to the caller.
 * "no_secret" is a server misconfiguration the caller turns into a 500 — a
 * missing signing secret NEVER degrades into accepting unsigned tokens.
 */

const jwt = require("./_jwt");

const EXPECTED_AUD = "rios-profile";
const EXPECTED_ISS = "rios-gate";
const DEFAULT_SKEW_SEC = 30;
const REQUIRED_CLAIMS = ["va_key", "iat", "exp", "aud", "iss"];

/**
 * verifyProfileToken({ token, secret, nowSec, skewSec, log })
 *   token    the compact JWT from the Authorization: Bearer header
 *   secret   PROFILE_SSO_SECRET (shared gate↔dashboard; NOT the chat secret)
 *   nowSec   unix seconds (injectable for tests)
 *   skewSec  allowed clock skew, capped at 30s
 */
function verifyProfileToken({
  token,
  secret,
  nowSec = Math.floor(Date.now() / 1000),
  skewSec = DEFAULT_SKEW_SEC,
  log = console,
  expectedPurpose = null,
} = {}) {
  const skew = Math.min(Math.max(0, skewSec), DEFAULT_SKEW_SEC);

  if (!secret) {
    log.error(
      "PROFILE_SSO_MISSING_SECRET: PROFILE_SSO_SECRET is not set — refusing to " +
        "verify. A missing signing secret NEVER degrades into accepting unsigned tokens."
    );
    return { ok: false, reason: "no_secret" };
  }
  if (!token) return { ok: false, reason: "signature" };

  // 1. SIGNATURE FIRST. This is the whole security boundary.
  const v = jwt.verifySignature(token, secret);
  if (!v.ok) {
    log.warn(
      `PROFILE_SSO_VERIFY_FAIL step=signature detail=${v.reason} — bad or absent ` +
        "signature. (secret never logged)"
    );
    return { ok: false, reason: "signature" };
  }
  const p = v.payload || {};

  // 2. Required claims present.
  const missing = REQUIRED_CLAIMS.filter(
    (k) => p[k] === undefined || p[k] === null || p[k] === ""
  );
  if (missing.length) {
    log.warn(`PROFILE_SSO_VERIFY_FAIL step=claims missing=${missing.join(",")}`);
    return { ok: false, reason: "claims" };
  }
  if (!Number.isFinite(Number(p.exp)) || !Number.isFinite(Number(p.iat))) {
    log.warn("PROFILE_SSO_VERIFY_FAIL step=claims detail=non-numeric iat/exp");
    return { ok: false, reason: "claims" };
  }

  // 3. Expiry, with capped skew.
  if (nowSec > Number(p.exp) + skew) {
    log.warn(
      `PROFILE_SSO_VERIFY_FAIL step=expired exp=${p.exp} now=${nowSec} skew=${skew}`
    );
    return { ok: false, reason: "expired" };
  }

  // 4. Audience + issuer. A chat token must never open a profile.
  if (p.aud !== EXPECTED_AUD) {
    log.warn(
      `PROFILE_SSO_VERIFY_FAIL step=aud got=${String(p.aud)} want=${EXPECTED_AUD} ` +
        "— a token minted for another audience was presented here."
    );
    return { ok: false, reason: "aud" };
  }
  if (p.iss !== EXPECTED_ISS) {
    log.warn(`PROFILE_SSO_VERIFY_FAIL step=iss got=${String(p.iss)} want=${EXPECTED_ISS}`);
    return { ok: false, reason: "iss" };
  }

  // 4b. Purpose (docs/stories/va-secure-login.md). A token minted for the
  //     server-to-server credential check carries purpose:"credentials". It
  //     must NEVER open a profile, and a plain profile token must NEVER check a
  //     password: an endpoint that expects no purpose rejects any token carrying
  //     one, and an endpoint that expects one rejects any token without it.
  const purpose = p.purpose === undefined || p.purpose === null || p.purpose === "" ? null : String(p.purpose);
  if (purpose !== (expectedPurpose || null)) {
    log.warn(`PROFILE_SSO_VERIFY_FAIL step=purpose got=${String(purpose)} want=${String(expectedPurpose || null)}`);
    return { ok: false, reason: "purpose" };
  }

  // 5. Authenticated. The va_key comes ONLY from the verified claim — never
  //    from a request parameter, so a tampered client can only ever be itself.
  return { ok: true, va_key: String(p.va_key) };
}

module.exports = {
  verifyProfileToken,
  EXPECTED_AUD,
  EXPECTED_ISS,
  DEFAULT_SKEW_SEC,
  REQUIRED_CLAIMS,
};
