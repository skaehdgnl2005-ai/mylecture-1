-- =============================================================================
-- 0002_claim_job.sql — the atomic global rate gate + job claim.
--
-- This is the most important function in the system. It is what makes
-- "never exceed N images per minute" TRUE rather than APPROXIMATELY TRUE,
-- no matter how many serverless invocations call it concurrently.
--
-- Why not a concurrency semaphore (the PRD's §6-2.2 "동시 실행 수 3")?
--   Throughput = N / T, and T (gpt-image-2 latency) swings 20-40s. At N=3 and
--   T=25s that is 7.2 images/min against a 5/min ceiling. Concurrency cannot
--   control a rate when service time is variable. A minimum SPACING between
--   request starts can, and does.
--
-- Why an advisory lock on top of FOR UPDATE SKIP LOCKED?
--   PostgreSQL's docs warn that SKIP LOCKED "provides an inconsistent view of
--   the data". Under READ COMMITTED two claimers can each read running=0 from
--   their own snapshot and each take a slot. pg_advisory_xact_lock serialises
--   the whole claim and auto-releases at COMMIT. At ~5 acquisitions/minute the
--   cost is nil.
-- =============================================================================

create or replace function used_quota(p_session text, p_device uuid)
returns int
language sql
stable
as $$
  -- Derived, never stored. `failed` is excluded by construction, so PRD §5-3's
  -- "실패는 횟수를 차감하지 않는다" holds with no decrement path to get wrong.
  -- An expired lease (crashed worker) also stops counting after 3 minutes,
  -- returning the student's attempt without any reaper having run.
  select count(*)::int
    from jobs j
   where j.session_code = p_session
     and j.device_id = p_device
     and (j.status in ('queued','done')
          or (j.status = 'running' and j.lease_expires_at > now()))
     and j.created_at > coalesce(
           (select d.reset_at from devices d
             where d.session_code = p_session and d.id = p_device),
           '-infinity'::timestamptz);
$$;

create or replace function claim_job(
  p_spacing_ms    int,
  p_max_in_flight int,
  p_order         text default 'fifo'
)
returns jobs
language plpgsql
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_slot timestamptz;
  v_run  int;
  v_job  jobs;
begin
  -- Serialise every claimer. See header.
  perform pg_advisory_xact_lock(hashtext('img-claim'));

  -- Secondary bound. The spacing gate is the real control; this only stops an
  -- unbounded pile-up if generations start running very long.
  select count(*) into v_run
    from jobs
   where status = 'running' and lease_expires_at > v_now;
  if v_run >= p_max_in_flight then
    return null;
  end if;

  select next_slot_at into v_slot from pacer where id limit 1 for update;
  if v_slot > v_now then
    return null;                                   -- not our slot yet
  end if;

  select * into v_job
    from jobs
   where status = 'queued'
     and next_attempt_at <= v_now
     and deadline_at > v_now
   order by
     case when p_order = 'attempt_priority' then attempt_no else 0 end,
     created_at
   for update skip locked
   limit 1;

  if not found then
    return null;                                   -- no work: do NOT burn a slot
  end if;

  update pacer
     set next_slot_at = greatest(v_now, v_slot)
                      + make_interval(secs => p_spacing_ms / 1000.0);

  update jobs
     set status = 'running',
         tries = tries + 1,
         lease_expires_at = v_now + interval '3 minutes'
   where id = v_job.id
   returning * into v_job;

  insert into job_events (job_id, session_code, kind, detail)
  values (v_job.id, v_job.session_code, 'claimed',
          jsonb_build_object('try', v_job.tries, 'in_flight', v_run + 1));

  return v_job;
end;
$$;

-- How long until the next slot opens, in ms. Lets an idle worker sleep exactly
-- the right amount instead of busy-polling.
create or replace function ms_until_slot()
returns int
language sql
stable
as $$
  select greatest(0, ceil(extract(epoch from (next_slot_at - clock_timestamp())) * 1000))::int
    from pacer where id limit 1;
$$;

-- Queue position for the "앞에 N명" wait screen, using the same ORDER BY the
-- claimer uses so the number the student sees is the number that is true.
create or replace function queue_position(p_job uuid, p_order text default 'fifo')
returns int
language sql
stable
as $$
  with me as (select attempt_no, created_at, status from jobs where id = p_job)
  select case
    when (select status from me) <> 'queued' then 0
    else (
      select count(*)::int + 1
        from jobs j, me
       where j.status = 'queued'
         and (
           (p_order = 'attempt_priority'
              and (j.attempt_no, j.created_at) < (me.attempt_no, me.created_at))
           or (p_order <> 'attempt_priority' and j.created_at < me.created_at)
         )
    )
  end;
$$;

-- Requeue jobs whose worker died. Correctness does not depend on this running
-- (used_quota already ignores expired leases) — it is tidiness plus retry.
create or replace function reap_expired_leases()
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  with reaped as (
    update jobs
       set status = case when tries >= 3 then 'failed' else 'queued' end,
           error_code = case when tries >= 3 then 'lease_expired' else error_code end,
           error_message = case when tries >= 3 then 'worker died' else error_message end,
           lease_expires_at = null,
           next_attempt_at = now(),
           finished_at = case when tries >= 3 then now() else null end
     where status = 'running' and lease_expires_at < now()
    returning id, session_code, tries
  )
  insert into job_events (job_id, session_code, kind, detail)
  select id, session_code, 'lease_expired', jsonb_build_object('try', tries) from reaped;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
