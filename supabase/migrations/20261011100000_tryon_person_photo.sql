-- TRYON-PHOTO1: one reusable reference body photo for try-on (issue #84, ADR28 amendment; owner decision #84 c6107168563 of
-- 11 October 2026). The owner may keep ONE full-length photo of themselves so that try-on starts from it instead of asking
-- for a photo each time. This is the single deliberate exception to "body photos are never stored"; no other body photo is
-- ever stored, hashed or logged. Classification:
--   additive: private.tryon_person_photos (one row per owner, RLS on, no grants, cascades with the profile), one trigger
--     function and trigger on private.ai_controls, one private structural JPEG admission function and four public functions
--     (status, get, put, delete; owner-only, no API-role table access);
--   NON-ADDITIVE (data): configured accounts move tryon_notice_revision from 1 to 2 (the new notice states the stored photo).
--     Consent is never written or manufactured: a consent at revision 1 now mismatches, so every account must turn try-on on
--     again. Unconfigured accounts stay unconfigured. Try-on stays inactive in production; nothing here activates anything;
--   NON-ADDITIVE (function replacement, same signatures, ACLs kept): public.tryon_discard_transient (also deletes every saved
--     photo, so a platform restore can never bring back a removed one) and private.deletion_owner_rows_absent (adds the table).
--     The bodies are the 20261004090000 ones, still the latest, with exactly one delta each.
-- Invariants: a photo exists only while the owner's consent revision equals the configured notice revision (the trigger deletes
-- it in the same transaction as any withdrawal, notice change or admin write); put needs notice AND consent revision 2 on the
-- locked controls row; get and delete need only an approved owner, so removal works under every pause, expiry or withdrawal.
-- Rollout (docs/cloud-development.md): apply, then deploy the Edge function with the revision-2 pin, then Pages. Any other
-- order fails closed. The body photo is still sent only by the existing step-1 upload; nothing in the Edge function reads this table.
begin;

create table private.tryon_person_photos (
  owner_id uuid primary key references public.profiles(owner_id) on delete cascade,
  jpeg bytea not null check (octet_length(jpeg) between 1 and 512000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  saved_at timestamptz not null,
  check (sha256 = encode(pg_catalog.sha256(jpeg),'hex'))
);
alter table private.tryon_person_photos enable row level security;
revoke all on private.tryon_person_photos from public,anon,authenticated,service_role;

-- Structural admission (the SQL side of src/images/restore-jpeg.ts isPhotoInputJpeg; the full entropy walk runs in the app
-- on save and on every read, and the Edge function checks the photo again when it is used). Accepts only the app's own
-- output shape: SOI, one optional exact JFIF APP0 first, quantisation and Huffman tables, ONE baseline 8-bit 3-component
-- frame of 1024x1280, at most one restart interval, ONE 3-component scan whose entropy data holds only stuffed FF00 and
-- in-order RSTn, then EOI as the very last two bytes. Every table is validated: 8-bit quantisation tables with no zero
-- entry, Huffman tables 0 and 1 with a legal code space and symbol range; the frame's component ids, sampling and table
-- references and the scan's component order, table selectors and baseline parameters must agree with each other and with
-- the tables defined before the scan. Any other APPn/COM segment (EXIF, GPS, an embedded thumbnail), any extra scan,
-- progressive or extended frame, fill byte or trailing byte is refused. One bounded pass; entropy data is not decoded here.
create function private.tryon_person_photo_admit(p bytea) returns boolean
language plpgsql immutable set search_path = '' as $$
declare n integer := coalesce(octet_length(p),0); i integer := 2; segs integer := 0; m integer; len integer; s integer; e integer;
  j integer; b integer; sof boolean := false; scans integer := 0; dri boolean := false; expected integer := 0;
  qmask integer := 0; dcmask integer := 0; acmask integer := 0; cid integer[] := array[0,0,0]; ctq integer[] := array[0,0,0];
  k integer; t integer; c integer; total integer; code integer; sampling integer; hv integer; tables integer;
begin
  if n<4 or n>512000 then return false; end if;
  if get_byte(p,0)<>255 or get_byte(p,1)<>216 or get_byte(p,n-2)<>255 or get_byte(p,n-1)<>217 then return false; end if;
  loop
    segs := segs+1;
    if segs>64 or i+2>n or get_byte(p,i)<>255 then return false; end if;
    m := get_byte(p,i+1);
    if m=217 then return sof and scans=1 and i+2=n; end if;
    if i+4>n then return false; end if;
    len := get_byte(p,i+2)*256+get_byte(p,i+3);
    if len<2 or i+2+len>n then return false; end if;
    s := i+4;
    e := i+2+len;
    if m=224 then
      if segs<>1 or len<>16 or get_byte(p,s)<>74 or get_byte(p,s+1)<>70 or get_byte(p,s+2)<>73 or get_byte(p,s+3)<>70
        or get_byte(p,s+4)<>0 or get_byte(p,e-2)<>0 or get_byte(p,e-1)<>0 then return false; end if;
    elsif m=219 then
      if scans>0 or len<3 then return false; end if;
      j := s;
      while j<e loop
        b := get_byte(p,j);
        if (b>>4)<>0 or (b&15)>3 or j+65>e then return false; end if;
        for k in 1..64 loop
          if get_byte(p,j+k)=0 then return false; end if;
        end loop;
        qmask := qmask|(1<<(b&15));
        j := j+65;
      end loop;
    elsif m=196 then
      if scans>0 or len<19 then return false; end if;
      j := s;
      while j<e loop
        b := get_byte(p,j);
        k := b>>4;
        t := b&15;
        if k>1 or t>1 or j+17>e then return false; end if;
        total := 0;
        code := 0;
        for c in 1..16 loop
          total := total+get_byte(p,j+c);
          code := code+get_byte(p,j+c);
          if code>=(1<<c) then return false; end if;
          code := code<<1;
        end loop;
        if total<1 or total>256 or j+17+total>e then return false; end if;
        for c in 0..total-1 loop
          b := get_byte(p,j+17+c);
          if (k=0 and b>11) or (k=1 and (b&15)>10) then return false; end if;
        end loop;
        if k=0 then dcmask := dcmask|(1<<t); else acmask := acmask|(1<<t); end if;
        j := j+17+total;
      end loop;
    elsif m=192 then
      if sof or scans>0 or len<>17 or get_byte(p,s)<>8 or get_byte(p,s+5)<>3 then return false; end if;
      if get_byte(p,s+1)*256+get_byte(p,s+2)<>1280 or get_byte(p,s+3)*256+get_byte(p,s+4)<>1024 then return false; end if;
      sampling := 0;
      for c in 0..2 loop
        cid[c+1] := get_byte(p,s+6+c*3);
        hv := get_byte(p,s+7+c*3);
        ctq[c+1] := get_byte(p,s+8+c*3);
        if (hv>>4)<1 or (hv>>4)>4 or (hv&15)<1 or (hv&15)>4 or ctq[c+1]>3 then return false; end if;
        if c>0 and cid[c+1] = any(cid[1:c]) then return false; end if;
        sampling := sampling+(hv>>4)*(hv&15);
      end loop;
      if sampling>10 then return false; end if;
      sof := true;
    elsif m=221 then
      if scans>0 or dri or len<>4 or get_byte(p,s)*256+get_byte(p,s+1)=0 then return false; end if;
      dri := true;
    elsif m=218 then
      if not sof or scans>0 or len<>12 or get_byte(p,s)<>3 or e>=n-2 then return false; end if;
      if get_byte(p,e-3)<>0 or get_byte(p,e-2)<>63 or get_byte(p,e-1)<>0 then return false; end if;
      for c in 0..2 loop
        tables := get_byte(p,s+2+c*2);
        if get_byte(p,s+1+c*2)<>cid[c+1] or (tables>>4)>3 or (tables&15)>3
          or (dcmask&(1<<(tables>>4)))=0 or (acmask&(1<<(tables&15)))=0 or (qmask&(1<<ctq[c+1]))=0 then
          return false;
        end if;
      end loop;
      scans := 1;
      j := e;
      while j<n-2 loop
        if get_byte(p,j)<>255 then
          j := j+1;
        else
          b := get_byte(p,j+1);
          if b=0 then
            j := j+2;
          elsif b between 208 and 215 then
            if not dri or b<>208+(expected%8) then return false; end if;
            expected := expected+1;
            j := j+2;
          else
            return false;
          end if;
        end if;
      end loop;
      if j<>n-2 then return false; end if;
      i := n-2;
      continue;
    else
      return false;
    end if;
    i := e;
  end loop;
end;
$$;

-- A photo exists only while consent is at the configured notice revision: both set and equal. Fires for Turn off, any notice
-- change, an administrator reset that clears both, and any other writer; the delete is part of the same transaction.
create function private.tryon_person_photo_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.tryon_consent_revision is null or new.tryon_notice_revision is null
    or new.tryon_consent_revision<>new.tryon_notice_revision then
    delete from private.tryon_person_photos where owner_id=new.owner_id;
  end if;
  return null;
end;
$$;
create trigger ai_controls_tryon_person_photo_guard after update of tryon_consent_revision,tryon_notice_revision
  on private.ai_controls for each row execute function private.tryon_person_photo_guard();

-- Owner reads. Approved owner only; no activation, consent or provider state is needed, so a saved photo stays visible
-- (and removable) while try-on is paused, withdrawn or past review.
create function public.tryon_person_photo_status_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select octet_length(jpeg) as bytes,saved_at into r from private.tryon_person_photos where owner_id=auth.uid();
  if not found then return jsonb_build_object('code','OK','saved',false); end if;
  return jsonb_build_object('code','OK','saved',true,'bytes',r.bytes,
    'savedAtMs',floor(extract(epoch from r.saved_at)*1000)::bigint);
end;
$$;

create function public.tryon_person_photo_get_v1() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  if auth.uid() is null or not private.is_approved() then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select jpeg,sha256,saved_at into r from private.tryon_person_photos where owner_id=auth.uid();
  if not found then return jsonb_build_object('code','NOT_FOUND'); end if;
  return jsonb_build_object('code','OK','jpegBase64',translate(encode(r.jpeg,'base64'),E'\n',''),'sha256',r.sha256,
    'bytes',octet_length(r.jpeg),'savedAtMs',floor(extract(epoch from r.saved_at)*1000)::bigint);
end;
$$;

-- Saves or replaces the owner's one photo. Same lock order as tryon_set_consent (approved account, profile, controls), so a
-- save and a withdrawal serialise. Ordinary permission is not enough: the configured notice AND the owner's consent must both
-- be revision 2, the revision that states the stored photo. Every refusal is a fixed code that echoes nothing of the input.
create function public.tryon_person_photo_put_v1(p_jpeg_base64 text,p_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles; c private.ai_controls; v_now timestamptz := clock_timestamp(); v_code text; v_bytes bytea;
begin
  if auth.uid() is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found then return jsonb_build_object('code','UNCONFIGURED'); end if;
  v_code := private.tryon_permission(p,c,v_now);
  if v_code<>'OK' then return jsonb_build_object('code',v_code); end if;
  if c.tryon_notice_revision is distinct from 2 or c.tryon_consent_revision is distinct from 2 then
    return jsonb_build_object('code','CONSENT_REQUIRED');
  end if;
  if p_jpeg_base64 is null or p_sha256 is null or length(p_jpeg_base64) not between 8 and 682668 or length(p_jpeg_base64)%4<>0
    or p_jpeg_base64 !~ '^[A-Za-z0-9+/]+={0,2}$' or p_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  begin
    v_bytes := decode(p_jpeg_base64,'base64');
  exception when others then
    return jsonb_build_object('code','INVALID_INPUT');
  end;
  if encode(pg_catalog.sha256(v_bytes),'hex')<>p_sha256 or not private.tryon_person_photo_admit(v_bytes) then
    return jsonb_build_object('code','INVALID_INPUT');
  end if;
  insert into private.tryon_person_photos(owner_id,jpeg,sha256,saved_at) values(p.owner_id,v_bytes,p_sha256,v_now)
    on conflict (owner_id) do update set jpeg=excluded.jpeg,sha256=excluded.sha256,saved_at=excluded.saved_at;
  return jsonb_build_object('code','OK','saved',true,'bytes',octet_length(v_bytes),
    'savedAtMs',floor(extract(epoch from v_now)*1000)::bigint);
end;
$$;

-- Removes the owner's photo. Idempotent; needs only an approved owner, whatever the try-on state.
create function public.tryon_person_photo_delete_v1() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare p public.profiles;
begin
  if auth.uid() is null then return jsonb_build_object('code','UNAVAILABLE'); end if;
  perform 1 from private.approved_accounts where user_id=auth.uid() for share;
  select * into p from public.profiles where owner_id=auth.uid() for update;
  if not found or not private.ai_owner_approved(p.owner_id) then return jsonb_build_object('code','UNAVAILABLE'); end if;
  delete from private.tryon_person_photos where owner_id=p.owner_id;
  return jsonb_build_object('code','OK','saved',false);
end;
$$;

-- The notice states the stored photo from revision 2. Configured accounts only; consent is not touched, so a consent at 1 now
-- mismatches (CONSENT_REQUIRED) and the trigger above finds no photo to remove.
update private.ai_controls set tryon_notice_revision=2,updated_at=clock_timestamp() where tryon_notice_revision=1;

-- Platform-restore step (database owner only, as before): the 20261004090000 body plus the saved photos, so a restore cannot
-- bring back a photo the owner had removed; the owner adds it again.
create or replace function public.tryon_discard_transient() returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare v_now timestamptz := clock_timestamp(); v_owner uuid; v_r integer; v_c integer; v_s integer; v_p integer; n integer := 0;
begin
  delete from private.tryon_results;
  get diagnostics v_r = row_count;
  delete from private.tryon_chains;
  get diagnostics v_c = row_count;
  delete from private.tryon_attempts;
  delete from private.tryon_chain_stops;
  get diagnostics v_s = row_count;
  delete from private.tryon_person_photos;
  get diagnostics v_p = row_count;
  for v_owner in
    select pr.owner_id from public.profiles pr where exists(select 1 from private.ai_usage u where u.owner_id=pr.owner_id
      and u.purpose='try_on' and u.charge_state='held') order by pr.owner_id for update of pr
  loop
    perform 1 from private.ai_controls where owner_id=v_owner for update;
    n := n+private.tryon_expire_accounting(v_owner,v_now,100);
  end loop;
  return jsonb_build_object('code','OK','resultsDeleted',v_r,'chainsDeleted',v_c,'stopsDeleted',v_s,'photosDeleted',v_p,'expired',n);
end;
$$;

create or replace function private.deletion_owner_rows_absent(p_owner uuid) returns boolean
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
    or exists(select 1 from private.item_deletion_targets where owner_id=p_owner)
    or exists(select 1 from private.imported_attribution_history where owner_id=p_owner)
    or exists(select 1 from private.image_enhancements where owner_id=p_owner)
    or exists(select 1 from private.enhancement_outputs where owner_id=p_owner)
    or exists(select 1 from private.image_provenance where owner_id=p_owner)
    or exists(select 1 from private.image_enhancement_bindings where owner_id=p_owner)
    or exists(select 1 from private.restore_image_markers where owner_id=p_owner)
    or exists(select 1 from private.enhancement_probe_authorisations where owner_id=p_owner)
    or exists(select 1 from private.app_admins where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where owner_id=p_owner)
    or exists(select 1 from private.ai_limit_audit where actor_owner_id=p_owner)
    or exists(select 1 from private.tryon_chains where owner_id=p_owner)
    or exists(select 1 from private.tryon_attempts where owner_id=p_owner)
    or exists(select 1 from private.tryon_results where owner_id=p_owner)
    or exists(select 1 from private.tryon_probe_authorisations where owner_id=p_owner)
    or exists(select 1 from private.tryon_chain_stops where owner_id=p_owner)
    or exists(select 1 from private.tryon_person_photos where owner_id=p_owner));
$$;

revoke all on function private.tryon_person_photo_admit(bytea),private.tryon_person_photo_guard()
  from public,anon,authenticated,service_role;
revoke all on function public.tryon_person_photo_status_v1(),public.tryon_person_photo_get_v1(),
  public.tryon_person_photo_put_v1(text,text),public.tryon_person_photo_delete_v1()
  from public,anon,authenticated,service_role;
grant execute on function public.tryon_person_photo_status_v1(),public.tryon_person_photo_get_v1(),
  public.tryon_person_photo_put_v1(text,text),public.tryon_person_photo_delete_v1() to authenticated;

-- Postconditions: the table is private with RLS and no API grant; the four public functions are owner-callable definer
-- functions; the private ones and the two replaced ones are not callable by an API role; no configured account is still at 1.
do $$
declare r regprocedure; p pg_catalog.pg_proc;
begin
  if not (select relrowsecurity from pg_catalog.pg_class where oid='private.tryon_person_photos'::regclass)
    or has_table_privilege('authenticated','private.tryon_person_photos','SELECT')
    or has_table_privilege('anon','private.tryon_person_photos','SELECT')
    or has_table_privilege('service_role','private.tryon_person_photos','SELECT') then
    raise exception 'TRYON-PHOTO1 postcondition: the photo table is not private';
  end if;
  foreach r in array array['public.tryon_person_photo_status_v1()','public.tryon_person_photo_get_v1()',
    'public.tryon_person_photo_put_v1(text,text)','public.tryon_person_photo_delete_v1()']::regprocedure[] loop
    select * into p from pg_catalog.pg_proc where oid=r;
    if not p.prosecdef or p.proconfig is null or not ('search_path=""' = any(p.proconfig))
      or not has_function_privilege('authenticated',r,'EXECUTE') or has_function_privilege('anon',r,'EXECUTE')
      or has_function_privilege('service_role',r,'EXECUTE') then
      raise exception 'TRYON-PHOTO1 postcondition: % properties not as expected',r;
    end if;
  end loop;
  foreach r in array array['private.tryon_person_photo_admit(bytea)','private.tryon_person_photo_guard()',
    'public.tryon_discard_transient()','private.deletion_owner_rows_absent(uuid)']::regprocedure[] loop
    if has_function_privilege('anon',r,'EXECUTE') or has_function_privilege('authenticated',r,'EXECUTE')
      or has_function_privilege('service_role',r,'EXECUTE') then
      raise exception 'TRYON-PHOTO1 postcondition: % is callable by an API role',r;
    end if;
  end loop;
  if exists(select 1 from private.ai_controls where tryon_notice_revision=1) then
    raise exception 'TRYON-PHOTO1 postcondition: a configured account is still at notice revision 1';
  end if;
end;
$$;

commit;
