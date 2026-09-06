-- =============================================================================
-- 0006_style_samples.sql — the pinned thumbnails on the student's style cards.
--
-- PRD §F4: generated once from the teacher screen and then fixed, rather than
-- regenerated per class. That matters more than it looks: each sample is a REAL
-- image out of a 5-images-per-minute budget, so generating them during a lesson
-- costs the class ~40 seconds and muddles the queue. Generate them the day
-- before.
-- =============================================================================

create table if not exists style_samples (
  style      text primary key check (style in ('anime','photo','watercolor')),
  url        text not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

alter table style_samples enable row level security;
