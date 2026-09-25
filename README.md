# rios-profile-api

Four endpoints, all VA-facing, all verified by the same gate-minted token:

| Function | Does |
|---|---|
| `va-profile-read` | the VA's own profile, read-only and masked (Stage 2b) |
| `ack-status` | has this VA acknowledged the current privacy document? Returns the text + hash (Stage 2/3) |
| `ack-accept` | log the acknowledgment; refuses a stale version (Stage 2/3) |
| `events-ingest` | session telemetry; refuses everything until the acknowledgment exists (Stage 1/3) |

Nothing else. No admin surface, no write path to a profile, no CLABE decrypt.

## Why this exists as its own site

The VA's profile lives in the admin dashboard's Supabase, behind a service-role
key. The gate (where the VA is logged in) must never hold that key, so the gate
mints a short-lived signed token and the dashboard does the reading.

That worked in design and not in production: the dashboard's Netlify site sits
behind a **site-level password**, and that password also covers
`/.netlify/functions/*`. Netlify has **no way to exempt a single path** from it
— it is one site-wide toggle, with no `netlify.toml` key, `_headers` directive
or UI setting that scopes it.

So the function moves, and the password stays exactly where it is. That password
is the only thing keeping `signal-config.json` — every VA and client first name,
last name and email — from being served as a public static file. Turning it off
to make this endpoint reachable would trade a masked read for a full roster leak.

**This site is strictly smaller than the dashboard, not a hole in it.** It holds
four functions and four environment values. It has no `GH_TOKEN`, so it cannot read
the repo; no `ADMIN_KEY`, so it is not an admin surface; no `PROFILE_ENC_KEY`, so
it cannot decrypt a CLABE even if someone asked it to. And it publishes nothing.

## The empty publish directory is the load-bearing part

`netlify.toml` sets `publish = "public"` and creates that directory at build
time. Nothing is ever committed into it. With no static assets, this host cannot
serve `signal-config.json` — or any other file — even by accident. Every path
except `/.netlify/functions/va-profile-read` returns 404.

**Do not** give this site a publish directory with content in it, and **do not**
point `publish` at a repo root. If this host ever starts serving static files, it
is serving somebody's personal data.

## Deploy

1. Create the Netlify site from this repo.
2. **Name the site `rios-profile-api`**, so its URL is
   `https://rios-profile-api.netlify.app`. The gate hardcodes this as
   `DASH_ORIGIN` (it is a static page, so it cannot read an env var). A
   different site name means editing and redeploying the gate.
3. Build settings — these come from `netlify.toml`, but confirm them in the UI:
   - Build command: `mkdir -p public`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
4. **Leave site-level password protection OFF.** The SSO token *is* this
   endpoint's authentication; a password would block the VA's browser exactly as
   it does on the dashboard.
5. Set these four environment variables, and only these four:

   | Variable | What it is |
   |---|---|
   | `SUPABASE_URL` | the project URL (same value the dashboard uses) |
   | `SUPABASE_SERVICE_ROLE_KEY` | service-role key — server-only, never in a browser |
   | `PROFILE_SSO_SECRET` | the HS256 secret shared with the gate. **Not** `CHAT_SSO_SECRET` |
   | `PROFILE_GATE_ORIGINS` | comma-separated extra allowed origins (gate deploy previews). Optional |

   **Do not set** `GH_TOKEN`, `GH_REPO`, `GH_BRANCH`, `ADMIN_KEY`, or
   `PROFILE_ENC_KEY` here. None of them are read by this code, and each one
   would widen what a compromise of this site is worth.

The two production gate origins (`https://remoteinsightos.com` and
`https://www.remoteinsightos.com`) are compiled in. `PROFILE_GATE_ORIGINS` is
for preview hosts — without it you cannot review this on a Netlify deploy
preview, because the browser will block the cross-origin response.

## Verifying it after deploy

```
# 1. Reachable at all — no password page. Expect 405 (it is POST-only).
curl -s -o /dev/null -w "%{http_code}\n" \
  https://rios-profile-api.netlify.app/.netlify/functions/va-profile-read

# 2. No token => generic 401, and no hint about which check failed.
curl -s -X POST https://rios-profile-api.netlify.app/.netlify/functions/va-profile-read

# 3. NOTHING static is served. All three must be 404.
for p in / /signal-config.json /index.html; do
  curl -s -o /dev/null -w "$p -> %{http_code}\n" "https://rios-profile-api.netlify.app$p"
done
```

Step 3 is the one to actually run after every config change to this site.

## These files are COPIES

`netlify/functions/*`, `tests/va-profile-read.test.js` and the migration are
copies of files in `hall731/remote-insight-os`, which is the **source of truth**.
Copies drift — this codebase has been bitten by that before, with `matchVA`
duplicated across the gate and chat. So check it with a script, not by eye:

```
SRC=../remote-insight-os bash scripts/verify-sync.sh
```

Run it before every deploy. If anything has drifted, copy the dashboard's
version over, run `npm test`, and redeploy.

## Tests

```
npm test
```

23 tests, no dependencies. They cover the fail-closed verify order, the
audience boundary (a chat token cannot open a profile), the column whitelist
against the real migration, CLABE masking, the CORS allowlist, and the absence
of any write path.
