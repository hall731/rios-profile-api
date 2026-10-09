# VA availability on the client Home

Branch `claude/va-availability` in `rios-client`, `remote-insight-os` (the
profile-api source of truth) and `rios-profile-api` (its deployed mirror).
HELD. Not deployed. Client-facing: qa reviews before anything is opened.

## Why

A client should know ahead of time when their assistant won't be working:
company holidays, and time off the team has approved. Today the client portal
says nothing, and the client finds out when a message goes unanswered.

## What the client sees

A "VA availability" section on Home, under the stats row (where the VA Home
carries its updates feed). For the client's OWN assigned VA(s) only, a dated
list of the next 90 days, soonest first:

- **Holidays:** "Maya is off Nov 20 (Revolution Day)". With two VAs on the
  same holiday: "Maya and Tomás are off Nov 20 (Revolution Day)".
- **Approved time off:** "Maya — approved time off, Oct 20–22". A single day
  reads "Oct 20"; a range across months "Oct 30 – Nov 2". The year is shown
  only when it isn't this year.
- A short note under the heading, because holidays are the usual pattern, not
  a promise (the policy lets a client ask a VA to work one): "Holidays your
  VA usually has off, and time off our team has approved. Plans can change —
  your account team can help if you need cover."
- Nothing coming up: "No holidays or time off in the next 90 days." A failed
  load: "We couldn't check availability right now." Legacy (no session)
  sign-ins: the section is not shown.
- en + es. Absolute dates. First names only. they/them, no pronouns.

## Privacy (hard rule 1: the work, never the person)

Only **dates** and the fact that the VA is off leave the server. Never:
- the time-off `kind` (`vacation` / `sick` / `other` — "sick" is health),
- the admin `note` (free text, "never returned to a VA or client"),
- row ids, counted days, allowance, who entered it, or anything else.
Sick days and vacation look identical to the client. The response is built as
an explicit literal at TWO layers (profile-api, then again in rios-client's
function), the same defence-in-depth the portal uses for the read.

## Data

- **Holidays source:** the existing `public.holidays` table (migration
  `20260924120000_calendar.sql`), admin-editable from the dashboard Calendar
  tab; `holidays.json` was NOT created because a source already exists and
  already feeds the admin calendar. Shown: live rows (`deleted_at is null`)
  with region `ALL` or `MX`. Nothing records a VA's region, and the day-count
  math already assumes `MX`; US holidays are not shown to clients until a VA
  region exists.
- **Approved time off:** `public.va_time_off` live rows. There is no
  status column and no request flow: only admins create rows, so every live
  row is approved time off. Pending requests do not exist in the data today.
- **Which VAs:** the client's live assignments, read from
  `client_assignments` (`unassigned_at is null`) server-side on every
  request, NOT the `va_keys` copied into the 30-day session — so a VA moved to
  another client disappears from this list immediately.

## Shape

profile-api `client-availability` (client-audience identity token only; a VA
token is 403; purpose tokens refused as on every endpoint):

    { ok:true, from:"YYYY-MM-DD", to:"YYYY-MM-DD",
      vas:[ { va:"Maya Restrepo", timeOff:[ { start:"YYYY-MM-DD", end:"YYYY-MM-DD" } ] } ],
      holidays:[ { day:"YYYY-MM-DD", name:"Revolution Day" } ] }

rios-client `client-availability` (same-origin, session cookie): mints the
identity token server-side like `client-documents`, calls profile-api,
rebuilds the same literal, 401 without a session, 503 when profile-api fails.

## Acceptance

1. A client token gets only its live-assigned VAs' rows; a VA token is 403;
   no token / bad token is 401; another client's VA never appears.
2. The response has exactly the fields above; `kind`, `note`, ids and counts
   never appear (asserted on the raw body at both layers).
3. Only live rows; only rows overlapping today..today+90; holidays limited to
   ALL/MX in the same window.
4. Home renders the dated list soonest first, holidays merged across VAs,
   absolute dates, en + es; empty and failure lines; hidden on legacy.
5. Tests written first and failing; every suite green.

## Not in this story

A time-off request/approval flow, VA regions, US holidays for clients, email
alerts, the admin calendar itself.
