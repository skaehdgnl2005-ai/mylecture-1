-- =============================================================================
-- 0008_job_image_quality.sql — cost stops being retroactive.
--
-- THE BUG THIS CLOSES
--   The teacher console printed 예상 비용 as
--     estimateCostUsd(done_count, sessions.image_quality)
--   — every finished picture priced at the session's CURRENT quality. Quality is
--   a mid-lesson setting (RUNBOOK '수업 중에 바꿀 수 있는 설정'), so flipping
--   low -> high at minute 8 re-priced the pictures drawn in minutes 0-7 as well:
--     20 pictures already drawn at low   = $0.10  (true)
--     teacher taps 높음                  = $3.30  (a 33x jump for pictures that
--                                                  had already been paid for)
--   The teacher's own dashboard then argued that a change they made going
--   forward had cost them money backwards. The figure they act on — "can I
--   afford to finish this lesson" — was wrong in the exact moment they were
--   asking it. It was flagged as KNOWN IMPRECISION in lib/openai/image.ts.
--
-- THE FIX
--   Record the quality on the job row at the instant the picture is actually
--   drawn, and sum per row instead of multiplying a count.
--
-- WHY NULLABLE, AND WHY NO DEFAULT
--   A queued row has not chosen a quality yet: the worker re-reads the session
--   on every claim (worker.ts, "Reload the session each claim"), precisely so a
--   mid-lesson change applies to what is drawn next. A DEFAULT here would be a
--   second, staler answer to the same question. NULL means "not drawn yet", and
--   only 'done' rows are ever summed.
--
-- WHY THE BACKFILL USES THE SESSION'S CURRENT VALUE
--   For rows that finished before this migration the true quality is not
--   recoverable — it was never written down. The session's current value is what
--   the console was already using for them, so the backfill changes no displayed
--   number on the day it runs. It freezes the old approximation instead of
--   letting it keep drifting, which is the whole point.
--
-- WHY THE PRICES ARE NOT IN THIS FILE
--   src/lib/pricing.ts is the single source of per-picture cost, and it is
--   imported by the teacher's 화질 buttons as well as by the console. A price
--   constant in SQL would be a second copy that no test compares against the
--   first, and the disagreement would surface as the button and the invoice
--   quoting different numbers. So this function returns COUNTS, and TypeScript
--   multiplies.
-- =============================================================================

alter table jobs
  add column if not exists image_quality text
    check (image_quality in ('low','medium','high'));

comment on column jobs.image_quality is
  'Quality this picture was actually drawn at, written on completion. NULL until drawn. Cost is summed per row so a mid-lesson quality change cannot re-price pictures that are already finished.';

-- Freeze what the console was already claiming for rows that finished before
-- this column existed. Only 'done' rows: nothing else has a cost.
update jobs j
   set image_quality = s.image_quality
  from sessions s
 where j.session_code = s.code
   and j.status = 'done'
   and j.image_quality is null;

-- Counts grouped by the quality each picture was drawn at. One round trip
-- instead of one count query per quality, and no prices in the database.
--
-- Rows whose quality is unknown (finished in the window between this migration
-- and the deploy that starts writing the column) come back under the key
-- 'unknown'; the caller prices those at the session's current quality, which is
-- the old behaviour, applied only where there is genuinely nothing better.
create or replace function session_quality_counts(p_session_code text)
returns table (quality text, n bigint)
language sql
stable
as $$
  select coalesce(image_quality, 'unknown') as quality, count(*) as n
    from jobs
   where session_code = p_session_code
     and status = 'done'
   group by 1;
$$;
