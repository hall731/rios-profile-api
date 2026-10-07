-- =============================================================================
-- va_credentials / va_credential_events — a VA password on the gate login
-- (docs/stories/va-secure-login.md)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- Depends on: public.profiles (va_key unique).
--
-- One row per VA. The password and the temporary passcode are stored ONLY as
-- scrypt hashes (scrypt$N$r$p$salt$hash, the same format admins.password_hash
-- uses); plaintext never touches the database. The passcode is time-limited
-- (temp_expires_at, 7 days) and single-use: set_password clears it in the same
-- update that stores the password hash.
--
-- A VA with NO row here signs in as today (name + email only) until an admin
-- issues them a passcode. That is the rollout posture, not a gap.
--
-- Access posture: service-role only (profile-api checks, the dashboard
-- issues/resets). RLS enabled + forced with NO policies. select/insert/update
-- grants, NO delete (a VA's credentials are reset, never removed; profiles are
-- never hard-deleted either).
-- =============================================================================

create table if not exists public.va_credentials (
  va_key                     text        primary key
                                         references public.profiles(va_key)
                                         on update cascade on delete cascade,
  password_hash              text,                                   -- scrypt$...; null until the VA sets one
  password_set_at            timestamptz,
  temp_passcode_hash         text,                                   -- scrypt$...; null once used or never issued
  temp_expires_at            timestamptz,
  temp_issued_at             timestamptz,
  temp_issued_by_admin_email text,
  must_reset                 boolean     not null default true,      -- true until the VA sets their own password
  failed_attempts            integer     not null default 0 check (failed_attempts >= 0),
  locked_until               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint va_credentials_hash_shape check (
    (password_hash      is null or password_hash      like 'scrypt$%') and
    (temp_passcode_hash is null or temp_passcode_hash like 'scrypt$%')
  ),
  constraint va_credentials_temp_paired check (
    (temp_passcode_hash is null) = (temp_expires_at is null)
  )
);

-- Security audit of credential changes: who issued or reset what, and when a
-- VA set their password or got locked. NOT analytics: no login events here (the
-- existing `login` event in events covers that, disclosed by the acknowledgment).
create table if not exists public.va_credential_events (
  id                 uuid        primary key default gen_random_uuid(),
  va_key             text        not null,
  kind               text        not null check (kind in ('passcode_issued','reset_forced','password_set','locked')),
  actor_admin_email  text,                                           -- null when the VA acted (password_set) or the system did (locked)
  at                 timestamptz not null default now()
);
create index if not exists va_credential_events_va_idx on public.va_credential_events (va_key, at desc);

alter table public.va_credentials       enable row level security;
alter table public.va_credentials       force  row level security;
alter table public.va_credential_events enable row level security;
alter table public.va_credential_events force  row level security;
revoke all on public.va_credentials       from anon, authenticated;
revoke all on public.va_credential_events from anon, authenticated;
grant select, insert, update on public.va_credentials       to service_role;   -- no delete: reset, never remove
grant select, insert         on public.va_credential_events to service_role;   -- append-only
