-- =============================================================================
-- 0003_cron.sql — the heartbeat.
--
-- Vercel Hobby cron is once-per-day maximum (a sub-daily expression FAILS THE
-- DEPLOYMENT, it does not silently skip), so the queue cannot be pumped from
-- Vercel. Supabase's pg_cron supports sub-minute schedules, so the clock lives
-- here and pokes the Vercel worker route over pg_net.
--
-- Student and teacher status polls are secondary pumps that call the same
-- route. Every path funnels through claim_job(), so duplicate ticks are safe.
--
-- Requires: pg_cron and pg_net extensions, Postgres >= 15.1.1.61 for the
-- '10 seconds' schedule syntax. Verify in the dashboard before relying on it.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Secrets go in Vault, never inline: cron.job is readable by anyone with DB
-- access and ends up in migrations, dashboards and screenshots.
-- Run these ONCE by hand (or via scripts/setup-cron.ts) with real values:
--
--   select vault.create_secret('https://your-app.vercel.app', 'app_url');
--   select vault.create_secret('<WORKER_SECRET>', 'worker_secret');

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
  -- Only wake the worker when there is actually something to do. This is what
  -- keeps the 10-second cron free: no queued work => no HTTP call, no Vercel
  -- invocation, no Provisioned-Memory burn.
  select exists (
    select 1 from jobs
     where status = 'queued' and next_attempt_at <= now() and deadline_at > now()
  ) or exists (
    select 1 from jobs
     where status = 'running' and lease_expires_at < now()
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

-- 10 seconds is the sweet spot: ~259k Edge/HTTP calls per month against a
-- 500k free quota, and a student's wait is dominated by OpenAI, not polling.
-- Do not go below ~5 seconds.
select cron.unschedule('pump-worker') where exists (select 1 from cron.job where jobname = 'pump-worker');
select cron.schedule('pump-worker', '10 seconds', $cron$ select pump_worker(); $cron$);

-- cron.job_run_details grows at 6 rows/minute (~260k rows/month) and will
-- quietly eat the 500MB free database allowance.
select cron.unschedule('purge-cron-history') where exists (select 1 from cron.job where jobname = 'purge-cron-history');
select cron.schedule('purge-cron-history', '0 3 * * *', $cron$
  delete from cron.job_run_details where end_time < now() - interval '2 days';
$cron$);

-- Reap dead workers even if no HTTP pump is running.
select cron.unschedule('reap-leases') where exists (select 1 from cron.job where jobname = 'reap-leases');
select cron.schedule('reap-leases', '1 minute', $cron$ select reap_expired_leases(); $cron$);
