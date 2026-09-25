-- =============================================================================
-- acknowledgments — first-login privacy acknowledgment log (Stage 2)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- One row per acceptance: WHO (audience + canonical subject key), WHICH document
-- (version + sha256 of the exact text shown), WHEN. Append-only, immutable.
-- A portal gates first entry on a row existing for the CURRENT version; a
-- version bump means a new row is required. Every per-feature disclosure in
-- RIOS points at this document rather than carrying its own notice.
--
-- Not stored on purpose: IP address, user agent, geolocation. The record proves
-- that this person accepted this text at this time; it does not profile them.
--
-- Access posture mirrors 20260819160000_admins.sql: service-role only,
-- RLS enabled + forced with NO policies, select + insert grants only, and an
-- append-only trigger for every role.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.acknowledgments (
  id           uuid        primary key default gen_random_uuid(),
  -- 'va'     -> subject_key is the canonical signal-config.json KEY
  -- 'client' -> subject_key is clients.id (Stage 4) as text
  audience     text        not null check (audience in ('va','client')),
  subject_key  text        not null,
  doc_version  text        not null,   -- e.g. '2026-09-24-draft'; bump = re-acknowledge
  doc_sha256   text        not null,   -- sha256 (hex) of the exact text shown
  accepted_at  timestamptz not null default now(),
  constraint acknowledgments_subject_nonblank check (length(btrim(subject_key)) > 0),
  constraint acknowledgments_version_nonblank check (length(btrim(doc_version)) > 0),
  constraint acknowledgments_sha_shape       check (doc_sha256 ~ '^[0-9a-f]{64}$')
);

-- "Latest acceptance for this person" is the only query that matters.
create index if not exists acknowledgments_subject_idx
  on public.acknowledgments (audience, subject_key, accepted_at desc);

create or replace function public.enforce_acknowledgments_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'acknowledgments is append-only: % is forbidden', tg_op;
end;
$$;
drop trigger if exists acknowledgments_append_only on public.acknowledgments;
create trigger acknowledgments_append_only
  before update or delete on public.acknowledgments
  for each row execute function public.enforce_acknowledgments_append_only();

alter table public.acknowledgments enable row level security;
alter table public.acknowledgments force  row level security;
revoke all on public.acknowledgments from anon, authenticated;
grant select, insert on public.acknowledgments to service_role;

commit;

notify pgrst, 'reload schema';

-- ROLLBACK NOTES (manual, inside a transaction):
--   drop trigger if exists acknowledgments_append_only on public.acknowledgments;
--   drop function if exists public.enforce_acknowledgments_append_only();
--   drop table if exists public.acknowledgments;
--   notify pgrst, 'reload schema';
