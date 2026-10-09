# Sessions are bound to the VA's credentials

Branch `claude/session-bound-to-credentials` in remote-insight-os (profile-api
source + `profile-api/` mirror), rios-profile-api, hall731-rios-gate and
rios-chat. HELD. Auth change: qa reviews before anything is offered for merge.

## Why

The pre-launch clean (`docs/ops/prelaunch-clean/`) wipes `va_credentials`. Cody
decided (9 Oct 2026) **not** to rotate `GATE_SESSION_SECRET` or
`CHAT_SESSION_SECRET`. Without this change, a VA signed in before the wipe would
stay in for up to 12 hours (gate) or 24 hours (chat). With it, the wipe ends
every VA session at once.

## The rule

A VA session (gate or chat) is live only while **both** hold:

1. the VA still has a `va_credentials` row;
2. the session was issued (`iat`, whole seconds) **at or after** that row's
   `created_at`.

Anything else is signed out, with the same generic message as a failed sign-in
(no enumeration).
- A token with no `iat`, or a malformed one, is treated as expired.
- Gate sessions already require `iat`.
- Chat now requires it too.

**Net effect:**
1. Run the SQL wipe: every VA is signed out on every device at their next
   request.
2. An admin issues a fresh access code, which creates a new row.
3. The VA signs in with the code and sets a password. Setting a password updates
   the row and keeps `created_at`.
4. The new session is valid, because it was issued after the row.

## Where it is checked

- **profile-api** (`va-credential-check`, new `action: "session"`, the existing
  credentials-purpose token): `{ iat }` → `{ ok, live }`. It reads
  `created_at` only, and only the boolean leaves. Identity comes from the
  verified claim. Store down → 502.
- **gate:** `chat-unread`, `home-widgets`, `mint-chat-token`,
  `mint-profile-token`, `submit-survey` and `updates` each ask profile-api once
  per request, after the signature check passes.
  - Not live → 401 with the generic sign-in message.
  - profile-api unreachable → 503 "couldn't check". This refuses the request
    without signing the VA out over a blip.
  - The page, on a 401 from any of these while signed in, drops the in-memory
    login, stops the polls, closes chat, and shows the sign-in screen with the
    generic message.
- **chat:** every VA session read (`_thread-auth`, `session-check`, `sso-in`
  reusing an existing session, `va-unread`) checks the same row directly, with
  chat's existing Supabase access to the shared project. No new env var.
  - Not live → treated as no session (401 / `authed:false` / the reauth
    landing).
  - Store down → refused.
  - Admin (`x-admin-key`) and client sessions are untouched.
- `va-login` and `va-set-password` are unchanged. They mint a new session only
  after a real credential check, so the new session's `iat` is after the row.

## Not changed

- No new env var, no secret, no rotation.
- No name + email path, no backdoor.
- Client and admin auth.
- The 12 h / 24 h TTLs.

## Known limits

- **A single-VA reset doesn't end their live sessions.** `va-passcode.js reset`
  PATCHes the existing row and keeps `created_at`, so that VA's open sessions
  survive until expiry. The wipe is the case this story covers. Ending sessions
  on a reset is a one-line follow-up: compare against a reset time as well.
- **Cost:** one small read per authenticated request. Chat polls every 8 s
  while open, and the gate polls unread every 30 s.

## Acceptance

1. profile-api: no row → `live:false`; `iat` before `created_at` → false; at or
   after → true; missing or malformed `iat` → false; only `{ok, live}` leaves; the
   read selects `created_at` only; a body `va_key` is ignored; a non-purpose token
   → 401; store down → 502.
2. gate: each of the six endpoints answers the generic 401 for a dead session and
   503 when profile-api is unreachable. A valid signature alone is no longer
   enough. A live session behaves exactly as before. The page returns to sign-in
   on a session 401.
3. chat: a VA session with no row, an older `iat`, or no `iat` is refused on
   every VA path. A live one works as before. Admin and client unaffected.
4. Tests written failing-first in all repos; every suite green.
