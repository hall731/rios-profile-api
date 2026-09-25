-- =============================================================================
-- va_profiles — VA personal profiles + append-only change audit  (Stage 1: DB only)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in this repo runs it automatically.
--
-- Stage 1 is DATABASE ONLY. No app code, no Netlify function, and no UI reads or
-- writes these tables yet. This migration creates the shape + the access posture
-- and nothing else. The reader/writer/admin form/VA view are later stages.
--
-- Access posture mirrors 20260819160000_admins.sql EXACTLY:
--   * The service-role key is the ONLY credential that touches these tables, and
--     it stays SERVER-SIDE in the dashboard's Netlify functions — never a browser.
--   * RLS ENABLED and FORCED, with NO policies -> anon/authenticated denied.
--   * Explicit TABLE grants to service_role (service_role bypasses RLS but still
--     needs table privileges — the 42501 lesson). NO delete on profiles;
--     profile_history is select+insert ONLY (audit rows are immutable).
--
-- SENSITIVE DATA — Hard Rule 1: none of this ever reaches a client, judge output,
-- or any signal. profiles holds DOB, home address, personal email, emergency
-- contact, and a bank CLABE. The CLABE is stored ENCRYPTED at rest in
-- `payment_clabe_encrypted`; `payment_bank_name` and `payment_clabe_last4` are
-- stored SEPARATELY in plaintext so the admin UI and the VA view can show a masked
-- value (e.g. "•••• 1234, BBVA") WITHOUT decrypting anything.
--
-- ENCRYPTION IS NOT FINALIZED HERE. `payment_clabe_encrypted` is a deliberately
-- scheme-agnostic ciphertext column (opaque text). The key-management approach —
-- app-layer AES with a dashboard env key, pgcrypto with a key passed at query
-- time, or Supabase Vault — is Cody's decision. See
-- specs/va-profile-stage1.md ("Encrypting the CLABE"). If the chosen scheme wants
-- raw bytes instead of text, the column type is the one line to change at apply
-- time; text/base64 (or PGP-armored) is the safe cross-scheme default.
-- =============================================================================

begin;

-- gen_random_uuid() — mirror the admins migration, which relies on pgcrypto for
-- UUID generation. `if not exists` makes this a no-op when it is already present.
-- (pgcrypto ALSO provides pgp_sym_encrypt/decrypt, but this migration does NOT
-- itself encrypt anything — see the encryption note above.)
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- profiles — one row per VA, current state.
-- -----------------------------------------------------------------------------
-- Identity is the surrogate `id` (uuid), NEVER the VA name. `va_key` is a UNIQUE
-- lookup/join column, not the primary key, so a display-name change does not
-- reassign the row's identity or break profile_history references (see the
-- orphaning note in specs/va-profile-stage1.md). Nearly every field is optional;
-- a record may carry any one, all, or none. Only `va_key` is required + unique.
create table if not exists public.profiles (
  id                          uuid        primary key default gen_random_uuid(),

  -- Canonical signal-config.json display-name KEY. Changed only by an explicit,
  -- audited admin "rename" (a logged profile_history row) — never a silent side
  -- effect of editing a name elsewhere. Stored as-is (the canonical key), never
  -- normalized on write.
  va_key                      text        not null unique,

  full_legal_name             text,
  dob                         date,

  -- Structured Mexico address (legible + correctable, not one blob).
  address_line1               text,
  address_line2               text,
  address_city                text,
  address_state               text,
  address_postal_code         text,
  address_country             text        not null default 'MX',

  -- Stored AS ENTERED — do not normalize on write (same discipline as the login
  -- key). Country code is part of what the admin types.
  phone                       text,

  -- Personal email — not necessarily the login email. Admin-only, never client-facing.
  personal_email              text,

  emergency_contact_name      text,
  emergency_contact_relation  text,
  emergency_contact_phone     text,

  engagement_type             text        not null default 'Independent Contractor',

  -- Active/departed flag. A VA is deactivated here (never hard-deleted — there is
  -- no delete grant), so identity + audit persist. Stage 2 decides which surfaces
  -- read this (grid / survey gate / chat). Inert until then.
  is_active                   boolean     not null default true,

  role                        text,
  start_date                  date,

  -- Payment (bank CLABE). See the encryption note at the top of this file.
  --   * payment_clabe_encrypted — OPAQUE CIPHERTEXT of the 18-digit CLABE. The DB
  --     never sees the plaintext CLABE and never the encryption key (under the
  --     recommended app-layer scheme). Format is fixed once Cody picks the scheme.
  --   * payment_bank_name       — plaintext, low-sensitivity, for display.
  --   * payment_clabe_last4     — plaintext last 4 digits, for masked display
  --     WITHOUT decrypting. Exactly 4 digits when present.
  payment_clabe_encrypted     text,
  payment_bank_name           text,
  payment_clabe_last4         text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint profiles_clabe_last4_ck
    check (payment_clabe_last4 is null or payment_clabe_last4 ~ '^[0-9]{4}$')
);

-- -----------------------------------------------------------------------------
-- profile_history — append-only audit of admin changes. Admin-only; NEVER shown
-- to a VA. One row per changed field per admin action.
-- -----------------------------------------------------------------------------
-- changed_by_admin_id references admins.id BY CONVENTION but is intentionally NOT
-- a foreign key: the audit trail is a standalone immutable record and must survive
-- independently of the admins table. changed_by_admin_email is a SNAPSHOT so the
-- record still names the actor even if that admin's email later changes.
--
-- va_key here is likewise a SNAPSHOT of the key at change time, so the history of
-- who-changed-what survives a later rename.
--
-- SENSITIVE-VALUE GUARD (defense in depth): the CLABE ciphertext must NEVER be
-- copied into old_value/new_value — a payment change logs field
-- 'payment_clabe_encrypted' with BOTH values NULL (the app records a bare
-- "payment account changed" with no values). The CHECK below makes that
-- structural, not merely a convention. Add any future field we deem sensitive to
-- the same NOT-IN list.
create table if not exists public.profile_history (
  id                      uuid        primary key default gen_random_uuid(),
  profile_id              uuid        not null references public.profiles(id),
  va_key                  text        not null,
  field                   text        not null,
  old_value               text,
  new_value               text,
  changed_by_admin_id     uuid        not null,
  changed_by_admin_email  text        not null,
  changed_at              timestamptz not null default now(),

  constraint profile_history_no_sensitive_values_ck
    check (
      field not in ('payment_clabe_encrypted')
      or (old_value is null and new_value is null)
    )
);

-- Lookups: a VA's full history, ordered newest-first.
create index profile_history_profile_id_changed_at_idx
  on public.profile_history (profile_id, changed_at desc);
-- Cross-reference by the key snapshot (e.g. tracing a rename).
create index profile_history_va_key_idx
  on public.profile_history (va_key);

-- -----------------------------------------------------------------------------
-- Row Level Security — ENABLED + FORCED, NO policies (mirror admins exactly).
-- -----------------------------------------------------------------------------
-- The browser NEVER touches these tables; all access is server-side via the
-- service_role, which BYPASSES RLS. RLS on with no policy denies anon and
-- authenticated outright. DO NOT add a permissive policy to "make it work".
alter table public.profiles         enable row level security;
alter table public.profiles         force  row level security;
alter table public.profile_history  enable row level security;
alter table public.profile_history  force  row level security;

revoke all on public.profiles        from anon, authenticated;
revoke all on public.profile_history from anon, authenticated;

-- service_role bypasses RLS but still needs TABLE privileges (the 42501 lesson).
-- Grant EXACTLY what the app path uses, nothing more:
--   profiles         — select, insert, update. NO delete (a VA is deactivated
--                      later via is_active, never hard-deleted; identity +
--                      audit must persist).
--   profile_history  — select, insert ONLY. NO update, NO delete: audit rows are
--                      immutable once written.
grant select, insert, update on public.profiles        to service_role;
grant select, insert         on public.profile_history to service_role;

commit;

-- Tell PostgREST to reload its schema cache so the new tables + columns are
-- visible to the REST API immediately after apply (run this after the commit).
notify pgrst, 'reload schema';

-- =============================================================================
-- ROLLBACK NOTES (manual; run inside a transaction if reverting):
--   drop table if exists public.profile_history;
--   drop table if exists public.profiles;
--   -- (leave the pgcrypto extension in place; other objects depend on it)
--   notify pgrst, 'reload schema';
-- =============================================================================
