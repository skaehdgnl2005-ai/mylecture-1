-- =============================================================================
-- 0001_schema.sql — sessions / devices / jobs / images / pacer / job_events
-- PRD §6-3. Deviations from the PRD sketch are marked DEVIATION and explained.
-- =============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────── sessions ────
create table if not exists sessions (
  code              text primary key check (code ~ '^[A-Z0-9]{4}$'),
  status            text not null default 'open'
                    check (status in ('open','draining','closed')),
  per_device_limit  int  not null default 2  check (per_device_limit between 1 and 10),
  total_limit       int  not null default 50 check (total_limit between 1 and 500),
  per_minute_limit  int  not null default 5  check (per_minute_limit between 1 and 250),
  allowed_styles    text[] not null default '{anime,photo,watercolor}',
  image_quality     text not null default 'medium'
                    check (image_quality in ('low','medium','high')),
  queue_order       text not null default 'fifo'
                    check (queue_order in ('fifo','attempt_priority')),
  created_at        timestamptz not null default now(),
  closed_at         timestamptz
);

-- PRD §F4: at most one active session at a time.
create unique index if not exists sessions_single_open
  on sessions ((true)) where status = 'open';

-- ──────────────────────────────────────────────────────────────── devices ────
-- DEVIATION from PRD §6-3: no `generation_count` column. A stored counter has
-- an increment/decrement pair, and that pair drifts on exactly the afternoon
-- that matters. Quota is a derived COUNT over jobs (see used_quota()).
create table if not exists devices (
  id           uuid not null,
  session_code text not null references sessions(code) on delete cascade,
  label        text not null,             -- anonymous teacher-facing label, e.g. '파란 여우'
  reset_at     timestamptz,               -- teacher "이 기기 횟수 초기화"
  created_at   timestamptz not null default now(),
  primary key (session_code, id)
);

-- ─────────────────────────────────────────────────────────────────── jobs ────
create table if not exists jobs (
  id                uuid primary key default gen_random_uuid(),
  session_code      text not null,
  device_id         uuid not null,
  idempotency_key   text not null,       -- minted once at step 5; double-tap guard
  attempt_no        int  not null check (attempt_no >= 1),
  inputs            jsonb not null,      -- chip selections ONLY. never free text.
  raw_text_ko       text,                -- the only place Korean lives. NULLed on done.
  action_en         text,
  visible_detail_en text,
  prompt            text,
  status            text not null default 'queued'
                    check (status in ('queued','running','done','failed')),
  tries             int  not null default 0,
  next_attempt_at   timestamptz not null default now(),
  lease_expires_at  timestamptz,
  deadline_at       timestamptz not null default now() + interval '15 minutes',
  error_code        text,
  error_message     text,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz,
  foreign key (session_code, device_id)
    references devices(session_code, id) on delete cascade
);

create unique index if not exists jobs_idem
  on jobs (session_code, device_id, idempotency_key);
create index if not exists jobs_claim
  on jobs (next_attempt_at, attempt_no, created_at) where status = 'queued';
create index if not exists jobs_device on jobs (session_code, device_id);
create index if not exists jobs_session_status on jobs (session_code, status);

-- Mechanically enforces "the translator ran and its output was used".
-- Catches the PRD §5-1 raw-Korean fallback if anyone ever reintroduces it.
alter table jobs drop constraint if exists prompt_no_hangul;
alter table jobs add constraint prompt_no_hangul
  check (prompt is null or prompt !~ '[가-힣ㄱ-ㅎㅏ-ㅣ]');

-- The application NEVER selects from `jobs` directly — only from this view.
-- raw_text_ko cannot leak through a stray SELECT *.
create or replace view jobs_public as
  select id, session_code, device_id, attempt_no, inputs, status, tries,
         error_code, error_message, created_at, finished_at, action_en
  from jobs;

-- ───────────────────────────────────────────────────────────────── images ────
create table if not exists images (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null unique references jobs(id) on delete cascade,
  session_code text not null,
  device_id    uuid not null,
  storage_path text not null,
  url          text not null,
  tags         text[] not null,          -- built from chip IDs only, never from inputs
  is_hidden    boolean not null default false,
  in_gallery   boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists images_gallery on images (session_code, created_at desc)
  where is_hidden = false and in_gallery = true;
create index if not exists images_device on images (session_code, device_id);

-- ────────────────────────────────────────────────────────────────── pacer ────
-- The global rate gate. Exactly one row, forever.
create table if not exists pacer (
  id           boolean primary key default true check (id),
  next_slot_at timestamptz not null default now()
);
insert into pacer (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────── job_events ────
-- Our own log. Vercel keeps runtime logs for 1 hour on Hobby and Supabase for
-- 1 day; neither survives to the next morning when a teacher asks what happened.
create table if not exists job_events (
  id           bigserial primary key,
  job_id       uuid,
  session_code text,
  kind         text not null,
  detail       jsonb,
  at           timestamptz not null default now()
);
create index if not exists job_events_job on job_events (job_id, at desc);
create index if not exists job_events_session on job_events (session_code, at desc);

-- ──────────────────────────────────────────────────────────────────── RLS ────
-- The browser holds no Supabase key at all; every read and write goes through a
-- Route Handler with the secret key (which bypasses RLS). Enable RLS with ZERO
-- policies, and revoke grants independently. Belt and braces.
alter table sessions   enable row level security;
alter table devices    enable row level security;
alter table jobs       enable row level security;
alter table images     enable row level security;
alter table pacer      enable row level security;
alter table job_events enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
