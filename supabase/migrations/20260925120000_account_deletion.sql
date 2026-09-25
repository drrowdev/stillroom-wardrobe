-- P6c I22: owner-confirmed account deletion. Service-only control, frozen-owner Storage removal,
-- admission generations and an Auth-transaction admission release. Not additive: replaces
-- deletion_control and the Storage publication guard. Hosted apply needs owner approval.
begin;

-- A new invitation (new link or changed email) always gets a new generation; deletion binds to it.
alter table private.approved_accounts add column generation uuid not null default gen_random_uuid();
create function private.rotate_admission_generation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.email is distinct from old.email
    or (old.user_id is null and new.user_id is not null) then
    new.generation := gen_random_uuid();
  end if;
  return new;
end;
$$;
create trigger stillroom_admission_generation before update on private.approved_accounts
for each row execute function private.rotate_admission_generation();

alter table private.deletion_jobs
  add column admission_no smallint check (admission_no in (1,2)),
  add column admission_generation uuid,
  add column lease_id uuid,
  add column lease_until timestamptz,
  add column grants smallint not null default 0 check (grants between 0 and 3);

create function private.deletion_receipt(j private.deletion_jobs) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('owner_id',j.owner_id,'stage',j.stage,'attempts',j.attempts,'grants',j.grants,
    'last_code',j.last_code,'requested_at',j.requested_at,'completed_at',j.completed_at,
    'busy',coalesce(j.lease_until>now(),false));
$$;

-- Every owner-keyed table. A unit test compares this list with the migrations.
create function private.deletion_owner_rows_absent(p_owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not (
    exists(select 1 from public.profiles where owner_id=p_owner)
    or exists(select 1 from public.style_preferences where owner_id=p_owner)
    or exists(select 1 from public.items where owner_id=p_owner)
    or exists(select 1 from public.item_images where owner_id=p_owner)
    or exists(select 1 from public.outfits where owner_id=p_owner)
    or exists(select 1 from public.outfit_items where owner_id=p_owner)
    or exists(select 1 from public.wear_events where owner_id=p_owner)
    or exists(select 1 from public.wear_event_items where owner_id=p_owner)
    or exists(select 1 from public.combination_rules where owner_id=p_owner)
    or exists(select 1 from public.suggestion_feedback where owner_id=p_owner)
    or exists(select 1 from private.ai_controls where owner_id=p_owner)
    or exists(select 1 from private.ai_usage where owner_id=p_owner)
    or exists(select 1 from private.ai_requests where owner_id=p_owner)
    or exists(select 1 from private.ai_usage_evidence where owner_id=p_owner)
    or exists(select 1 from private.ai_analysis_attestations where owner_id=p_owner)
    or exists(select 1 from private.item_save_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_save_used_receipts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_attempts where owner_id=p_owner)
    or exists(select 1 from private.ai_item_save_context where owner_id=p_owner)
    or exists(select 1 from private.item_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.item_image_used_ids where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_claims where owner_id=p_owner)
    or exists(select 1 from private.image_change_attempts where owner_id=p_owner)
    or exists(select 1 from private.image_change_context where owner_id=p_owner)
    or exists(select 1 from private.image_change_history where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_operations where owner_id=p_owner)
    or exists(select 1 from private.item_deletion_targets where owner_id=p_owner));
$$;

drop function public.deletion_control(uuid,text,text);
-- Server-only. The Edge Function derives p_owner_id from the verified user token; p_op is the
-- caller-generated operation token and lease ID. Lock order: admission row, then job.
create function public.deletion_control(p_owner_id uuid,p_action text,p_op uuid default null,p_code text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare j private.deletion_jobs; a private.approved_accounts; n smallint; bound boolean;
begin
  if p_owner_id is null or p_action is null or p_action not in
    ('begin','resume','renew','storage_removed','auth_removed','failed','release','grant','reconcile','status')
    or (p_action in ('begin','resume','renew','storage_removed','auth_removed','failed','release') and p_op is null) then
    raise exception using errcode='22023',message='Invalid action';
  end if;
  select admission_no into n from private.deletion_jobs where owner_id=p_owner_id;
  if n is null then select admission_no into n from private.approved_accounts where user_id=p_owner_id; end if;
  if n is not null then select * into a from private.approved_accounts where admission_no=n for no key update; end if;
  select * into j from private.deletion_jobs where owner_id=p_owner_id for update;
  if not found then
    if p_action<>'begin' or a.user_id is distinct from p_owner_id or a.enabled is distinct from true then
      raise exception using errcode='P0002',message='Not available';
    end if;
    insert into private.deletion_jobs(owner_id,stage,admission_no,admission_generation)
      values(p_owner_id,'freeze',a.admission_no,a.generation) returning * into j;
  end if;
  if p_action='status' then return private.deletion_receipt(j); end if;
  if j.stage='complete' then
    if p_action in ('begin','resume') then return private.deletion_receipt(j)||jsonb_build_object('acquired',false); end if;
    if p_action in ('auth_removed','reconcile','release') then return private.deletion_receipt(j); end if;
    raise exception using errcode='40001',message='Request conflict';
  end if;
  bound := j.admission_no is not null and a.admission_no is not distinct from j.admission_no
    and a.generation is not distinct from j.admission_generation and a.user_id is not distinct from p_owner_id;
  if p_action='reconcile' then
    if j.stage not in ('storage','auth') or exists(select 1 from auth.users where id=p_owner_id)
      or exists(select 1 from storage.objects where bucket_id='wardrobe' and split_part(name,'/',1)=p_owner_id::text)
      or not private.deletion_owner_rows_absent(p_owner_id) then
      raise exception using errcode='40001',message='Request conflict';
    end if;
    delete from private.approved_accounts
      where admission_no=j.admission_no and generation=j.admission_generation and user_id is null;
    update private.deletion_jobs set stage='complete',completed_at=now(),last_code=null,lease_id=null,lease_until=null
      where owner_id=p_owner_id returning * into j;
    return private.deletion_receipt(j);
  end if;
  if p_action='grant' then
    if j.attempts<10 or j.grants>=3 or coalesce(j.lease_until>now(),false) then
      raise exception using errcode='40001',message='Request conflict';
    end if;
    update private.deletion_jobs set attempts=0,grants=grants+1 where owner_id=p_owner_id returning * into j;
    return private.deletion_receipt(j);
  end if;
  if p_action in ('begin','resume') then
    if j.lease_id=p_op and j.lease_until>now() then
      return private.deletion_receipt(j)||jsonb_build_object('acquired',true);
    end if;
    if j.lease_until>now() then return private.deletion_receipt(j)||jsonb_build_object('acquired',false); end if;
    if j.attempts>=10 then raise exception using errcode='P0001',message='Retry limit'; end if;
    if j.stage<>'auth' then
      if not bound then raise exception using errcode='40001',message='Request conflict'; end if;
      update private.approved_accounts set enabled=false
        where admission_no=j.admission_no and generation=j.admission_generation and user_id=p_owner_id;
    end if;
    update private.deletion_jobs set stage=case when stage='auth' then 'auth' else 'storage' end,
      attempts=attempts+1,last_code=null,lease_id=p_op,lease_until=now()+interval '2 minutes'
      where owner_id=p_owner_id returning * into j;
    return private.deletion_receipt(j)||jsonb_build_object('acquired',true);
  end if;
  if j.lease_id is distinct from p_op or not coalesce(j.lease_until>now(),false) then
    raise exception using errcode='40001',message='Request conflict';
  end if;
  if p_action='renew' then
    update private.deletion_jobs set lease_until=now()+interval '2 minutes' where owner_id=p_owner_id returning * into j;
  elsif p_action='release' then
    update private.deletion_jobs set lease_id=null,lease_until=null where owner_id=p_owner_id returning * into j;
  elsif p_action='failed' then
    if p_code is null or p_code not in ('UPSTREAM_UNAVAILABLE','RETRY_REQUIRED') then
      raise exception using errcode='22023',message='Invalid action';
    end if;
    update private.deletion_jobs set last_code=p_code,lease_id=null,lease_until=null
      where owner_id=p_owner_id returning * into j;
  elsif p_action='storage_removed' then
    if j.stage<>'storage' or not bound or a.enabled then
      raise exception using errcode='40001',message='Request conflict';
    end if;
    if exists(select 1 from storage.objects where bucket_id='wardrobe' and split_part(name,'/',1)=p_owner_id::text) then
      raise exception using errcode='P0001',message='Remove files first';
    end if;
    -- No handler: any failure rolls the whole call back to `storage`.
    update private.deletion_jobs set stage='rows' where owner_id=p_owner_id;
    delete from private.item_deletion_claims where owner_id=p_owner_id;
    delete from public.items where owner_id=p_owner_id;
    delete from public.outfits where owner_id=p_owner_id;
    delete from public.wear_events where owner_id=p_owner_id;
    delete from public.profiles where owner_id=p_owner_id;
    delete from private.image_change_context where owner_id=p_owner_id;
    delete from private.image_change_attempts where owner_id=p_owner_id;
    delete from private.item_deletion_operations where owner_id=p_owner_id;
    delete from private.item_image_used_ids where owner_id=p_owner_id;
    delete from private.ai_item_save_context where owner_id=p_owner_id;
    if not private.deletion_owner_rows_absent(p_owner_id) then
      raise exception using errcode='40001',message='Request conflict';
    end if;
    update private.deletion_jobs set stage='auth',lease_until=now()+interval '2 minutes'
      where owner_id=p_owner_id returning * into j;
  else -- auth_removed
    if j.stage<>'auth' then raise exception using errcode='40001',message='Request conflict'; end if;
    if exists(select 1 from auth.users where id=p_owner_id) then
      raise exception using errcode='P0001',message='Remove identity first';
    end if;
    delete from private.approved_accounts
      where admission_no=j.admission_no and generation=j.admission_generation and user_id is null;
    update private.deletion_jobs set stage='complete',completed_at=now(),last_code=null,lease_id=null,lease_until=null
      where owner_id=p_owner_id returning * into j;
  end if;
  return private.deletion_receipt(j);
end;
$$;
revoke all on function public.deletion_control(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.deletion_control(uuid,text,uuid,text) to service_role;

-- Owner-only status for the deletion recovery screen. It reads only the caller's own job, so it still
-- answers after the freeze has removed data access. No parameters: the owner is auth.uid().
create function public.deletion_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('state',case
    when j.owner_id is null then 'none'
    when j.stage='complete' then 'complete'
    when coalesce(j.lease_until>now(),false) then 'in_progress'
    when j.attempts>=10 then 'contact'
    else 'retry' end)
  from (select auth.uid() as uid) u left join private.deletion_jobs j on j.owner_id=u.uid;
$$;
revoke all on function public.deletion_status() from public,anon;
grant execute on function public.deletion_status() to authenticated;

-- The unchanged 20260922020000 body follows the new first branch; a unit test pins that.
create or replace function private.guard_item_object_publication() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare image public.item_images; item public.items; u uuid; image_id uuid; parent_id uuid;
  object storage.objects; d private.item_deletion_operations; t private.item_deletion_targets;
  fa private.approved_accounts; fj private.deletion_jobs; fn smallint; fu uuid;
begin
  -- P6c: the service role may delete a frozen owner's objects only while that owner's job is at `storage`.
  if tg_op='DELETE' and old.bucket_id='wardrobe'
    and split_part(old.name,'/',1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and split_part(old.name,'/',2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')='service_role'
    and storage.allow_only_operation('storage.object.delete') then
    fu := split_part(old.name,'/',1)::uuid;
    select j0.admission_no into fn from private.deletion_jobs j0 where j0.owner_id=fu;
    if fn is not null then
      begin
        select * into fa from private.approved_accounts where admission_no=fn for share nowait;
        select * into fj from private.deletion_jobs where owner_id=fu for share nowait;
      exception when lock_not_available then
        raise exception using errcode='55P03',message='The resource is locked';
      end;
      if fa.admission_no is not null and fj.owner_id is not null and fj.admission_no=fa.admission_no
        and fj.admission_generation=fa.generation and fj.stage='storage' and fa.enabled=false and fa.user_id=fu then
        return old;
      end if;
    end if;
  end if;
  if tg_op='DELETE' then object := old; else object := new; end if;
  if tg_op='UPDATE' then
    if old.bucket_id<>'wardrobe' and new.bucket_id<>'wardrobe' then return new; end if;
    if row(new.id,new.bucket_id,new.name,new.owner,new.owner_id,new.archived_at,new.is_delete_marker,new.is_versioned)
      is distinct from row(old.id,old.bucket_id,old.name,old.owner,old.owner_id,old.archived_at,old.is_delete_marker,old.is_versioned) then
      raise exception using errcode='42501',message='Not available';
    end if;
    if new.version is distinct from old.version then raise exception using errcode='23505',message='The resource already exists'; end if;
  end if;
  if object.bucket_id<>'wardrobe' then return object; end if;
  if split_part(object.name,'/',1) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or split_part(object.name,'/',2) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode='42501',message='Not available';
  end if;
  u := split_part(object.name,'/',1)::uuid; parent_id := split_part(object.name,'/',2)::uuid;
  -- Native Storage needs 55P03; the shared RPC helper deliberately emits 22023.
  begin
    perform private.image_change_lock(u);
  exception when sqlstate '22023' then
    raise exception using errcode='55P03',message='The resource is locked';
  end;
  select * into d from private.item_deletion_operations where owner_id=u and item_id=parent_id and phase<>'cancelled';
  if found then
    if tg_op<>'DELETE' or d.phase not in ('authorized','removing_registered')
      or not storage.allow_only_operation('storage.object.delete') then raise exception using errcode='42501',message='Not available'; end if;
    select * into t from private.item_deletion_targets where owner_id=u and request_id=d.request_id and path=object.name
      and authorized and not reconciled_absent and ((d.phase='removing_registered')=(category='registered'));
    if not found or row(object.id,object.version,object.owner_id,object.owner)
      is distinct from row(t.object_id,t.object_version,t.object_owner,t.legacy_owner)
      or object.archived_at is not null or object.is_delete_marker is distinct from false or object.is_versioned is distinct from false then
      raise exception using errcode='42501',message='Not available';
    end if;
    return old;
  end if;
  if tg_op='DELETE' then return old; end if;
  select im.* into image from public.item_images im where object.name in(im.main_path,im.thumb_path);
  if not found or image.owner_id<>u or image.item_id<>parent_id or object.owner_id is distinct from u::text
    or (object.owner is not null and object.owner<>u) or object.archived_at is not null
    or object.is_delete_marker is distinct from false or object.is_versioned is distinct from false then
    raise exception using errcode='42501',message='Not available';
  end if;
  image_id := image.id;
  perform 1 from public.profiles where owner_id=u for share nowait;
  if not found then raise exception using errcode='42501',message='Not available'; end if;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id for share nowait;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id for share nowait;
  select im.* into image from public.item_images im where im.owner_id=u and im.id=image_id;
  select i.* into item from public.items i where i.owner_id=u and i.id=parent_id;
  if not exists(select 1 from private.approved_accounts where user_id=u and enabled)
    or not exists(select 1 from public.profiles where owner_id=u) or image.item_id is distinct from parent_id
    or item.id is null or private.image_change_fenced(u,parent_id)
    or exists(select 1 from private.item_deletion_claims where owner_id=u and item_id=parent_id)
    or (tg_op='INSERT' and (image.state<>'pending' or image.retired_at is not null or item.deleted_at is not null
      or exists(select 1 from private.ai_item_save_attempts where owner_id=u and item_id=parent_id and cancelled)
      or exists(select 1 from private.image_change_attempts a where a.owner_id=u and a.image_id=image.id and a.state='cancelled'))) then
    raise exception using errcode='42501',message='Not available';
  end if;
  return new;
exception when lock_not_available then raise exception using errcode='55P03',message='The resource is locked';
end;
$$;

-- Removes the exact admission row in the Auth deletion transaction, only for a job at `auth`
-- with the recorded generation. Otherwise the FK's set null behaves as before.
create function private.release_deleted_admission() returns trigger
language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s' as $$
declare a private.approved_accounts;
begin
  select * into a from private.approved_accounts where user_id=old.id for update;
  if found then
    perform 1 from private.deletion_jobs j where j.owner_id=old.id and j.stage='auth'
      and j.admission_no=a.admission_no and j.admission_generation=a.generation for share;
    if found then
      delete from private.approved_accounts
        where admission_no=a.admission_no and generation=a.generation and user_id=old.id;
    end if;
  end if;
  return old;
end;
$$;
create trigger stillroom_release_admission before delete on auth.users
for each row execute function private.release_deleted_admission();

-- Completed receipts are kept seven days, then purged. Service only.
create function public.purge_deletion_receipts() returns integer
language sql volatile security definer set search_path = '' as $$
  with gone as (delete from private.deletion_jobs
    where stage='complete' and completed_at < now() - interval '7 days' returning 1)
  select count(*)::integer from gone;
$$;
revoke all on function public.purge_deletion_receipts() from public,anon,authenticated;
grant execute on function public.purge_deletion_receipts() to service_role;

revoke all on function private.rotate_admission_generation(),private.deletion_receipt(private.deletion_jobs),
  private.deletion_owner_rows_absent(uuid),private.release_deleted_admission()
  from public,anon,authenticated,service_role;

commit;
