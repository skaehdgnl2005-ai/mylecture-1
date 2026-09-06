-- =============================================================================
-- 0007_expire_queued.sql — nothing may stay 'queued' forever.
--
-- THE HOLE THIS CLOSES
--   jobs.deadline_at defaults to now() + 15 minutes (0001_schema.sql), and
--   claim_job() only considers rows with `deadline_at > now()` (0002). Nothing
--   anywhere moved an expired queued row to 'failed':
--     - reap_expired_leases() only looked at status = 'running';
--     - pump_worker()'s "is there work?" test used the same deadline_at > now()
--       filter, so pg_cron would not even wake for such a row;
--     - the queue screen's 다시 그리기 button only renders for status = 'failed'.
--   So the row sat there, invisible to every recovery path. The student's phone
--   polled '그림을 그리고 있어요' forever, and because used_quota() counts
--   'queued', that student's attempt was consumed permanently — the one thing
--   PRD §5-3 promises cannot happen.
--
--   It is not a hypothetical: it is exactly what RUNBOOK's "모두 '대기'에서
--   멈춤" row turns into once the pump has been down for fifteen minutes.
--
-- THE FIX
--   Expired queued rows become 'failed' with a distinct error code, which
--   (a) returns the attempt, since used_quota() excludes 'failed',
--   (b) gives the student a real message instead of an endless spinner, and
--   (c) makes the row visible to the teacher's 다시 그리기 button.
--   The sweep lives inside reap_expired_leases() because that already runs at
--   the top of every tick, before the "is there an open session?" early return.
-- =============================================================================

create or replace function reap_expired_leases()
returns int
language plpgsql
as $$
declare
  v_count int;
  v_expired int;
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

  -- The new half: a job that has run out of time while still waiting. There is
  -- no retry to give it — its deadline has passed, so claim_job() would refuse
  -- it again the moment it went back to 'queued'.
  with expired as (
    update jobs
       set status = 'failed',
           error_code = 'deadline_exceeded',
           error_message = 'queued past deadline_at',
           lease_expires_at = null,
           finished_at = now()
     where status = 'queued' and deadline_at <= now()
    returning id, session_code, tries
  )
  insert into job_events (job_id, session_code, kind, detail)
  select id, session_code, 'deadline_exceeded', jsonb_build_object('try', tries) from expired;
  get diagnostics v_expired = row_count;

  return v_count + v_expired;
end;
$$;

-- pump_worker() has to wake for the expired rows too, or the sweep above only
-- runs when some OTHER piece of work happens to bring the worker up — which is
-- precisely the situation that is not happening when this bug bites.
create or replace function pump_worker()
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_url    text;
  v_secret text;
  v_due    boolean;
begin
  -- A lesson the teacher closed, whose queue has since emptied, is finished.
  --
  -- This is done HERE, in SQL, and not only at the end of a worker tick, because
  -- a tick holds a 300-second lease (worker_lock) and an invocation killed at
  -- the platform ceiling keeps that lease until it expires — so every tick in
  -- the next five minutes is skipped, and anything gated behind one waits with
  -- it. pg_cron runs this every 10 seconds and needs no lease, no HTTP call and
  -- no Vercel invocation.
  update sessions s
     set status = 'closed', closed_at = now()
   where s.status = 'draining'
     and not exists (
       select 1 from jobs j
        where j.session_code = s.code and j.status in ('queued','running'));

  -- Only wake the worker when there is actually something to do. This is what
  -- keeps the 10-second cron free: no queued work => no HTTP call, no Vercel
  -- invocation, no Provisioned-Memory burn.
  select exists (
    select 1 from jobs
     where status = 'queued' and next_attempt_at <= now() and deadline_at > now()
  ) or exists (
    select 1 from jobs
     where status = 'running' and lease_expires_at < now()
  ) or exists (
    -- Expired while waiting: there is nothing left to draw, but the row still
    -- has to be moved to 'failed' so the student gets their attempt back.
    select 1 from jobs
     where status = 'queued' and deadline_at <= now()
  ) into v_due;

  if not v_due then
    return;
  end if;

  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'app_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'worker_secret';
  if v_url is null or v_secret is null then
    return;
  end if;

  -- Fire and forget. pg_net's default timeout is 2000ms — the worker returns
  -- immediately and keeps working, so a short timeout here is correct.
  perform net.http_post(
    url     := v_url || '/api/worker/tick',
    body    := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-worker-secret', v_secret),
    timeout_milliseconds := 8000
  );
end;
$$;

-- The cron schedule itself is NOT touched. pg_cron accepts '10 seconds' only
-- for sub-minute intervals; re-registering it here would risk nothing but gains
-- nothing either, and 0003 already owns it.
