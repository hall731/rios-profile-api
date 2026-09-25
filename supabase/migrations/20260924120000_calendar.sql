-- =============================================================================
-- holidays / va_time_off — the VA calendar (Stage 5, specs/va-calendar.md)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- Depends on: public.profiles (the va_time_off FK is the "a VA must have a
-- profile" rule).
--
-- holidays    : ONE shared calendar (MX + US), admin-editable, applies to everyone.
-- va_time_off : per-VA time off. Rows are IMMUTABLE — an "edit" is a tombstone
--               plus a new row, so the audit is the table itself.
-- Allowance   : 6 vacation days per CALENDAR YEAR, company-wide, no carryover
--               (DECIDED 2026-09-24). It is a named constant in _calendar-db.js,
--               not a column; the counter is DERIVED, never stored.
--
-- Access posture mirrors 20260819160000_admins.sql: service-role only, RLS
-- enabled + forced with NO policies, select/insert/update grants, NO delete.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.holidays (
  id          uuid        primary key default gen_random_uuid(),
  day         date        not null,
  name        text        not null,
  region      text        not null check (region in ('MX','US','ALL')),
  created_by_admin_email text not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text,
  constraint holidays_name_nonblank check (length(btrim(name)) > 0),
  constraint holidays_tombstone_paired check ((deleted_at is null) = (deleted_by is null))
);
create unique index if not exists holidays_live_day_region
  on public.holidays (day, region) where deleted_at is null;
create index if not exists holidays_day_idx on public.holidays (day);

create table if not exists public.va_time_off (
  id          uuid        primary key default gen_random_uuid(),
  va_key      text        not null references public.profiles (va_key),   -- a VA must have a profile
  start_day   date        not null,
  end_day     date        not null,
  kind        text        not null check (kind in ('vacation','sick','other')),
  note        text,                                                        -- admin-facing only; never returned to a VA or client
  created_by_admin_id    uuid not null,
  created_by_admin_email text not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  text,
  constraint va_time_off_range check (end_day >= start_day),
  constraint va_time_off_tombstone_paired check ((deleted_at is null) = (deleted_by is null))
);
create index if not exists va_time_off_va_start_idx on public.va_time_off (va_key, start_day);

alter table public.holidays    enable row level security;
alter table public.holidays    force  row level security;
alter table public.va_time_off enable row level security;
alter table public.va_time_off force  row level security;
revoke all on public.holidays    from anon, authenticated;
revoke all on public.va_time_off from anon, authenticated;
grant select, insert, update on public.holidays    to service_role;   -- update = tombstone only
grant select, insert, update on public.va_time_off to service_role;   -- update = tombstone only

commit;

notify pgrst, 'reload schema';

-- ROLLBACK NOTES (manual, inside a transaction):
--   drop table if exists public.va_time_off;
--   drop table if exists public.holidays;
--   notify pgrst, 'reload schema';
