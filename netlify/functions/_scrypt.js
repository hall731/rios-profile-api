/**
 * _scrypt.js — SHARED helper (leading underscore: NOT a Netlify endpoint).
 * ---------------------------------------------------------------------------
 * Password hashing with Node's built-in scrypt (node:crypto). Used for admin
 * passwords (admins.password_hash, admin-login.js) and — as a byte-for-byte
 * copy in rios-profile-api, kept in step by its verify-sync.sh — for VA
 * passwords and temporary passcodes (va_credentials,
 * docs/stories/va-secure-login.md). Zero
 * dependencies, not plaintext, not rolled-own crypto. Each password gets a
 * random 16-byte salt; the stored value is a self-describing string
 *
 *     scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * so the verify path reads its own parameters back and can never be tricked
 * into using different ones. Verification re-derives and compares in constant
 * time (crypto.timingSafeEqual).
 *
 * A plaintext password exists in memory only for the moment it is hashed or
 * verified; it is NEVER stored, logged, or returned.
 */

const crypto = require("crypto");

// Cost parameters. N=2^15 is a sensible interactive-login cost. r/p standard.
const N = 1 << 15; // 32768
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

// scrypt needs ~128*N*r bytes; give generous headroom so the default 32 MiB
// maxmem cap never rejects the derivation.
function maxmemFor(n, r) {
  return 128 * n * r * 2 + (1 << 20);
}

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
}

/** hashPassword(plain) -> stored string. Throws on a non-string/empty password. */
async function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("_scrypt.hashPassword: empty password");
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const dk = await scryptAsync(plain, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: maxmemFor(N, R),
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

/**
 * verifyPassword(plain, stored) -> boolean. Never throws. Returns false on any
 * malformed input or parameter, so a garbage hash can never accidentally match.
 */
async function verifyPassword(plain, stored) {
  try {
    if (typeof plain !== "string" || typeof stored !== "string") return false;
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (
      !Number.isInteger(n) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      n < 2 ||
      salt.length === 0 ||
      expected.length === 0
    ) {
      return false;
    }
    const dk = await scryptAsync(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: maxmemFor(n, r),
    });
    if (dk.length !== expected.length) return false;
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, PARAMS: { N, R, P, KEYLEN, SALT_BYTES } };
