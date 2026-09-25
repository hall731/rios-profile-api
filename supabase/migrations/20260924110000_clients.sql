-- =============================================================================
-- clients / client_assignments / client_history — the client identity system
-- (Stage 4, specs/client-identity.md, multi-VA per client is V1)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- Depends on: public.profiles (20260824170000_va_profiles.sql) — the FK below
-- is the "a VA must have a profile" rule, enforced by the database.
--
-- WHAT A CLIENT IS: a first-class row with a uuid identity and a login trio
-- (first, last, email) stored AS ENTERED. Matching at the door folds case,
-- accents and spacing (same norm() as _cfgKey); the identity written anywhere
-- is clients.id, never a concatenation of the fields, never normalized.
--
-- THE ASSIGNMENT RULES ARE STRUCTURAL, PER ASSIGNMENT:
--   * client_id references clients(id)      -> a client must have a profile
--   * va_key    references profiles(va_key)  -> a VA must have a profile
--   * a client may have MANY live VAs (partial unique on the pair)
--   * a VA has at most ONE live client in V1 (partial unique on va_key) —
--     this matches today's one-`client`-per-VA record in signal-config.json
--     and is what keeps the publish bridge in save-settings.js valid.
--     Lifting it later = drop ONE index, no data change.
--
-- Revocation is a tombstone (unassigned_at), never a delete; deactivating a
-- client tombstones its live assignments in the same request (clients.js).
-- Every change is a client_history row (append-only, mirrors profile_history).
--
-- Access posture mirrors 20260819160000_admins.sql: service-role only, RLS
-- enabled + forced with NO policies, explicit grants, NO delete anywhere.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.clients (
  id           uuid        primary key default gen_random_uuid(),
  first_name   text        not null,
  last_name    text        not null,
  email        text        not null,
  company      text,
  is_active    boolean     not null default true,   -- revoke = deactivate; never delete
  created_by_admin_email text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint clients_first_nonblank check (length(btrim(first_name)) > 0),
  constraint clients_last_nonblank  check (length(btrim(last_name))  > 0),
  constraint clients_email_shape    check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

-- One LIVE client per email. A deactivated client frees the email for a new
-- record (the old row and its history stay).
create unique index if not exists clients_email_lower_live
  on public.clients (lower(btrim(email))) where is_active;

create table if not exists public.client_assignments (
  id            uuid        primary key default gen_random_uuid(),
  client_id     uuid        not null references public.clients (id),        -- client must have a profile
  va_key        text        not null references public.profiles (va_key),   -- VA must have a profile
  assigned_at   timestamptz not null default now(),
  assigned_by_admin_email text not null,
  unassigned_at timestamptz,
  unassigned_by text,
  constraint client_assignments_tombstone_paired
    check ((unassigned_at is null) = (unassigned_by is null))
);

-- V1: a VA has at most one live client.
create unique index if not exists client_assignments_live_va
  on public.client_assignments (va_key) where unassigned_at is null;
-- No duplicate live pair (a client may have many VAs).
create unique index if not exists client_assignments_live_pair
  on public.client_assignments (client_id, va_key) where unassigned_at is null;
create index if not exists client_assignments_client_idx
  on public.client_assignments (client_id, assigned_at desc);

-- Append-only audit, mirroring profile_history. client_id is NOT a foreign key
-- on purpose: the audit must survive independently of the clients table.
create table if not exists public.client_history (
  id                      uuid        primary key default gen_random_uuid(),
  client_id               uuid        not null,
  field                   text        not null,      -- e.g. 'first_name', 'is_active', 'assignment'
  old_value               text,
  new_value               text,
  changed_by_admin_id     uuid        not null,
  changed_by_admin_email  text        not null,
  changed_at              timestamptz not null default now()
);
create index if not exists client_history_client_idx
  on public.client_history (client_id, changed_at desc);

create or replace function public.enforce_client_history_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'client_history is append-only: % is forbidden', tg_op;
end;
$$;
drop trigger if exists client_history_append_only on public.client_history;
create trigger client_history_append_only
  before update or delete on public.client_history
  for each row execute function public.enforce_client_history_append_only();

alter table public.clients            enable row level security;
alter table public.clients            force  row level security;
alter table public.client_assignments enable row level security;
alter table public.client_assignments force  row level security;
alter table public.client_history     enable row level security;
alter table public.client_history     force  row level security;

revoke all on public.clients            from anon, authenticated;
revoke all on public.client_assignments from anon, authenticated;
revoke all on public.client_history     from anon, authenticated;

grant select, insert, update on public.clients            to service_role;   -- no delete
grant select, insert, update on public.client_assignments to service_role;   -- no delete (tombstone)
grant select, insert         on public.client_history     to service_role;   -- immutable

commit;

notify pgrst, 'reload schema';

-- ROLLBACK NOTES (manual, inside a transaction):
--   drop trigger if exists client_history_append_only on public.client_history;
--   drop function if exists public.enforce_client_history_append_only();
--   drop table if exists public.client_history;
--   drop table if exists public.client_assignments;
--   drop table if exists public.clients;
--   notify pgrst, 'reload schema';
