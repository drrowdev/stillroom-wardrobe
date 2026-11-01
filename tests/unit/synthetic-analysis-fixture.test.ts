import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  syntheticClaimSql, syntheticFinishSql, syntheticImageChangeSql, syntheticSaveSql,
} from '../integration/synthetic-analysis.sessions.mjs';

// The synthetic historical analysis fixtures (tests/integration/synthetic-analysis.sessions.mjs) write the success sequence of
// the historical functions after an Azure manifest's review date. This pins that sequence, statement for statement and in
// order, against every historical definition of each function the fixtures stand in for, and pins the documented real
// refusals the harness asserts before it uses a fixture. Whitespace and comments are ignored.
const compact = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, '');
const migration = async (name: string) => (await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
async function body(file: string | undefined, header: string | undefined) {
  if (file === undefined || header === undefined) throw new Error('fixture definition');
  const text = (await migration(file)).replaceAll('\r\n', '\n');
  const at = text.indexOf(header);
  expect(at, `${file}: ${header}`).toBeGreaterThanOrEqual(0);
  const start = text.indexOf('$$', at), end = text.indexOf('$$', start + 2);
  expect(start).toBeGreaterThan(at);
  return text.slice(start + 2, end);
}
function inOrder(haystack: string, statements: readonly string[]) {
  let from = 0;
  for (const statement of statements) {
    const at = haystack.indexOf(compact(statement), from);
    expect(at, statement).toBeGreaterThanOrEqual(from);
    from = at + 1;
  }
}

const CLAIM = [
  "v_result := private.ai_begin_owner(p.owner_id,p_request_id,p_draft_id,p_generation,p_image_sha256);",
  "v_deadline := least(v_now+interval '20 seconds',r.expires_at);",
  `insert into private.ai_usage_evidence(owner_id,request_id,manifest_id,model_observation,claim_identity)
    values(p.owner_id,p_request_id,m.id,'not_observed',jsonb_build_object('draftId',p_draft_id,'generation',p_generation,
      'imageSha256',p_image_sha256,'bytes',p_byte_count,'width',p_width,'height',p_height));`,
  `insert into private.ai_analysis_attestations values(p.owner_id,p_request_id,p_image_sha256,
    p_byte_count,p_width,p_height,m.id,v_now,v_deadline);`,
  "update private.ai_usage set dispatched_at=v_now,charge_state='held' where owner_id=p.owner_id and request_id=p_request_id;",
  "update private.ai_requests set status='dispatched' where owner_id=p.owner_id and request_id=p_request_id;",
];
const FINISH = [
  `update private.ai_usage_evidence set model_observation=v_model,control_observation=v_control
    where owner_id=p.owner_id and request_id=p_request_id;`,
  `v_estimate := ceil(((p_usage->>'input')::numeric*m.input_rate_hundredths
    +(p_usage->>'output')::numeric*m.output_rate_hundredths)/100)::bigint;`,
  "v_anomaly := (p_usage->>'input')::numeric>m.input_envelope or (p_usage->>'output')::numeric>m.output_envelope;",
  `update private.ai_usage_evidence set normalized_usage=p_usage,estimated_micro=v_estimate,anomaly=v_anomaly
    where owner_id=p.owner_id and request_id=p_request_id;`,
  `update private.ai_usage set accounted_micro=v_estimate,charge_state='estimated'
      where owner_id=p.owner_id and request_id=p_request_id returning * into u;`,
  "v_result := private.ai_settle_core(p_owner_id,p_request_id,p_facts,null,'SUCCESS');",
];
const SAVE = [
  `update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
        'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
        where owner_id=v_owner and request_id=u.request_id and claim_identity is null;`,
  "insert into private.ai_save_used_receipts values(v_owner,r.request_id,i.id,(p_image->>'id')::uuid);",
  `select coalesce(jsonb_object_agg(key,jsonb_build_object('kind',value->>'kind','revision',1)),'{}'::jsonb)
    into i.field_provenance from jsonb_each(i.field_provenance);`,
  "insert into private.ai_item_save_context values(v_owner,i.id,private.item_save_value_hash(i));",
  "select * into result from private.reserve_item_save(p_item,p_image,array['user','unknown','ai_observed','ai_estimated']);",
  "delete from private.ai_item_save_context where owner_id=v_owner and item_id=i.id;",
  `insert into private.ai_item_save_attempts values(v_owner,i.id,encode(sha256(convert_to(p_claim::text,'UTF8')),'hex'),
    m.id,m.model_id,m.prompt_version,proof.image_sha256,proof.byte_count,proof.width,proof.height,derived,false);`,
];
const IMAGE = [
  `update private.ai_usage_evidence set claim_identity=jsonb_build_object('draftId',r.draft_id,'generation',r.generation,
        'imageSha256',proof.image_sha256,'bytes',proof.byte_count,'width',proof.width,'height',proof.height)
        where owner_id=p_owner and request_id=u.request_id and claim_identity is null;`,
  "image := jsonb_populate_record(null::public.item_images,p_intent->'image');",
  `insert into public.item_images(id,owner_id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
    values(image.id,p_owner,target.id,image.main_bytes,image.thumb_bytes,image.main_sha256,image.thumb_sha256,image.width,image.height,image.alt_text)
    returning * into image;`,
  `insert into private.image_change_attempts(owner_id,request_id,item_id,image_id,kind,state,expected_version,current_image_id,
    description_version,fingerprint,item_hash,result_hash,source_image_id,source_objects,analysis_request_id,manifest_id,model_id,prompt_version,fields)
    values(p_owner,(p_intent->>'requestId')::uuid,target.id,image.id,case when recovery then 'recovery' else 'replacement' end,'reserved',
      old_item.version,(p_intent->>'currentImageId')::uuid,(p_intent->>'descriptionVersion')::integer,fingerprint,
      private.item_save_value_hash(old_item),private.item_save_value_hash(target),source.id,p_recovery_objects,u.request_id,
      m.id,m.model_id,m.prompt_version,derived) returning * into a;`,
];

const shape = { owner: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
  draftId: '22222222-2222-4222-8222-222222222222', generation: 1, hash: 'a'.repeat(64), bytes: 100, width: 120, height: 80,
  manifest: 'azure-eu-terra-devtest-v2' };
const facts = { outcome: 'ready', fields: {} };

describe('synthetic historical analysis fixtures stay equal to the historical success write sequences', () => {
  it('uses the expiry-established synthetic path only: every fixture checks the manifest date in SQL before it writes', () => {
    for (const sql of [syntheticClaimSql(shape), syntheticFinishSql({ ...shape, facts, usage: {} }),
      syntheticSaveSql({ owner: shape.owner, item: {}, image: {}, claim: {}, manifest: shape.manifest }),
      syntheticImageChangeSql({ owner: shape.owner, intent: {}, manifest: shape.manifest })]) {
      expect(sql).toContain('m.review_expires_at>clock_timestamp() then raise exception');
      expect(sql).toContain('SYNTHETIC_EXPIRY_NOT_ESTABLISHED');
      expect(sql).toContain('private.ai_permission(');
    }
  });

  it('copies the claim success sequence from every historical claim body and enforces real begin_owner OK/replayed:false', async () => {
    inOrder(compact(syntheticClaimSql(shape)), CLAIM);
    for (const [file, header] of [
      ['20260921193000_azure_terra_analysis.sql', 'create or replace function public.ai_claim_analysis'],
      ['20260924100100_azure_colour_manifest.sql', 'create or replace function public.ai_claim_analysis'],
      ['20261101080000_persistent_ai_availability.sql', 'create or replace function public.ai_claim_analysis'],
    ]) inOrder(compact(await body(file, header)), CLAIM);
    for (const [file, header] of [
      ['20260911040000_ai_analysis_backend.sql', 'create function private.ai_begin_owner'],
      ['20261010090000_shared_ai_budget.sql', 'create or replace function private.ai_begin_owner'],
    ]) {
      const text = compact(await body(file, header));
      expect(text).toContain(compact("return jsonb_build_object('code','OK','status','reserved','replayed',false);"));
      inOrder(text, ["insert into private.ai_usage(owner_id,request_id,period,created_at,reserved_micro,accounted_micro,charge_state)",
        "insert into private.ai_requests(owner_id,request_id,draft_id,generation,image_sha256,model_id,prompt_version,"]);
    }
  });

  it('pins the documented real refusals that must be seen before a synthetic claim: UNCONFIGURED after the date, ahead of the allowance', async () => {
    for (const [file, header] of [
      ['20260921193000_azure_terra_analysis.sql', 'create or replace function public.ai_claim_analysis'],
      ['20260924100100_azure_colour_manifest.sql', 'create or replace function public.ai_claim_analysis'],
    ]) {
      const text = compact(await body(file, header));
      inOrder(text, ["if not found or v_now>=m.review_expires_at or c.execution_manifest_id is null then",
        "return jsonb_build_object('code','UNCONFIGURED','claimed',false);",
        "if c.execution_manifest_id<>m.id or c.model_id<>m.model_id or c.prompt_version<>m.prompt_version or c.notice_revision<>2 then",
        "return jsonb_build_object('code','CONFIG_CHANGED','claimed',false);",
        "v_result := private.ai_begin_owner("]);
    }
  });

  it('copies the finish success sequence from every historical finish body; the real finish refuses after the date', async () => {
    inOrder(compact(syntheticFinishSql({ ...shape, facts, usage: {} })), FINISH);
    for (const [file, header] of [
      ['20260921193000_azure_terra_analysis.sql', 'create function public.ai_finish_analysis'],
      ['20260924100100_azure_colour_manifest.sql', 'create or replace function public.ai_finish_analysis'],
      ['20261008080000_analysis_model_identity.sql', 'create or replace function public.ai_finish_analysis'],
    ]) {
      const text = compact(await body(file, header));
      inOrder(text, FINISH);
      // The refusal the probe asserts: an unpermitted request is closed as UNAVAILABLE before facts are stored.
      inOrder(text, ["elsif not private.ai_analysis_permitted(p,c,r,v_now) then",
        "perform private.ai_close(p.owner_id,p_request_id,'UNAVAILABLE',v_now); v_reason := 'UNAVAILABLE';",
        "v_result := private.ai_settle_core("]);
    }
    const origin = await migration('20260921193000_azure_terra_analysis.sql');
    expect(compact(origin)).toContain(compact(
      'alter function public.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) set schema private;'
      + 'alter function private.ai_finish_analysis(uuid,uuid,text,jsonb,jsonb,text) rename to ai_finish_google_legacy;'));
    expect(compact(await migration('20260911040000_ai_analysis_backend.sql'))).toContain(
      compact('alter function private.ai_settle_request(uuid,uuid,jsonb,bigint,text) rename to ai_settle_core;'));
  });

  it('copies the Save success sequence, with the context install and removal, from the azure Save, its v10 rename and the current v10', async () => {
    inOrder(compact(syntheticSaveSql({ owner: shape.owner, item: {}, image: {}, claim: {}, manifest: shape.manifest })), SAVE);
    const azure = compact(await body('20260921193000_azure_terra_analysis.sql', 'create or replace function public.reserve_analyzed_item_save'));
    inOrder(azure, SAVE);
    // v10 is that same function renamed by the image-change migration behind a wrapper that writes nothing.
    const imageChanges = await migration('20260922020000_checked_image_changes.sql');
    expect(compact(imageChanges)).toContain(compact(
      'alter function public.reserve_analyzed_item_save(jsonb,jsonb,jsonb) set schema private;'
      + 'alter function private.reserve_analyzed_item_save(jsonb,jsonb,jsonb) rename to reserve_analyzed_item_save_v10;'));
    const wrapper = compact((await body('20260922020000_checked_image_changes.sql',
      'create function public.reserve_analyzed_item_save(p_item jsonb,p_image jsonb,p_claim jsonb)')));
    expect(wrapper).not.toMatch(/insertinto|update|deletefrom/);
    expect(wrapper).toContain('returnqueryselect*fromprivate.reserve_analyzed_item_save_v10(p_item,p_image,p_claim);');
    inOrder(compact(await body('20261101080000_persistent_ai_availability.sql',
      'create or replace function private.reserve_analyzed_item_save_v10')), SAVE);
    // The refusal the probe asserts after the date.
    inOrder(azure, ["v_refuse := r.expires_at<=clock_timestamp() or not private.ai_analysis_permitted(p,c,r,clock_timestamp())",
      "perform private.ai_close(v_owner,u.request_id,'UNAVAILABLE',clock_timestamp());", "'analysis_unavailable'::text;"]);
    // The context is what authorises AI provenance in the private reserve; the public reserve allows user provenance only.
    const colourSave = await migration('20260924100000_garment_colours.sql');
    expect(compact(colourSave)).toContain(compact('create or replace function private.reserve_item_save(p_item jsonb,p_image jsonb,p_kinds text[])'));
  });

  it('copies the analyzed replacement success sequence from the original and the current reserve_image_change', async () => {
    inOrder(compact(syntheticImageChangeSql({ owner: shape.owner, intent: {}, manifest: shape.manifest })), IMAGE);
    for (const [file, header] of [
      ['20260922020000_checked_image_changes.sql', 'create function private.reserve_image_change'],
      ['20261101080000_persistent_ai_availability.sql', 'create or replace function private.reserve_image_change'],
    ]) inOrder(compact(await body(file, header)), IMAGE);
  });
});

describe('synthetic substitutions are never silent', () => {
  const read = async (path: string) => (await readFile(new URL(path, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const functionText = (source: string, name: string) => {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf('\n}\n', start));
  };

  it('records and labels every synthetic path, and shows the real replacement refusal before a synthetic replacement write', async () => {
    const source = await read('../integration/synthetic-analysis.sessions.mjs');
    expect(source).toContain("export const SYNTHETIC_LABEL = 'SYNTHETIC historical fixture';");
    for (const [name, write, kind] of [
      ['analysisClaim', 'syntheticClaimSql(', 'analysis claim'], ['analysisFinishSuccess', 'syntheticFinishSql(', 'analysis finish'],
      ['analyzedSaveRow', 'syntheticSaveSql(', 'analyzed Save'],
      ['analyzedReplacementReceipt', 'syntheticImageChangeSql(', 'analyzed replacement reservation'],
      ['tagClaimStatement', 'private.ai_begin_owner(', 'tagging claim entry via real ai_begin_owner'],
    ] as const) {
      const text = functionText(source, name);
      expect(text, name).toContain(write);
      expect(text, name).toContain(`recordSynthetic('${kind}'`);
    }
    for (const name of ['analysisClaim', 'analysisFinishSuccess']) {
      expect(functionText(source, name), name).toContain('synthetic: true, label: SYNTHETIC_LABEL');
    }
    const replacement = functionText(source, 'analyzedReplacementReceipt');
    expect(replacement.indexOf('await expiredReplacementRefusalProbe(')).toBeGreaterThanOrEqual(0);
    expect(replacement.indexOf('await expiredReplacementRefusalProbe(')).toBeLessThan(replacement.indexOf('syntheticImageChangeSql('));
    const probe = functionText(source, 'expiredReplacementRefusalProbe');
    expect(probe).toContain('public.reserve_image_change(');
    expect(probe).toContain("state: 'analysis_unavailable'");
    expect(probe).toContain('rollback;');
    expect(source).toContain('SYNTHETIC_LABEL.toUpperCase()');
  });

  it('prints the substitution status after every stage that can use synthetic analysis evidence', async () => {
    const rehearsal = await read('../../scripts/preservation-rehearsal.mjs');
    for (const stage of ['I10b-ten-capture', 'I10b-preservation', 'COL1-A1-eleven-capture', 'COL1-A6-fifteen-probes', 'SAVE1-seed',
      'SAVE1-verify', 'P6d-attribution-roundtrip', 'ST1a-stylist-ledger', 'BG2b-enhancement-ledger', 'COL1-B-twelve-probes', 'AVAIL1-behaviour']) {
      expect(rehearsal, stage).toContain(`await syntheticNote('${stage}');`);
    }
  });
});