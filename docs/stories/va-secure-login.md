# Story: a VA password on the gate login

**Tier 3, security-sensitive.** Branch `claude/va-secure-login` in three repos:
`remote-insight-os` (migration, admin passcode function, Settings UI),
`rios-profile-api` (credential store + check endpoint), `hall731-rios-gate` (the
login itself). HELD: nothing merged, nothing deployed, the migration NOT applied.
This file is copied verbatim into all three repos so each `qa` reviews against
the same text; `remote-insight-os/docs/stories/va-secure-login.md` is the master.

## Today

A VA signs into the gate with first + last + email matched against the `va` trio
in `signal-config.json` (`_va-login.js` `matchVA`). No password. Every other gate
endpoint (`mint-profile-token`, `mint-chat-token`, `chat-unread`, `home-widgets`,
`submit-survey`) re-derives identity from the same three typed fields on every
call. So anyone who knows a VA's name and email can open their profile, their
documents, and their payment details. Too weak for what the portal now holds.

## The flow

1. **Admin issues a temporary passcode** from the Settings row (dashboard).
   Shown once, with a copy button that copies `First Last · email · passcode`
   for the welcome email (the client-access copy pattern). Expires in 7 days.
2. **VA's first login** = name + email match (unchanged) **+ the passcode**.
3. **Forced to set their own password** before anything else opens.
4. **Later logins** = name + email + password.
5. **Admin can reset** from the same row: a new passcode is issued, the old
   password is cleared, and the VA goes through step 2–3 again.

The password is an ADDITIVE layer. Name folding (`norm` / `_cfgKey`) is untouched
in all three doors. Admin auth and client auth are not touched.

## Where things live

```
dashboard (admin)  --issue/reset-->  Supabase va_credentials  <--check-- profile-api
                                                                              ^
gate va-login  --name match-->  profile-api va-credential-check (server-to-server)
gate va-login  --ok-->  browser gets { va, sid, session }
every other gate endpoint  --requires `session`-->  (plus the trio, as today)
```

- **Storage: `public.va_credentials`**, one row per VA keyed by `va_key`
  (FK to `profiles.va_key`), service-role only, RLS forced, no policies.
  `password_hash`, `temp_passcode_hash`, `temp_expires_at`, `must_reset`,
  `failed_attempts`, `locked_until`, audit columns. Plus
  `public.va_credential_events` (passcode_issued | reset_forced | password_set |
  locked) with the acting admin's email. Migration
  `supabase/migrations/20261007150000_va_credentials.sql` — **REVIEW BEFORE
  APPLYING, Cody applies by hand**. Nothing runs it.
- **Hashing:** the dashboard's existing `_scrypt.js` approach
  (`scrypt$N$r$p$salt$hash`, N=2^15, constant-time verify). profile-api gets a
  byte-for-byte copy (the repos cannot import each other). Plaintext passwords
  and passcodes exist in memory only for the moment they are hashed or verified;
  never stored, logged, or returned (the one exception: the passcode is returned
  ONCE to the admin who just generated it).
- **The gate has no Supabase access and must not get any** (it is the public
  front door). It asks `rios-profile-api` to check credentials, server-to-server,
  with a profile SSO token that carries an extra claim `purpose:"credentials"`.
  profile-api's verifier now REJECTS any token carrying `purpose` on every
  existing endpoint, and the credential endpoint REQUIRES it. So a credential-check
  token can never read a profile, and a profile token can never check a password.
- **Gate session.** On success `va-login` returns `session`: an HS256 token
  (`aud:"rios-gate"`, `iss:"rios-gate"`, `va_key`, `iat`, `exp` = 12 h, `jti`,
  `auth:"password"|"legacy"`) signed with `PROFILE_SSO_SECRET`. The audience makes
  it useless at profile-api or chat. The browser keeps it in memory with the trio
  and sends it on every call; the five other gate endpoints refuse (generic 401)
  without a valid session whose `va_key` equals the trio-derived key. Without
  this the password would only decorate the login page.
- **Set password:** `POST va-set-password { first, last, email, passcode,
  new_password }`. The gate re-matches the trio, profile-api re-verifies the
  passcode (unexpired, hash match) and in ONE update stores the new hash, clears
  the passcode, sets `must_reset=false`. The passcode is single-use because it is
  gone the moment it has done its job. The browser holds it in a JS variable only
  between the two requests.

## Rules

- **Passcode:** 12 characters from an unambiguous alphabet (no 0/O/1/I/L),
  shown as `XXXX-XXXX-XXXX`, ~56 bits. 7-day expiry (`temp_expires_at`).
- **Password:** 10 to 200 characters, anything else allowed, must not equal the
  passcode. No composition rules. Plain words in the form.
- **Lockout:** 10 consecutive failed checks → `locked_until` = now + 15 min.
  Admin issue/reset clears the counter and the lock. Same generic 401 while locked.
- **Non-enumerating:** wrong trio, wrong password, wrong/expired passcode, locked,
  no credentials under enforcement: ALL return 401 with the one
  `LOGIN_FAILED_MESSAGE` (reworded to mention the password or passcode). The only
  distinct success shape is `{ ok:true, next:"set_password" }` after a VALID
  passcode, which is itself a secret.
- **Rollout, nobody locked out:** a VA with NO `va_credentials` row signs in as
  today (name + email) and gets a `legacy` session. Once an admin issues them a
  passcode, the password layer is enforced for them. The env switch
  `VA_PASSWORD_REQUIRED=1` on the gate (not a secret) refuses legacy logins once
  every VA has a password. Default off.
- **Fail closed:** if profile-api cannot be reached during login, the gate
  answers "can't sign you in right now" (500-class, generic), never a legacy pass.
- **Admin side:** any signed-in admin (ADMIN_KEY + admin session), super not
  required; every issue/reset is written to `va_credential_events` with the
  admin's email. A VA with no `profiles` row gets a minimal one created, as
  `set-roster-active` already does.
- No new secrets. `PROFILE_SSO_SECRET`, `PROFILE_API_ORIGIN`, `SUPABASE_*`,
  `ADMIN_KEY`, `ADMIN_SESSION_SECRET` already exist where they are used. No
  `GITHUB_*` names.
- No behavioural tracking added. Credential events are security audit, not
  analytics; no login counters beyond the existing `login` event.

## Acceptance criteria

profile-api (`va-credential-check`):
1. A profile token WITHOUT `purpose:"credentials"` is refused (401); a token WITH
   it is refused by `va-profile-read` and the other existing endpoints (401).
2. `login` with no row → `{ state:"none" }`; with a valid unexpired passcode →
   `{ state:"passcode" }` and the row is unchanged; with the right password →
   `{ state:"password" }`; wrong password / expired passcode / locked → `{ ok:false }`
   and `failed_attempts` incremented; the 10th failure sets `locked_until`.
3. `set_password` with a valid passcode and a 10–200 char password stores a
   scrypt hash, clears the passcode fields, sets `must_reset=false`, records a
   `password_set` event; with a wrong/expired passcode → `{ ok:false }`, nothing
   written; a password equal to the passcode or shorter than 10 → `{ ok:false }`.
4. No response body ever contains a hash or a plaintext secret.

gate:
5. `va-login` with a legacy VA (no row) → 200 `{ va, sid, session }` with
   `auth:"legacy"`; with `VA_PASSWORD_REQUIRED=1` → 401 generic.
6. `va-login` + valid passcode → 200 `{ next:"set_password" }`, no session; + right
   password → 200 with `session` (`auth:"password"`); wrong password / wrong
   passcode / wrong trio → the same 401 body; profile-api down → 500 generic.
7. `va-set-password` → 200 `{ va, sid, session }`; bad passcode → 401 generic;
   short password → 400 with a plain message.
8. `mint-profile-token`, `mint-chat-token`, `chat-unread`, `home-widgets`,
   `submit-survey`: a valid trio WITHOUT `session`, or with a session for another
   VA, or an expired one → 401 generic; with a valid session → as before.
9. The browser: the login form has a "Password or temporary passcode" field; a
   `next:"set_password"` answer shows the set-password screen; success lands where
   login lands today (acknowledgment gate, then Home). Plain words.

dashboard:
10. `va-passcode` refuses without ADMIN_KEY (401) or a valid admin session (403);
    `issue` returns the passcode ONCE in `XXXX-XXXX-XXXX` form, stores only its
    scrypt hash with a 7-day expiry, `must_reset=true`, counters cleared, and an
    event row; `reset` also clears `password_hash`; `status` never returns a hash.
11. The Settings row shows the credential state in plain words and the
    one-time passcode box with a copy button.
12. Migration file present in `remote-insight-os` and `rios-profile-api`, stamped
    REVIEW BEFORE APPLYING, not referenced by any code path that runs it.
13. All new tests fail against the previous code; all three suites green.

## Where profile-api's files are authored

`rios-profile-api/netlify/functions/*` are COPIES of `remote-insight-os/netlify/functions/*`
(the source of truth; `rios-profile-api/scripts/verify-sync.sh` checks the
drift before every deploy and the README says to copy the dashboard's version
over). So the purpose check in `_profile-sso-verify.js` / `_profile-api-common.js`,
and the new `_credentials-db.js`, `va-credential-check.js`, `_scrypt.js`, their
test and the migration are authored in `remote-insight-os` (root
`netlify/functions` and the in-repo mirror `profile-api/`) and copied byte-for-byte
into `rios-profile-api`, which lists them in `verify-sync.sh`. The passcode is
hashed in its canonical form (upper-case, letters and digits only) by the
dashboard and canonicalised the same way before verification by profile-api.

## Deploy order (a lockout hazard if ignored)

1. Apply the migration (by hand, after review).
2. Deploy `rios-profile-api` (the credential check must exist).
3. Deploy `hall731-rios-gate`. The gate's `va-login` now fails CLOSED (500) if
   profile-api cannot answer, and requires `PROFILE_API_ORIGIN` and
   `PROFILE_SSO_SECRET` on the gate site (both already set for the profile read).
4. Deploy `remote-insight-os` whenever; the Settings control only matters once
   the table exists.

## Review before it goes live

- Apply the migration by hand after review.
- The `rios-chat` fallback `va-login.js` is a FOURTH door that still accepts the
  bare trio (chat only, no documents or payment). Out of this story's scope;
  decide whether it gets the same layer or is closed.
- `VA_PASSWORD_REQUIRED=1` once every VA has a password.
- Session TTL (12 h) and lockout policy (10 tries / 15 min) are first guesses.
- Old open tabs from before the deploy fail until the VA signs in again.
- A dedicated `GATE_SESSION_SECRET` would separate the session from the profile
  SSO secret; this story reuses `PROFILE_SSO_SECRET` with a distinct audience to
  avoid a new secret.
- A gate session is not revoked by an admin reset, a lockout, or flipping
  `VA_PASSWORD_REQUIRED`: one minted before stays valid for the rest of its 12 h.
  A reset is therefore not an immediate kick.
- Lock stickiness: the failure counter clears only on a successful password
  login, a password set, or an admin issue/reset. After a lock lapses, the next
  wrong try re-locks. Anyone holding the trio can keep a VA locked for 15-minute
  stretches; the admin's reset clears it.
- Timing: a wrong password costs one scrypt round; "no credentials under
  enforcement" and "locked" answer without one. Bodies are identical; timing is
  not claimed to be.
