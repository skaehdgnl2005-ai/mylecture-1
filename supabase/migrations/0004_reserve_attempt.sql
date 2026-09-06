-- =============================================================================
-- 0004_reserve_attempt.sql — the cap check and the insert, in ONE transaction.
--
-- LOCK ORDER IS ALWAYS sessions -> devices. It is fixed here and taken nowhere
-- else in the codebase. Reversing it in any other code path deadlocks twenty
-- simultaneous taps at the cap — precisely the load this exists for.
--
-- Returns a row rather than raising, so the caller can map each refusal to its
-- own Korean message without parsing error strings.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reserve_result') then
    create type reserve_result as (
      ok         boolean,
      reason     text,
      attempt_no int,
      job_id     uuid
    );
  end if;
end $$;

-- Anonymous, stable, human-readable label for the teacher screen. Derived from
-- the device UUID so it never needs storing twice, and carries no identity.
create or replace function anonymous_label(p_device uuid)
returns text
language plpgsql
immutable
as $$
declare
  adjectives text[] := array['파란','빨간','노란','초록','보라','주황','하얀','검은','분홍','하늘','연두','자주'];
  animals    text[] := array['여우','토끼','고래','사슴','올빼미','수달','펭귄','다람쥐','두루미','너구리','고양이','호랑이','거북이','제비','늑대'];
  h bigint := abs(hashtext(p_device::text));
begin
  return adjectives[(h % array_length(adjectives,1)) + 1]
      || ' ' ||
         animals[((h / 13) % array_length(animals,1)) + 1];
end;
$$;

create or replace function reserve_attempt(
  p_session    text,
  p_device     uuid,
  p_idem       text,
  p_inputs     jsonb,
  p_raw_text   text,
  p_action_en  text,
  p_detail_en  text
)
returns reserve_result
language plpgsql
as $$
declare
  v_session sessions%rowtype;
  v_used    int;
  v_total   int;
  v_job     uuid;
  v_existing uuid;
  v_out     reserve_result;
begin
  -- 1. sessions FIRST.
  select * into v_session from sessions where code = p_session for update;
  if not found or v_session.status <> 'open' then
    return (false, 'closed', null, null)::reserve_result;
  end if;

  -- 2. devices SECOND. Auto-enrol on first submission.
  perform 1 from devices where session_code = p_session and id = p_device for update;
  if not found then
    insert into devices (id, session_code, label)
    values (p_device, p_session, anonymous_label(p_device))
    on conflict (session_code, id) do nothing;
    perform 1 from devices where session_code = p_session and id = p_device for update;
  end if;

  -- Idempotency: one tap is one job, however many times the request arrives.
  select id into v_existing from jobs
   where session_code = p_session and device_id = p_device and idempotency_key = p_idem;
  if v_existing is not null then
    return (false, 'duplicate', null, v_existing)::reserve_result;
  end if;

  v_used := used_quota(p_session, p_device);
  if v_used >= v_session.per_device_limit then
    return (false, 'quota', null, null)::reserve_result;
  end if;

  select count(*) into v_total from jobs
   where session_code = p_session and status in ('queued','running','done');
  if v_total >= v_session.total_limit then
    return (false, 'session_cap', null, null)::reserve_result;
  end if;

  insert into jobs (session_code, device_id, idempotency_key, attempt_no,
                    inputs, raw_text_ko, action_en, visible_detail_en)
  values (p_session, p_device, p_idem, v_used + 1,
          p_inputs, p_raw_text, p_action_en, p_detail_en)
  returning id into v_job;

  insert into job_events (job_id, session_code, kind, detail)
  values (v_job, p_session, 'queued', jsonb_build_object('attempt', v_used + 1));

  return (true, null, v_used + 1, v_job)::reserve_result;
end;
$$;
