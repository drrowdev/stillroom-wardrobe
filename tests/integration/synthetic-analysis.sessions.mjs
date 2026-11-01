// SYNTHETIC historical analysis fixtures for the CI-only preservation rehearsal.
//
// The Azure manifests carry fixed review dates (azure v1/v2: 2026-10-21) that the frozen historical function bodies enforce
// with clock_timestamp(). Once a date has passed, those bodies refuse every claim (UNCONFIGURED), close a finish as
// UNAVAILABLE and refuse an analyzed Save, so a populated historical fixture can no longer be produced by the product path.
// The persistent-availability migration removes those dates from the active functions; the older stages stay byte-identical.
//
// These helpers therefore enter a SYNTHETIC path only after the expiry is independently established from the manifest row
// (review_expires_at <= clock_timestamp(), read in SQL) AND the real historical function has been called and returned its
// exact documented refusal. The synthetic statements are the success write sequence copied statement-for-statement from the
// historical bodies (pinned by tests/unit/synthetic-analysis-fixture.test.ts for every stage that defines them), with the
// real private.ai_begin_owner, private.ai_settle_core and private.reserve_item_save doing their own writes. Nothing here
// rewrites a manifest, backdates a clock, edits history or skips a check. Fixtures built this way are SYNTHETIC: they carry
// the shape of a historical success, not a real historical claim, finish or Save.
import { randomUUID } from 'node:crypto';
import { requireEvidence } from './preservation.sessions.mjs';
import { equal, analysisFacts, analysisHash, analysisUsage } from './ai-analysis.sessions.mjs';
import { jpegHeaderFixture } from '../fixtures/jpeg-helpers.ts';

const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const FIELDS = ['category', 'subcategory', 'colours', 'pattern', 'sleeve_length', 'garment_length', 'brand', 'size_label',
  'upper_coverage', 'lower_coverage', 'material', 'seasons', 'formality', 'style_tags'];

export const SYNTHETIC_LABEL = 'SYNTHETIC historical fixture';

// Expiry as the historical bodies read it: the manifest row against the database clock.
export async function manifestExpired(sql, manifestId) {
  const out = (await sql(`select coalesce((select review_expires_at<=clock_timestamp()
    from private.ai_execution_manifests where id=${literal(manifestId)}),false);`)).trim();
  requireEvidence(out === 't' || out === 'f');
  return out === 't';
}

const guard = (manifest) => `select * into m from private.ai_execution_manifests where id=${literal(manifest)}
    and id in ('azure-eu-terra-devtest-v1','azure-eu-terra-devtest-v2');
  if not found or m.review_expires_at>clock_timestamp() then raise exception 'SYNTHETIC_EXPIRY_NOT_ESTABLISHED'; end if;
  if c.execution_manifest_id<>m.id or c.model_id<>m.model_id or c.prompt_version<>m.prompt_version or c.notice_revision<>2
    or c.max_request_micro<m.reservation_micro then raise exception 'SYNTHETIC_CONFIG'; end if;`;

// The success half of public.ai_claim_analysis, after its permission and configuration checks.
export function syntheticClaimSql({ owner, requestId, draftId, generation, hash, bytes, width, height, manifest }) {
  return `do $synthetic$
declare p_owner_id uuid := ${literal(owner)}; p_request_id uuid := ${literal(requestId)}; p_draft_id uuid := ${literal(draftId)};
  p_generation integer := ${Number(generation)}; p_image_sha256 text := ${literal(hash)}; p_byte_count integer := ${Number(bytes)};
  p_width integer := ${Number(width)}; p_height integer := ${Number(height)};
  p public.profiles; c private.ai_controls; m private.ai_execution_manifests; r private.ai_requests;
  v_now timestamptz; v_code text; v_result jsonb; v_deadline timestamptz;
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then raise exception 'SYNTHETIC_PROFILE'; end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  v_code := private.ai_permission(p,c);
  if v_code<>'OK' then raise exception 'SYNTHETIC_PERMISSION %',v_code; end if;
  ${guard(manifest)}
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id) then
    raise exception 'SYNTHETIC_REPLAY';
  end if;
  v_result := private.ai_begin_owner(p.owner_id,p_request_id,p_draft_id,p_generation,p_image_sha256);
  if v_result->>'code'<>'OK' or (v_result->>'replayed')::boolean is distinct from false then
    raise exception 'SYNTHETIC_BEGIN %',v_result;
  end if;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id;
  v_now := clock_timestamp();
  v_deadline := least(v_now+interval '20 seconds',r.expires_at);
  insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,claim_identity)
    values(p.owner_id,p_request_id,m.id,'not_observed',jsonb_build_object('draftId',p_draft_id,'generation',p_generation,
      'imageSha256',p_image_sha256,'bytes',p_byte_count,'width',p_width,'height',p_height));
  insert into private.ai_analysis_attestations values(p.owner_id,p_request_id,p_image_sha256,
    p_byte_count,p_width,p_height,m.id,v_now,v_deadline);
  update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;
end $synthetic$;`;
}

// The valid-usage, valid-facts success path of public.ai_finish_analysis: its settlement is the real private.ai_settle_core.
export function syntheticFinishSql({ owner, requestId, manifest, facts, usage }) {
  return `do $synthetic$
declare p_owner_id uuid := ${literal(owner)}; p_request_id uuid := ${literal(requestId)};
  p_facts jsonb := ${json(facts)}; p_usage jsonb := ${json(usage)};
  p public.profiles; c private.ai_controls; u private.ai_usage; r private.ai_requests; e private.ai_usage_evidence;
  m private.ai_execution_manifests; v_now timestamptz; v_estimate bigint; v_anomaly boolean := false;
  v_model text; v_control text; v_result jsonb; v_fields text[] := array[${FIELDS.map(literal).join(',')}];
begin
  select * into p from public.profiles where owner_id=p_owner_id for update;
  if not found then raise exception 'SYNTHETIC_PROFILE'; end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  v_now := clock_timestamp();
  select * into u from private.ai_usage where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into r from private.ai_requests where owner_id=p.owner_id and request_id=p_request_id for update;
  select * into e from private.ai_usage_evidence where owner_id=p.owner_id and request_id=p_request_id for update;
  if u.request_id is null or r.request_id is null or e.request_id is null or e.manifest_id<>${literal(manifest)}
    or r.status<>'dispatched' or r.expires_at<=v_now or private.ai_permission(p,c)<>'OK' then
    raise exception 'SYNTHETIC_FINISH_STATE';
  end if;
  ${guard(manifest)}
  v_model := p_usage->>'modelObservation'; v_control := p_usage->>'controlObservation';
  if v_control<>'ordinary' or v_model in ('not_observed','response_missing_model','response_unrecognised_model')
    or not private.ai_valid_facts(p_facts) or not coalesce(p_facts->'fields' ?& v_fields,false)
    or (p_facts->'fields')-v_fields<>'{}'::jsonb then raise exception 'SYNTHETIC_FINISH_INPUT'; end if;
  update private.ai_usage_evidence set model_observation=v_model,control_observation=v_control
    where owner_id=p.owner_id and request_id=p_request_id;
  v_estimate := ceil(((p_usage->>'input')::numeric*m.input_rate_hundredths
    +(p_usage->>'output')::numeric*m.output_rate_hundredths)/100)::bigint;
  v_anomaly := (p_usage->>'input')::numeric>m.input_envelope or (p_usage->>'output')::numeric>m.output_envelope;
  if v_anomaly then raise exception 'SYNTHETIC_FINISH_ANOMALY'; end if;
  update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=v_estimate,anomaly=v_anomaly
    where owner_id=p.owner_id and request_id=p_request_id;
  update private.ai_usage set accounted_micro=v_estimate,charge_state='estimated'
      where owner_id=p.owner_id and request_id=p_request_id returning * into u;
  v_result := private.ai_settle_core(p_owner_id,p_request_id,p_facts,null,'SUCCESS');
  if (v_result->>'stored')::boolean is distinct from true then raise exception 'SYNTHETIC_SETTLE %',v_result; end if;
end $synthetic$;`;
}

// The success half of private.reserve_analyzed_item_save_v10 (public.reserve_analyzed_item_save before the image-change
// migration), from the claim checks to the attempt row, including the ai_item_save_context install and removal that
// authorise AI provenance for private.reserve_item_save.
export function syntheticSaveSql({ owner, item, image, claim, manifest }) {
  return `select set_config('request.jwt.claim.sub',${literal(owner)},true);
select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner, role: 'authenticated' }))},true);
do $synthetic$
declare p_item jsonb := ${json(item)}; p_image jsonb := ${json(image)}; p_claim jsonb := ${json(claim)};
  v_owner uuid; i public.items; a private.ai_item_save_attempts;
  p public.profiles; c private.ai_controls; r private.ai_requests; u private.ai_usage;
  proof private.ai_analysis_attestations; m private.ai_execution_manifests; e private.ai_usage_evidence;
  k text; v jsonb; kind text; derived jsonb := '{}'; result record;
begin
  v_owner := private.item_save_owner();
  if v_owner<>${literal(owner)}::uuid then raise exception 'SYNTHETIC_OWNER'; end if;
  i := jsonb_populate_record(null::public.items,p_item||jsonb_build_object('owner_id',v_owner,'version',1));
  if exists(select 1 from private.ai_item_save_attempts where owner_id=v_owner and item_id=i.id)
    or exists(select 1 from private.item_save_used_ids x where x.owner_id=v_owner
      and (x.item_id=i.id or x.image_id=(p_image->>'id')::uuid))
    or exists(select 1 from private.ai_save_used_receipts x where x.owner_id=v_owner
      and (x.request_id=(p_claim->>'requestId')::uuid or x.item_id=i.id or x.image_id=(p_image->>'id')::uuid)) then
    raise exception 'SYNTHETIC_SAVE_REPLAY';
  end if;
  select * into p from public.profiles where owner_id=v_owner;
  select * into c from private.ai_controls where owner_id=v_owner for update nowait;
  select * into u from private.ai_usage where owner_id=v_owner and request_id=(p_claim->>'requestId')::uuid for update nowait;
  if not found or u.dispatched_at is null then raise exception 'SYNTHETIC_SAVE_USAGE'; end if;
  select * into r from private.ai_requests where owner_id=v_owner and request_id=u.request_id for update nowait;
  if not found or r.expires_at<=clock_timestamp() or private.ai_permission(p,c)<>'OK'
    or p_claim->'requestId' is distinct from to_jsonb(r.request_id) or p_claim->'draftId' is distinct from to_jsonb(r.draft_id)
    or p_claim->'generation' is distinct from to_jsonb(r.generation) or p_claim->'imageSha256' is distinct from to_jsonb(r.image_sha256)
    or r.model_id<>c.model_id or r.prompt_version<>c.prompt_version or r.notice_revision<>c.notice_revision then
    raise exception 'SYNTHETIC_SAVE_REQUEST';
  end if;
  select * into proof from private.ai_analysis_attestations where owner_id=v_owner and request_id=r.request_id for share nowait;
  if not found or p_image->'main_sha256' is distinct from to_jsonb(proof.image_sha256)
    or p_image->'main_bytes' is distinct from to_jsonb(proof.byte_count)
    or p_image->'width' is distinct from to_jsonb(proof.width)
    or p_image->'height' is distinct from to_jsonb(proof.height) then raise exception 'SYNTHETIC_SAVE_PROOF'; end if;
  ${guard(manifest)}
  if proof.manifest_id<>m.id or r.status<>'ready' or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts) then
    raise exception 'SYNTHETIC_SAVE_FACTS';
  end if;
  update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
    'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
    where owner_id=v_owner and request_id=u.request_id and claim_identity is null;
  for k,v in select key,value from jsonb_each(p_claim->'fields') loop
    kind := case when k=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
      when k=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
      then 'ai_observed' else null end;
    if kind is null or jsonb_typeof(v)<>'object' or v is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->k)
      or r.facts->'fields'->k is null or r.facts->'fields'->k in ('null'::jsonb,'[]'::jsonb)
      or p_item->k is distinct from r.facts->'fields'->k
      or p_item->'field_provenance'->k is distinct from jsonb_build_object('kind',kind,'revision',1) then
      raise exception 'SYNTHETIC_SAVE_FIELDS';
    end if;
    derived := derived||jsonb_build_object(k,jsonb_build_object('kind',kind,'revision',1));
  end loop;
  insert into private.ai_save_used_receipts values(v_owner,r.request_id,i.id,(p_image->>'id')::uuid);
  for k,v in select key,value from jsonb_each(i.field_provenance) loop
    if v->>'kind' in ('ai_observed','ai_estimated') and v is distinct from derived->k then
      raise exception 'SYNTHETIC_SAVE_PROVENANCE';
    end if;
  end loop;
  select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);
  insert into private.ai_item_save_context values(v_owner,i.id,private.item_save_value_hash(i));
  select * into result from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);
  delete from private.ai_item_save_context where owner_id=v_owner and item_id=i.id;
  insert into private.ai_item_save_attempts values(v_owner,i.id,encode(sha256(convert_to(p_claim::text,'UTF8')),'hex'),
    m.id,m.model_id,m.prompt_version,proof.image_sha256,proof.byte_count,proof.width,proof.height,derived,false);
  perform set_config('synthetic.row',jsonb_build_object('item',result.item,'image',result.image,
    'fingerprint',result.fingerprint,'state',result.state)::text,true);
end $synthetic$;
select 'ROW:'||current_setting('synthetic.row');`;
}

// The success half of private.reserve_image_change for an analyzed replacement (never a recovery), from the claim checks to
// the reserved attempt row. The caller has already seen the real function refuse after the manifest's date.
export function syntheticImageChangeSql({ owner, intent, manifest }) {
  return `select set_config('request.jwt.claim.sub',${literal(owner)},true);
select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner, role: 'authenticated' }))},true);
do $synthetic$
declare p_owner uuid := ${literal(owner)}; p_intent jsonb := ${json(intent)}; p_recovery_objects jsonb := null;
  a private.image_change_attempts; target public.items; old_item public.items; image public.item_images; source public.item_images;
  r private.ai_requests; proof private.ai_analysis_attestations; m private.ai_execution_manifests;
  p public.profiles; c private.ai_controls; u private.ai_usage; e private.ai_usage_evidence;
  claim jsonb := nullif(p_intent->'claim','null'); derived jsonb := '{}'; key text; value jsonb; kind text;
  fingerprint text := private.image_change_hash(p_intent); recovery boolean := false;
begin
  perform private.image_change_lock(p_owner);
  perform 1 from public.profiles where owner_id=p_owner for update nowait;
  if not found then raise exception 'SYNTHETIC_PROFILE'; end if;
  if exists(select 1 from private.image_change_attempts where owner_id=p_owner and request_id=(p_intent->>'requestId')::uuid)
    or claim is null or p_intent->'sourceImageId' is distinct from 'null'::jsonb then raise exception 'SYNTHETIC_REPLACEMENT_SHAPE'; end if;
  target := private.image_change_intent(p_owner,p_intent);
  select * into old_item from public.items where owner_id=p_owner and id=target.id;
  if exists(select 1 from private.ai_save_used_receipts where owner_id=p_owner and request_id=(claim->>'requestId')::uuid)
    or exists(select 1 from private.image_change_attempts where owner_id=p_owner and analysis_request_id=(claim->>'requestId')::uuid)
    or claim->'imageSha256' is distinct from p_intent->'image'->'main_sha256' then raise exception 'SYNTHETIC_REPLACEMENT_CLAIM'; end if;
  select * into p from public.profiles where owner_id=p_owner;
  select * into c from private.ai_controls where owner_id=p_owner for update nowait;
  select * into u from private.ai_usage where owner_id=p_owner and request_id=(claim->>'requestId')::uuid for update nowait;
  if not found or u.dispatched_at is null then raise exception 'SYNTHETIC_REPLACEMENT_USAGE'; end if;
  select * into r from private.ai_requests where owner_id=p_owner and request_id=u.request_id for update nowait;
  if not found or r.expires_at<=clock_timestamp() or private.ai_permission(p,c)<>'OK' then raise exception 'SYNTHETIC_REPLACEMENT_REQUEST'; end if;
  select * into proof from private.ai_analysis_attestations where owner_id=p_owner and request_id=r.request_id for share nowait;
  if not found or claim->'draftId' is distinct from to_jsonb(r.draft_id)
    or claim->'generation' is distinct from to_jsonb(r.generation)
    or claim->'imageSha256' is distinct from to_jsonb(r.image_sha256)
    or to_jsonb(proof.image_sha256) is distinct from claim->'imageSha256'
    or to_jsonb(proof.byte_count) is distinct from p_intent->'image'->'main_bytes'
    or to_jsonb(proof.width) is distinct from p_intent->'image'->'width'
    or to_jsonb(proof.height) is distinct from p_intent->'image'->'height' then raise exception 'SYNTHETIC_REPLACEMENT_PROOF'; end if;
  ${guard(manifest)}
  if proof.manifest_id<>m.id or r.status<>'ready' or r.facts->>'outcome'<>'ready' or not private.ai_valid_facts(r.facts) then
    raise exception 'SYNTHETIC_REPLACEMENT_FACTS';
  end if;
  update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
    'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
    where owner_id=p_owner and request_id=u.request_id and claim_identity is null;
  for key,value in select k,v from jsonb_each(claim->'fields') as f(k,v) loop
    kind := case when key=any(array['material','seasons','formality','style_tags']) then 'ai_estimated'
      when key=any(array['category','subcategory','colours','pattern','sleeve_length','garment_length','brand','size_label','upper_coverage','lower_coverage'])
      then 'ai_observed' else null end;
    if kind is null or value is distinct from jsonb_build_object('kind',kind,'value',r.facts->'fields'->key)
      or r.facts->'fields'->key is null or r.facts->'fields'->key in ('null'::jsonb,'[]'::jsonb)
      or p_intent->'item'->key is distinct from r.facts->'fields'->key
      or old_item.field_provenance->key->>'kind'='user'
      or to_jsonb(old_item)->key not in ('null'::jsonb,'[]'::jsonb,'""'::jsonb)
      or target.field_provenance->key is distinct from jsonb_build_object('kind',kind,
        'revision',coalesce((old_item.field_provenance->key->>'revision')::integer,0)+1) then
      raise exception 'SYNTHETIC_REPLACEMENT_FIELDS';
    end if;
    derived := derived||jsonb_build_object(key,target.field_provenance->key);
  end loop;
  for key,value in select k,v from jsonb_each(target.field_provenance) as f(k,v) loop
    if value->>'kind' in ('ai_observed','ai_estimated') and value is distinct from old_item.field_provenance->key
      and value is distinct from derived->key then raise exception 'SYNTHETIC_REPLACEMENT_PROVENANCE'; end if;
  end loop;
  image := jsonb_populate_record(null::public.item_images,p_intent->'image');
  insert into public.item_images(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
    values(image.id,p_owner,target.id,image.main_bytes,image.thumb_bytes,image.main_sha256,image.thumb_sha256,image.width,image.height,image.alt_text)
    returning * into image;
  insert into private.image_change_attempts(owner_id,request_id,item_id,image_id,kind,state,expected_version,current_image_id,
    description_version,fingerprint,item_hash,result_hash,source_image_id,source_objects,analysis_request_id,manifest_id,model_id,prompt_version,fields)
    values(p_owner,(p_intent->>'requestId')::uuid,target.id,image.id,case when recovery then 'recovery' else 'replacement' end,'reserved',
      old_item.version,(p_intent->>'currentImageId')::uuid,(p_intent->>'descriptionVersion')::integer,fingerprint,
      private.item_save_value_hash(old_item),private.item_save_value_hash(target),source.id,p_recovery_objects,u.request_id,
      m.id,m.model_id,m.prompt_version,derived) returning * into a;
  perform set_config('synthetic.receipt',private.image_change_receipt(a)::text,true);
end $synthetic$;
select 'RECEIPT:'||current_setting('synthetic.receipt');`;
}

const run = async (sql, body) => sql(`begin; set local lock_timeout='2s'; set local statement_timeout='30s';\n${body}\ncommit;`);

// A claim that must succeed. Before the manifest's date the real function runs. After it, the real function must return
// exactly its historical refusal first; only then is the labelled synthetic success sequence written.
export async function analysisClaim(sql, owner, requestId, manifest, shape = {}) {
  const { draftId = requestId, generation = 1, hash: imageHash = analysisHash, bytes = jpegHeaderFixture().length,
    width = 120, height = 80 } = shape;
  const before = await manifestExpired(sql, manifest);
  const real = JSON.parse(await sql(`select public.ai_claim_analysis(${literal(owner.uid)},${literal(requestId)},${literal(draftId)},
    ${generation},${literal(imageHash)},${bytes},${width},${height},${literal(manifest)});`));
  requireEvidence(before === await manifestExpired(sql, manifest));
  if (!before) return real;
  equal(real, { code: 'UNCONFIGURED', claimed: false });
  await run(sql, syntheticClaimSql({ owner: owner.uid, requestId, draftId, generation, hash: imageHash, bytes, width, height, manifest }));
  return { code: 'OK', claimed: true, manifestId: manifest, synthetic: true };
}

// A successful finish. After the manifest's date the real function would close the request as UNAVAILABLE, so the labelled
// synthetic success sequence is written instead; the real refusal is asserted by expiredAnalysisRefusalProbe.
export async function analysisFinishSuccess(sql, owner, requestId, manifest, facts = analysisFacts, usage = analysisUsage) {
  if (!(await manifestExpired(sql, manifest))) {
    return JSON.parse(await sql(`select public.ai_finish_analysis(${literal(owner.uid)},${literal(requestId)},${literal(manifest)},
      ${json(facts)},${json(usage)},'SUCCESS');`));
  }
  await run(sql, syntheticFinishSql({ owner: owner.uid, requestId, manifest, facts, usage }));
  return { code: 'OK', stored: true, synthetic: true };
}

// A reservation that must succeed: the real public RPC before the date, the labelled synthetic success sequence after it.
// The row is checked by the caller exactly as a real row is.
export async function analyzedSaveRow(h, sql, owner, value, manifest) {
  if (!(await manifestExpired(sql, manifest))) return h.reserve(value);
  const out = await run(sql, syntheticSaveSql({ owner: owner.uid, item: value.p_item, image: value.p_image, claim: value.p_claim, manifest }));
  const line = out.split('\n').find((entry) => entry.startsWith('ROW:'));
  requireEvidence(line !== undefined);
  return h.accept(value, JSON.parse(line.slice(4)));
}

// The real historical refusals after the manifest's date, on disposable rows inside a transaction that is rolled back:
// a finish closes the request as UNAVAILABLE without storing, and an analyzed Save returns analysis_unavailable.
// Nothing here reaches the preserved snapshot.
export async function expiredAnalysisRefusalProbe(sql, owner, manifest, value) {
  if (!(await manifestExpired(sql, manifest))) return false;
  const shape = (requestId) => ({ owner: owner.uid, requestId, draftId: requestId, generation: 1,
    hash: value.p_claim.imageSha256, bytes: value.p_image.main_bytes, width: value.p_image.width, height: value.p_image.height, manifest });
  const finishId = randomUUID(), saveId = randomUUID();
  const claim = { ...value.p_claim, requestId: saveId, draftId: saveId };
  const out = await sql(`begin; set local lock_timeout='2s'; set local statement_timeout='30s';
${syntheticClaimSql(shape(finishId))}
select 'FINISH:'||public.ai_finish_analysis(${literal(owner.uid)},${literal(finishId)},${literal(manifest)},
  ${json(analysisFacts)},${json(analysisUsage)},'SUCCESS')::text;
select 'FINISH_REQUESTS:'||count(*) from private.ai_requests where owner_id=${literal(owner.uid)} and request_id=${literal(finishId)};
select 'FINISH_CLOSED:'||coalesce(closed_reason,'-') from private.ai_usage where owner_id=${literal(owner.uid)} and request_id=${literal(finishId)};
${syntheticClaimSql(shape(saveId))}
${syntheticFinishSql({ owner: owner.uid, requestId: saveId, manifest, facts: analysisFacts, usage: analysisUsage })}
select set_config('request.jwt.claim.sub',${literal(owner.uid)},true);
select set_config('request.jwt.claims',${literal(JSON.stringify({ sub: owner.uid, role: 'authenticated' }))},true);
select 'SAVE:'||state from public.reserve_analyzed_item_save(${json(value.p_item)},${json(value.p_image)},${json(claim)});
select 'SAVE_CLOSED:'||coalesce(closed_reason,'-') from private.ai_usage where owner_id=${literal(owner.uid)} and request_id=${literal(saveId)};
rollback;`);
  const lines = Object.fromEntries(out.split('\n').filter((line) => /^[A-Z_]+:/.test(line))
    .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
  const finish = JSON.parse(lines.FINISH);
  equal([finish.code, finish.stored], ['UNAVAILABLE', false]);
  equal([lines.FINISH_REQUESTS, lines.FINISH_CLOSED], ['0', 'UNAVAILABLE']);
  equal([lines.SAVE, lines.SAVE_CLOSED], ['analysis_unavailable', 'UNAVAILABLE']);
  const left = (await sql(`select count(*) from private.ai_usage where owner_id=${literal(owner.uid)}
    and request_id in (${literal(finishId)},${literal(saveId)});`)).trim();
  equal(left, '0');
  return true;
}

// An analyzed replacement reservation that must succeed: the real RPC before the date, the labelled synthetic success
// sequence after it. The receipt is checked by the caller exactly as a real receipt is (ich.accept).
export async function analyzedReplacementReceipt(ich, sql, owner, value, manifest) {
  if (!(await manifestExpired(sql, manifest))) return ich.reserve(value);
  const out = await run(sql, syntheticImageChangeSql({ owner: owner.uid, intent: value, manifest }));
  const line = out.split('\n').find((entry) => entry.startsWith('RECEIPT:'));
  requireEvidence(line !== undefined);
  return ich.accept(value, JSON.parse(line.slice(8)));
}

// An analysis ("tagging") claim expression for the shared-allowance contention probes of the stylist and enhancement
// ledgers. Before the manifest's date it is the real claim. After it the real claim refuses earlier than the allowance
// rule (UNCONFIGURED), so the expression calls the real private.ai_begin_owner that owns that rule, with the claim's
// result shape (code, claimed).
export async function tagClaimStatement(sql, ownerUid, requestId, manifest) {
  const head = `${literal(ownerUid)},${literal(requestId)},${literal(requestId)},1,${literal(analysisHash)}`;
  if (!(await manifestExpired(sql, manifest))) {
    return `public.ai_claim_analysis(${head},${jpegHeaderFixture().length},120,80,${literal(manifest)})`;
  }
  return `(select jsonb_build_object('code',b->>'code','claimed',b->>'code'='OK') from (select private.ai_begin_owner(${head}) b) s)`;
}