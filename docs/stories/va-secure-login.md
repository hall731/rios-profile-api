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

---

# Follow-on: one login — a dedicated session secret, and single sign-on into chat

Same branch `claude/va-secure-login`, stacked on the password work (gate fcccda0,
dashboard 5fe5e3a). `rios-chat` joins on a branch of the same name off its main.
HELD: nothing merged, nothing deployed, no migration applied.

## 1. `GATE_SESSION_SECRET` (gate)

The password build signed the gate session with `PROFILE_SSO_SECRET` under a
different audience. It is now signed and verified ONLY with a dedicated env var,
`GATE_SESSION_SECRET`, on the gate site:

- `va-login` / `va-set-password` mint with it; `mint-chat-token`,
  `mint-profile-token`, `chat-unread`, `home-widgets`, `submit-survey` verify
  with it.
- Unset => a loud 500 naming `GATE_SESSION_SECRET`, on the login AND on every
  endpoint. There is deliberately NO fallback to `PROFILE_SSO_SECRET`; a session
  signed with the profile secret is refused everywhere (tested).
- Why: a leaked profile secret must not mint sessions, and a leaked session
  secret must not read profiles or forge credential-check tokens.
- Env audit: added to the gate spec's cutover checklist
  (`specs/va-survey-gate.md`) with every other gate variable. Secret value lives
  in Netlify only; never in code. The deploy list below carries it.

## 2. Single sign-on into chat — VA side (gate + rios-chat)

What already existed: the gate never asked a VA to sign into chat. It mints a
≤90 s single-use chat token from the login in memory (`CHAT_SSO_SECRET`,
`aud:"rios-chat"`), loads the frame at `sso-in?token=`, and when the chat page
loses its session it posts `rios-chat:reauth` and the gate mints again,
silently. The password work already made that mint require the gate session.

What still showed a second form: `rios-chat/sso-in.js`. With NO token in a frame
it already served the landing (which asks the gate to re-auth). But with a token
that FAILED to verify — a frame reload re-navigating to an already-burned token,
a jti-store outage — it rendered the standalone login form inside the frame.
That was the second sign-in.

Change (rios-chat `sso-in.js`): on any verification failure, if the browser says
this is a frame (`Sec-Fetch-Dest: iframe`, set by the browser, never by a page),
serve the landing page, which asks the gate for a fresh handoff; top-level, the
standalone form as before. The gate answers only when it holds a gate session
(`handleChatReauth` and `loadChat` refuse without one), so:

- valid gate session => chat opens, no credential re-entry, ever;
- no valid gate session => the gate never mints, the frame shows "chat
  unavailable", and chat never gets a session. Chat auth is not removed, not
  loosened: `sso-in` still verifies signature, expiry, audience, issuer and
  single-use jti, and still establishes its own session.

Scopes untouched: the chat token is signed with `CHAT_SSO_SECRET` and opens chat
only; the profile token with `PROFILE_SSO_SECRET` opens profile reads only; the
credential token carries `purpose:"credentials"`; the gate session has
`aud:"rios-gate"` and opens nothing outside the gate. No token was widened.

**The rios-chat fallback door** (`rios-chat/netlify/functions/va-login.js`)
still accepts the bare first + last + email trio with no password. The framed
chat never shows that form any more, so it is reachable only by a direct,
top-level visit to the chat site, and it opens chat only (no profile, documents
or payment details). It is a WEAKER PARALLEL DOOR. This change flags it (header
comment + this list) and does not close it. Options for the review: close it
(SSO only), or require a gate-minted token there too.

## 3. Admin side (dashboard)

The admin's "double login" into chat was not a chat login at all: after the
Netlify site password and the admin sign-in (email + password, HttpOnly session
cookie), the dashboard's chat pane, the clients inbox and the Lucía tab each
prompted for the shared ADMIN passphrase before calling `chat-proxy`, which
accepted only that passphrase.

Change: `chat-proxy` now opens on EITHER a valid admin session OR the
passphrase; neither => 401. The browser sends no passphrase when the sign-in
block reports a session (`adminAuthHeaders`), and prompts only when there is no
session (the old flow, unchanged for scripts and for an admin who never signed
in). Outbound calls to rios-chat still always carry `ADMIN_KEY`. This was small
and not risky: the admin session is per-person, password-based, HttpOnly and
`SameSite=Lax`, so a cross-site page cannot ride it onto a JSON POST, and
accepting it never admits anyone the passphrase would have refused. Outcome:
one login, chat opens authenticated. Other passphrase-gated writes (Settings
publish, observations, roster flips, passcodes) are unchanged.

## Acceptance (follow-on)

14. Gate: a session signed with `PROFILE_SSO_SECRET` is refused by every
    endpoint; `GATE_SESSION_SECRET` unset => 500 naming it on `va-login` and on
    `mint-profile-token`; `va-login`'s session verifies with the gate secret only.
15. Gate browser: `loadChat` and `handleChatReauth` never mint without
    `creds.session`; never prompt.
16. rios-chat: a replayed token or a jti-store outage INSIDE a frame => the
    re-auth landing (contains `rios-chat:reauth`), no form, no session; top-level
    => the form.
17. Dashboard: `chat-proxy` with a valid session and no key => works, outbound
    call still carries `ADMIN_KEY`, `sender_identity` from the session; wrong-
    secret or expired cookie and no key => 401; neither => 401. Every chat caller
    in the page uses the session-first headers and prompts only without one.

## Deploy additions

- Set `GATE_SESSION_SECRET` on the gate site BEFORE deploying the gate: a gate
  without it refuses every login (loud 500). Generate it fresh; never reuse
  `PROFILE_SSO_SECRET` or `CHAT_SSO_SECRET`.
- Deploy `rios-chat` any time; its change is self-contained.
- Deploy the dashboard any time; the passphrase path still works meanwhile.

## Review before it goes live (additions)

- `GATE_SESSION_SECRET` set on the gate site (see above).
- The rios-chat fallback trio door: close it, or gate it, or keep it and say so.
- Admin: `chat-proxy` now honours the admin session. The remaining passphrase
  prompts (Settings publish and the other writes) are a separate decision.
- The chat session cookie is `SameSite=None; Partitioned` for the frame; nothing
  here changed that.

---

# Decision: a credential is the only way in. The name + email door is gone.

Cody's decision, built on the same `claude/va-secure-login` branch (gate eb402be,
dashboard c9a62db, rios-chat a386d69, profile-api 4fb5311). HELD.

## What changed

1. **Gate login.** A VA must present a valid password, or a valid (unused,
   unexpired) access code. Name + email still IDENTIFY the VA (the unchanged
   `matchVA` fold) but are never sufficient. The "no credentials row => sign in
   by name" grace path is removed, and so is the `VA_PASSWORD_REQUIRED` switch:
   there is no configuration that can reopen a name-only path (tested: the
   string is absent from every gate function, and no "legacy" session is ever
   minted). A blank secret is refused by the gate before profile-api is asked,
   so it never burns a try. The one generic message now carries the guidance
   for everyone: "… check your first name, last name, email, and your password
   or access code … Just starting? Ask your admin for an access code to get
   started …". It is the SAME text for a wrong name, a wrong password, a used or
   expired code, a locked row, and a VA with no credentials at all, so nothing
   is enumerated. The login form's secret field is required, and its help text
   says the same in plain words. "Access code" is the VA-facing name for the
   temporary passcode.
2. **rios-chat fallback door removed.** `netlify/functions/va-login.js` and its
   trio matcher `_va-login.js` are deleted (and the matcher's test). `_pages.js`
   no longer has a login form at all: a top-level visit with no usable session
   (no token, a rejected or replayed token, a store outage) gets a page that
   says to sign in through RIOS home, with no form and no fields. Inside the
   gate's frame the behaviour from the single-sign-on follow-on stands: the
   landing asks the gate for a fresh token. Chat is reachable only through the
   signed, scoped, single-use handoff from a gate session, or an existing chat
   session the handoff established. `sso-in` verification is unchanged.
3. **Kept as built:** silent gate→chat SSO, admin single login into chat,
   `GATE_SESSION_SECRET`, scrypt hashing, access code → set password → password,
   admin issue/reset, 10 tries / 15 minutes lockout, token scopes and audience
   separation.
4. **Dashboard wording.** The Settings row's no-credential state now reads "No
   access code yet. They cannot sign in until you generate one — there is no
   name-and-email sign-in."

Client logins (`rios-client`, `rios-chat` `client-login`) were not part of this
decision and are untouched.

## Onboarding order (every VA, no exceptions)

1. Admin adds the VA in Settings (name, and the VA login name + email they will
   type) and publishes.
2. Admin opens the row's "Login password" line and clicks **Generate passcode**.
   The code is shown once.
3. Admin copies "First Last · email · code" into the welcome email.
4. The VA signs in on their RIOS home with name, email and the code (within 7
   days; the code is single-use).
5. The VA chooses their own password and is signed in. From then on: name,
   email and password. Chat opens from Home with no further sign-in.
6. Forgotten password or lockout: admin clicks **Reset login**, which issues a
   new code and clears the old password; back to step 3.

## VAs who sign in by name + email today (will be refused until issued a code)

Read from `signal-config.json` on this branch: three VAs carry a complete VA
login trio and therefore can sign in by name + email on the current production
gate. After this deploys, each is refused until an admin issues them an access
code (step 2 above). Issue the codes BEFORE deploying the gate, or right after
and tell them:

- Andrea Gonzalez
- Carla Pena
- Derek Sanabia Sandoval

Whether any of them already has a `va_credentials` row cannot be checked from
this session (no Supabase access); the password-era branch has not been
deployed, so none should. Nobody else can sign in today: a VA without a login
trio has never been able to.

## Review before it goes live (additions)

- Issue access codes to the three VAs above around the gate deploy.
- Deploy order is unchanged (migration by hand → profile-api → gate; set
  `GATE_SESSION_SECRET` on the gate first). rios-chat can deploy any time; once
  it does, the standalone chat sign-in is gone for everyone, which is intended.
- The 7-day code expiry and the single-use rule mean a welcome email that sits
  unread for a week needs a new code (Reset login or Generate a new passcode).
