-- =============================================================================
-- 0005_cron_health.sql — lets the teacher console see whether the pump is alive.
--
-- Two things make this necessary rather than nice-to-have:
--   1. pg_net is FIRE AND FORGET. cron.job_run_details will show SUCCESS even
--      when the Edge/Vercel call failed or the app was down, so a green cron run
--      is NOT evidence the worker ran.
--   2. net._http_response is kept for 6 hours and the TTL cannot be changed on
--      the Free plan without superuser, so anything worth keeping must be read
--      while it is still there.
--
-- Written defensively: on a plain Postgres (CI / local docker) neither cron nor
-- net exists, and this must degrade to "not scheduled" rather than error.
-- =============================================================================

create or replace function cron_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scheduled boolean := false;
  v_last      text    := null;
begin
  begin
    execute $q$ select exists (select 1 from cron.job where jobname = 'pump-worker') $q$
      into v_scheduled;
  exception when others then
    v_scheduled := false;
  end;

  begin
    execute $q$
      select coalesce(status_code::text, error_msg)
        from net._http_response
       order by created desc
       limit 1
    $q$ into v_last;
  exception when others then
    v_last := null;
  end;

  return jsonb_build_object('scheduled', v_scheduled, 'last_response', v_last);
end;
$$;
