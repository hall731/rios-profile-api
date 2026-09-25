-- =============================================================================
-- events — append-only product/session telemetry for VA, client and admin
-- sessions (Stage 1: telemetry piping).
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- WHAT THIS IS: cheap, queryable rows — logins, last-active pings, which surface
-- was touched, messages sent. Standard session analytics.
-- WHAT THIS IS NOT: continuous dwell tracking. There is no per-second heartbeat
-- here; an `active` row is written at most once per surface open, and a
-- session's duration is DERIVED (max(at) - min(at) per session_id), capped.
--
-- DISCLOSURE: VA-side capture is disclosed to the VA by the first-login
-- acknowledgment (Stage 2, `acknowledgments`). Client-side likewise. Nothing
-- here is written for a VA or client before that acknowledgment exists.
--
-- Access posture mirrors 20260819160000_admins.sql EXACTLY:
--   * service-role ONLY, server-side, never a browser.
--   * RLS ENABLED and FORCED, NO policies -> anon/authenticated denied.
--   * grants: select + insert ONLY. No update, no delete — a telemetry row is
--     immutable, enforced additionally by a trigger that fires for every role.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.events (
  id           uuid        primary key default gen_random_uuid(),
  at           timestamptz not null default now(),

  -- Who. subject_key is the canonical identity for that audience:
  --   va     -> the signal-config.json KEY (never typed input)
  --   client -> clients.id (Stage 4) as text
  --   admin  -> the admin's email as stored in admins.email
  audience     text        not null check (audience in ('va','client','admin')),
  subject_key  text        not null,

  -- Opaque per-login id (random, minted at login, carried in the session).
  -- Groups one session's rows; NULL only for rows written outside a session.
  session_id   text,

  -- The vocabulary. Kept deliberately small — add a value here (and in
  -- _events-db.js EVENT_KINDS) rather than smuggling new kinds into meta.
  kind         text        not null check (kind in ('login','active','surface','message_sent','logout')),

  -- Which feature was touched (kind='surface'/'active'). One named list.
  surface      text        check (surface in ('home','va_read','chat','docs','nps','survey','profile','calendar','settings')),

  -- Small structured extras (e.g. { "thread_kind": "va_client" }). Never PII,
  -- never message bodies, never document titles.
  meta         jsonb       not null default '{}'::jsonb,

  constraint events_subject_nonblank check (length(btrim(subject_key)) > 0),
  constraint events_surface_when_relevant check (kind not in ('surface','active') or surface is not null)
);

-- Per-user timeline (the admin summary's main scan) and per-kind scans.
create index if not exists events_subject_at_idx on public.events (audience, subject_key, at desc);
create index if not exists events_kind_at_idx    on public.events (kind, at desc);
create index if not exists events_session_idx    on public.events (session_id) where session_id is not null;
create index if not exists events_at_idx         on public.events (at desc);

-- Append-only, for EVERY role including service_role and the owner.
create or replace function public.enforce_events_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'events is append-only: % is forbidden', tg_op;
end;
$$;
drop trigger if exists events_append_only on public.events;
create trigger events_append_only
  before update or delete on public.events
  for each row execute function public.enforce_events_append_only();

alter table public.events enable row level security;
alter table public.events force  row level security;
revoke all on public.events from anon, authenticated;
grant select, insert on public.events to service_role;

commit;

notify pgrst, 'reload schema';

-- =============================================================================
-- RETENTION (not implemented here): rows are cheap; revisit a 13-month purge
-- once volume is known. A purge would need a SECURITY DEFINER routine that
-- suspends the append-only trigger — a deliberate, separate migration.
-- ROLLBACK NOTES (manual, inside a transaction):
--   drop trigger if exists events_append_only on public.events;
--   drop function if exists public.enforce_events_append_only();
--   drop table if exists public.events;
--   notify pgrst, 'reload schema';
-- =============================================================================
