-- AI-GUARD1: backend runaway protection (owner request of 7 November 2026). An emergency stop, not a quota: if one account's
-- trailing 60-minute AI spend, across every purpose, passes a generous threshold, the account is paused until the owner resumes it.
-- Classification:
--   additive: five nullable columns on private.ai_controls (ai_guard_hour_micro, ai_guard_paused_at, ai_guard_limit_micro,
--     ai_guard_window_micro, ai_guard_resumed_at) and one pair check, one trigger function and trigger on private.ai_usage, three public functions;
--   NON-ADDITIVE: none. No admission, settlement, expiry, consent or deletion body is replaced, so none of their exact-body
--     proofs change. Nothing is scheduled here: the sweep job is created inactive by the next migration, as for the expiry jobs.
-- Enforcement: every admission of every purpose (analysis, stylist, photo clean-up, try-on steps, outfit suggestions) inserts one
-- 'reserved' or 'held' row into private.ai_usage in the same transaction as its checks. A BEFORE INSERT trigger on exactly those
-- rows refuses while the owner's controls row is paused, with the dedicated SQLSTATE AG001. The claim rolls back, so no usage row
-- exists and no provider call can follow. Settlement UPDATEs, expiry jobs, consent withdrawal and account deletion never insert
-- such rows and are untouched. The Edge functions and clients map AG001 to a terminal PAUSED outcome (src/domain/ai-guard.ts).
-- Latch: a trigger cannot latch (its transaction rolls back), so public.ai_guard_sweep, run once a minute by the job of the next
-- migration, sets the pause. It is best effort and skips a controls row a claim holds. The measure is the sum of accounted_micro
-- of the rows created in the last 60 minutes (and after the last Resume): settled rows at their recorded cost, held rows at their
-- reservation (conservative), analysis holds at 1 micro (so in-flight analysis is understated until it settles).
-- Threshold: ai_guard_hour_micro when the owner set it, otherwise half of the monthly allowance. Honest bound: this stops a runaway
-- at about half a month of spending, not at a few dollars; the Azure budget alert is the independent net.
-- Rollout (see docs/cloud-development.md): apply, deploy the five Edge functions, then Pages, verify, then activate the job.
begin;

alter table private.ai_controls
  add column ai_guard_hour_micro bigint check (ai_guard_hour_micro > 0),
  add column ai_guard_paused_at timestamptz,
  add column ai_guard_limit_micro bigint check (ai_guard_limit_micro > 0),
  add column ai_guard_window_micro bigint check (ai_guard_window_micro >= 0),
  add column ai_guard_resumed_at timestamptz,
  add constraint ai_controls_guard_pause check ((ai_guard_paused_at is null) = (ai_guard_limit_micro is null)
    and (ai_guard_paused_at is null) = (ai_guard_window_micro is null));

create function private.ai_guard_enforce() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists(select 1 from private.ai_controls where owner_id=new.owner_id and ai_guard_paused_at is not null) then
    raise exception using errcode='AG001',message='AI spending guard is paused';
  end if;
  return new;
end;
$$;
create trigger ai_usage_pause_guard before insert on private.ai_usage
  for each row when (new.charge_state in ('reserved','held')) execute function private.ai_guard_enforce();

-- The latch. Owner-run by the scheduler (like outfitgen_expire_due); returns the number of accounts it paused.
create function public.ai_guard_sweep(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); r record; c private.ai_controls; v_paused integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then return jsonb_build_object('code','INVALID_INPUT'); end if;
  for r in
    select k.owner_id,sum(u.accounted_micro) as spent,coalesce(k.ai_guard_hour_micro,k.monthly_allowance_micro/2) as cap
    from private.ai_controls k join private.ai_usage u on u.owner_id=k.owner_id
    where k.ai_guard_paused_at is null
      and u.created_at>=greatest(v_now-interval '60 minutes',coalesce(k.ai_guard_resumed_at,'-infinity'::timestamptz))
    group by k.owner_id,k.ai_guard_hour_micro,k.monthly_allowance_micro
    having sum(u.accounted_micro)>coalesce(k.ai_guard_hour_micro,k.monthly_allowance_micro/2)
    order by sum(u.accounted_micro) desc limit p_limit
  loop
    select * into c from private.ai_controls where owner_id=r.owner_id for update skip locked;
    if not found or c.ai_guard_paused_at is not null then continue; end if;
    update private.ai_controls set ai_guard_paused_at=v_now,ai_guard_limit_micro=r.cap,
      ai_guard_window_micro=least(r.spent,9223372036854775807::numeric)::bigint where owner_id=r.owner_id;
    v_paused := v_paused+1;
  end loop;
  return jsonb_build_object('code','OK','paused',v_paused);
end;
$$;

-- Owner reads and Resume. Approved owner only; no activation or consent is needed, so the notice shows while features are off.
create function public.ai_guard_status_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c private.ai_controls;
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=auth.uid();
  if not found or c.ai_guard_paused_at is null then return jsonb_build_object('code','OK','paused',false); end if;
  return jsonb_build_object('code','OK','paused',true,'pausedAtMs',floor(extract(epoch from c.ai_guard_paused_at)*1000)::bigint,
    'spentMicro',c.ai_guard_window_micro::text,'limitMicro',c.ai_guard_limit_micro::text);
end;
$$;

-- Resume clears the pause. The window restarts at the resume, so the spending that caused the pause is not counted again.
create function public.ai_guard_resume_v1() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare c private.ai_controls;
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=auth.uid() for update;
  if not found or c.ai_guard_paused_at is null then return jsonb_build_object('code','OK','replayed',true); end if;
  update private.ai_controls set ai_guard_paused_at=null,ai_guard_limit_micro=null,ai_guard_window_micro=null,
    ai_guard_resumed_at=clock_timestamp() where owner_id=c.owner_id;
  return jsonb_build_object('code','OK','replayed',false);
exception when lock_not_available then
  return jsonb_build_object('code','BUSY');
end;
$$;

revoke all on function private.ai_guard_enforce(),public.ai_guard_sweep(integer),public.ai_guard_status_v1(),public.ai_guard_resume_v1()
  from public,anon,authenticated,service_role;
grant execute on function public.ai_guard_status_v1(),public.ai_guard_resume_v1() to authenticated;

commit;
