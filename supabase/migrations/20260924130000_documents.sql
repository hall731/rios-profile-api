-- =============================================================================
-- documents / document_views + Storage bucket `va-documents` (Stage 6,
-- specs/va-documents.md)
-- =============================================================================
-- ***  REVIEW BEFORE APPLYING  ***
-- Do NOT run this against live Supabase without Cody's sign-off. Cody applies it
-- by hand (direct-pg) after review. Nothing in any repo runs it automatically.
--
-- Depends on: public.profiles, public.clients (Stages 1-4 migrations).
--
-- Work documents attached to a VA. Objects live in a PRIVATE bucket; rows here
-- are the index. Object path = profiles/<profile uuid>/<document uuid>.<ext> —
-- the uuid, never the va_key (spaces, accents). Objects are reachable only via
-- short-lived signed URLs minted server-side.
--
-- LIMITS (DECIDED 2026-09-24): 100 MB per file (CHECK below), 5 GB per VA in
-- total (enforced in the upload function by summing live rows — a SUM is not a
-- CHECK). Allowed types in ONE named CHECK, like attachments_file_type_allowed.
--
-- VIEW TRACKING: one row per OPEN, with open + close timestamps. Duration is
-- closed_at - opened_at, computed at read time. A row with no close is
-- "opened, duration unknown" once it is older than the orphan window (30 min,
-- _documents-db.js) — NEVER an infinite or still-running value. This is
-- disclosed to the VA by the first-login acknowledgment (Stage 2) and by a line
-- on the Documents panel; metrics are ADMIN-ONLY, never shown to a VA or client.
--
-- Access posture: service-role only, RLS enabled + forced with NO policies,
-- select/insert/update grants, NO delete (documents tombstone; views immutable
-- except closed_at). Bucket is private with NO object policies.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.documents (
  id             uuid        primary key default gen_random_uuid(),
  profile_id     uuid        not null references public.profiles (id),
  va_key         text        not null,                              -- snapshot; survives a rename
  title          text        not null check (length(btrim(title)) between 1 and 200),
  storage_path   text        not null unique,
  file_type      text        not null,
  size_bytes     bigint      not null check (size_bytes > 0 and size_bytes <= 104857600),   -- 100 MB
  uploaded_by_kind        text not null check (uploaded_by_kind in ('client','admin')),
  uploaded_by_client_id   uuid references public.clients (id),
  uploaded_by_admin_email text,
  visible_to_client boolean not null,        -- client upload: true (immutable); admin upload: default false, toggle
  confirmed_at   timestamptz,                -- set when the object is verified in the bucket; unconfirmed rows are invisible
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     text,
  constraint documents_file_type_allowed check (file_type in (
    'application/pdf',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  constraint documents_uploader_one_of check (
    (uploaded_by_kind = 'client' and uploaded_by_client_id is not null and uploaded_by_admin_email is null) or
    (uploaded_by_kind = 'admin'  and uploaded_by_admin_email is not null and uploaded_by_client_id is null)),
  constraint documents_client_upload_visible check (uploaded_by_kind <> 'client' or visible_to_client),
  constraint documents_tombstone_paired check ((deleted_at is null) = (deleted_by is null))
);
create index if not exists documents_profile_idx on public.documents (profile_id, created_at desc);

create table if not exists public.document_views (
  id            uuid        primary key default gen_random_uuid(),
  document_id   uuid        not null references public.documents (id),
  va_key        text        not null,                 -- from the verified token, never the body
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  close_secret  text        not null,                 -- random; authorises the close beacon for THIS view only
  constraint document_views_close_after_open check (closed_at is null or closed_at >= opened_at)
);
create index if not exists document_views_doc_idx on public.document_views (document_id, opened_at desc);

alter table public.documents      enable row level security;
alter table public.documents      force  row level security;
alter table public.document_views enable row level security;
alter table public.document_views force  row level security;
revoke all on public.documents      from anon, authenticated;
revoke all on public.document_views from anon, authenticated;
grant select, insert, update on public.documents      to service_role;   -- update = share toggle / confirm / tombstone
grant select, insert, update on public.document_views to service_role;   -- update = closed_at only

-- Private bucket. No object-level policies: only the service role touches it,
-- and it hands out signed URLs. 100 MB file cap mirrored on the bucket.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('va-documents', 'va-documents', false, 104857600)
    on conflict (id) do nothing;
  end if;
end
$$;

commit;

notify pgrst, 'reload schema';

-- ROLLBACK NOTES (manual, inside a transaction):
--   drop table if exists public.document_views;
--   drop table if exists public.documents;
--   -- the bucket 'va-documents' and its objects are NOT dropped automatically.
--   notify pgrst, 'reload schema';
