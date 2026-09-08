// Adapted from the supplied normal-session harness; this copy is local-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { assertLocalApi, validateSessionEnvironment, reportError, LocalBackendError, securityFailureExitCode } from '../../scripts/backend/local.mjs';

try { validateSessionEnvironment(process.env); } catch (error) { reportError(error); process.exit(2); }
const base=assertLocalApi(process.env.SUPABASE_URL);
const key=process.env.SUPABASE_PUBLISHABLE_KEY;
function claims(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());}catch{return {};}}
const passed=[];let stage='configuration';const cleanups=[],profileCleanups=[];
async function call(token,path,{method='GET',body,bytes=false,returnRepresentation=false}={}) {
  const r=await fetch(base+path,{method,headers:{apikey:key,...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':bytes?'image/jpeg':'application/json',...(returnRepresentation?{Prefer:'return=representation'}:{})},
    ...(body!==undefined?{body:bytes?body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)})
    .catch(()=>{throw new LocalBackendError('BLOCKED: local service transport unavailable.');});
  if(r.status>=500)throw new LocalBackendError('BLOCKED: local service returned a server error.');
  const raw=Buffer.from(await r.arrayBuffer().catch(()=>{throw new LocalBackendError('BLOCKED: local response unavailable.');}));let data;
  try{data=JSON.parse(raw.toString());}catch{data=raw;}
  return {ok:r.ok,status:r.status,data,headers:r.headers};
}
function noSession(result){
  assert.ok(result.data && typeof result.data==='object' && !Buffer.isBuffer(result.data));
  assert.ok(!result.data.access_token && !result.data.refresh_token && !result.data.session);
}
async function emailAdmission(){
  const email=`unapproved-${randomUUID()}@example.test`;
  stage='unapproved OTP create_user=true';
  let r=await call(null,'/auth/v1/otp',{method:'POST',body:{email,create_user:true}});
  stage=`unapproved OTP create_user=true (HTTP ${r.status})`;
  assert.equal(r.status,422);assert.equal(r.data.error_code,'signup_disabled');noSession(r);
  stage='unapproved OTP create_user=false';
  r=await call(null,'/auth/v1/otp',{method:'POST',body:{email,create_user:false}});
  stage=`unapproved OTP create_user=false (HTTP ${r.status})`;
  assert.equal(r.status,422);assert.equal(r.data.error_code,'otp_disabled');noSession(r);
  stage='unapproved recovery';
  r=await call(null,'/auth/v1/recover',{method:'POST',body:{email}});
  stage=`unapproved recovery (HTTP ${r.status})`;
  // Anti-enumeration success is neither admission nor proof that no Auth row exists.
  assert.equal(r.status,200);assert.deepEqual(r.data,{});noSession(r);
  for(const type of ['email','recovery']){
    stage=`unapproved invalid ${type} verification`;
    r=await call(null,'/auth/v1/verify',{method:'POST',body:{email,type,token:'000000'}});
    stage=`unapproved invalid ${type} verification (HTTP ${r.status})`;
    assert.equal(r.status,403);assert.equal(r.data.error_code,'otp_expired');noSession(r);
  }
}
async function login(email,password){
  const r=await call(null,'/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
  assert.ok(r.ok);assert.equal(claims(r.data.access_token).role,'authenticated');
  assert.equal(claims(r.data.access_token).sub,r.data.user.id);
  return {token:r.data.access_token,uid:r.data.user.id};
}
async function rpc(c,name,body){const r=await call(c.token,`/rest/v1/rpc/${name}`,{method:'POST',body});assert.ok(r.ok);return r.data;}
async function profile(c){
  const r=await call(c.token,`/rest/v1/profiles?owner_id=eq.${c.uid}&select=ui_language,timezone,currency,version`);
  assert.ok(r.ok);assert.equal(r.data.length,1);return r.data[0];
}
const jpg=await fs.readFile(new URL('./fixture.jpg',import.meta.url));
const sha=createHash('sha256').update(jpg).digest('hex');
async function fixture(c){
  const x={item:randomUUID(),second:randomUUID(),image:randomUUID(),outfit:randomUUID(),event:randomUUID()};
  x.paths=[`${c.uid}/${x.item}/${x.image}/main.jpg`,`${c.uid}/${x.item}/${x.image}/thumb.jpg`];
  cleanups.push({c,x});
  let r=await call(c.token,'/rest/v1/items',{method:'POST',body:[{id:x.item,owner_id:c.uid,title:'Test overshirt',category:'top',notes:'Fictional private fixture',purchase_price:75},{id:x.second,owner_id:c.uid,title:'Test trousers',category:'bottom',notes:'',purchase_price:null}]});assert.ok(r.ok);
  r=await call(c.token,'/rest/v1/item_images',{method:'POST',body:{id:x.image,owner_id:c.uid,item_id:x.item,main_bytes:jpg.length,thumb_bytes:jpg.length,main_sha256:sha,thumb_sha256:sha,width:2,height:2,alt_text:'Fictional green image'}});assert.ok(r.ok);
  for(const path of x.paths){r=await call(c.token,`/storage/v1/object/wardrobe/${path}`,{method:'POST',bytes:true,body:jpg});assert.ok(r.ok);}
  await rpc(c,'commit_image',{p_image_id:x.image});
  await rpc(c,'save_outfit',{p_id:x.outfit,p_title:'Test outfit',p_occasion:'everyday',p_notes:'',p_favourite:false,p_item_ids:[x.item,x.second],p_expected_version:null});
  await rpc(c,'save_wear_event',{p_id:x.event,p_local_date:'2026-01-01',p_timezone:'Europe/Helsinki',p_state:'worn',p_label:'Test look',p_outfit_id:x.outfit,p_item_ids:[x.item],p_expected_version:null});
  const pair=[x.item,x.second].sort();
  r=await call(c.token,'/rest/v1/combination_rules',{method:'POST',body:{owner_id:c.uid,item_low:pair[0],item_high:pair[1]}});assert.ok(r.ok);
  r=await call(c.token,'/rest/v1/suggestion_feedback',{method:'POST',body:{owner_id:c.uid,item_ids:pair,vote:-1}});assert.ok(r.ok);
  return x;
}
const tables=['profiles','style_preferences','items','item_images','outfits','outfit_items','wear_events','wear_event_items','combination_rules','suggestion_feedback'];
async function settingsIsolation(c,other){
  for(const [table,fields] of [
    ['profiles',{display_name:'Fictional settings security',timezone:'Europe/Stockholm',currency:'SEK',ui_language:'en'}],
    ['style_preferences',{preferred_colours:['green'],style_tags:['Oma 🌿'],excluded_categories:['footwear'],minimum_upper_coverage:2,minimum_lower_coverage:1,cold_sensitivity:-1,repeat_gap_days:14}],
  ]){
    const read=async(owner)=>{
      const r=await call(owner.token,`/rest/v1/${table}?owner_id=eq.${owner.uid}&select=*`);
      assert.ok(r.ok);assert.equal(r.data.length,1);return r.data[0];
    };
    const before=await read(c),sibling=await read(other);
    const patch=(actor,uid,version,body)=>call(actor?.token??null,`/rest/v1/${table}?owner_id=eq.${uid}&version=eq.${version}`,{method:'PATCH',body,returnRepresentation:true});
    try{
      stage='I06 owner identity immutability and server-controlled versions';
      const identity=await patch(c,c.uid,before.version,{owner_id:other.uid});
      assert.ok(!identity.ok);assert.deepEqual(await read(c),before);assert.deepEqual(await read(other),sibling);
      const saved=await patch(c,c.uid,before.version,{...fields,version:999999,created_at:'2000-01-01T00:00:00Z'});
      assert.ok(saved.ok);assert.equal(saved.data.length,1);
      assert.equal(saved.data[0].owner_id,c.uid);assert.equal(saved.data[0].version,before.version+1);
      assert.equal(saved.data[0].created_at,before.created_at);
      for(const [field,value] of Object.entries(fields))assert.deepEqual(saved.data[0][field],value);
      const stale=await patch(c,c.uid,before.version,fields);assert.ok(stale.ok);assert.deepEqual(stale.data,[]);
      stage='I06 foreign and anonymous field mutations leave both owners unchanged';
      const foreign=await patch(c,other.uid,sibling.version,fields);
      assert.ok(!foreign.ok||Array.isArray(foreign.data)&&foreign.data.length===0);
      const anonymous=await patch(null,c.uid,saved.data[0].version,fields);
      assert.ok(!anonymous.ok||Array.isArray(anonymous.data)&&anonymous.data.length===0);
      assert.deepEqual(await read(c),saved.data[0]);assert.deepEqual(await read(other),sibling);
    }finally{
      const current=await read(c);
      const restore=Object.fromEntries(Object.keys(fields).map(field=>[field,before[field]]));
      const restored=await patch(c,c.uid,current.version,restore);
      assert.ok(restored.ok);assert.equal(restored.data.length,1);
      assert.equal(restored.data[0].version,current.version+1);
      for(const field of Object.keys(fields))assert.deepEqual(restored.data[0][field],before[field]);
    }
  }
}
async function provenanceIsolation(c,own,other,foreign){
  const attempted=[];
  const read=async(actor,id)=>{
    const result=await call(actor.token,`/rest/v1/items?owner_id=eq.${actor.uid}&id=eq.${id}&select=*`);
    assert.ok(result.ok);return result.data;
  };
  const patch=(actor,row,body)=>call(actor?.token??null,`/rest/v1/items?owner_id=eq.${row.owner_id}&id=eq.${row.id}&version=eq.${row.version}`,{
    method:'PATCH',body,returnRepresentation:true,
  });
  const denied=result=>assert.ok(!result.ok||Array.isArray(result.data)&&result.data.length===0);
  try{
    stage='I29a normal owner can confirm its own retained title';
    let before=(await read(c,own.item))[0];
    const sibling=(await read(other,foreign.item))[0];
    assert.ok(before&&sibling);
    const revision=(before.field_provenance.title?.revision??0)+1;
    const saved=await patch(c,before,{field_provenance:{...before.field_provenance,title:{kind:'user',revision}}});
    assert.ok(saved.ok);assert.equal(saved.data.length,1);
    assert.equal(saved.data[0].version,before.version+1);
    assert.equal(saved.data[0].title,before.title);
    assert.deepEqual(saved.data[0].field_provenance.title,{kind:'user',revision});
    before=saved.data[0];
    stage='I29a foreign and anonymous provenance reads and CAS writes denied';
    for(const actor of [c,null]){
      const target=actor?sibling:before;
      const result=await call(actor?.token??null,`/rest/v1/items?owner_id=eq.${target.owner_id}&id=eq.${target.id}&select=field_provenance`);
      denied(result);
      denied(await patch(actor,target,{notes:'Must not write',field_provenance:{
        ...target.field_provenance,title:{kind:'user',revision:(target.field_provenance.title?.revision??0)+1},
      }}));
      assert.deepEqual(await read(c,own.item),[before]);
      assert.deepEqual(await read(other,foreign.item),[sibling]);
    }
    stage='I29a both AI assertion kinds denied on own INSERT and UPDATE';
    for(const kind of ['ai_observed','ai_estimated']){
      const update=await patch(c,before,{notes:'Must roll back',field_provenance:{
        ...before.field_provenance,title:{kind,revision:revision+1},
      }});
      assert.ok(!update.ok);assert.equal(update.data.code,'22023');assert.equal(update.data.message,'Invalid input');
      assert.deepEqual(await read(c,own.item),[before]);
      const id=randomUUID();attempted.push(id);
      const insert=await call(c.token,'/rest/v1/items',{method:'POST',body:{
        id,owner_id:c.uid,title:'Forbidden AI fixture',category:'top',field_provenance:{title:{kind,revision:1}},
      }});
      assert.ok(!insert.ok);assert.equal(insert.data.code,'22023');assert.equal(insert.data.message,'Invalid input');
      assert.deepEqual(await read(c,id),[]);
    }
    stage='I29a foreign-owner and anonymous manual provenance INSERT denied';
    for(const [actor,target] of [[c,other],[null,c]]){
      const id=randomUUID();attempted.push(id);
      const result=await call(actor?.token??null,'/rest/v1/items',{method:'POST',body:{
        id,owner_id:target.uid,title:'Forbidden owner fixture',category:'top',field_provenance:{title:{kind:'user',revision:1}},
      }});
      assert.ok(!result.ok);
      assert.deepEqual(await read(c,id),[]);assert.deepEqual(await read(other,id),[]);
    }
    assert.deepEqual(await read(c,own.item),[before]);
    assert.deepEqual(await read(other,foreign.item),[sibling]);
  }finally{
    for(const id of attempted)for(const actor of [c,other]){
      const result=await call(actor.token,`/rest/v1/items?owner_id=eq.${actor.uid}&id=eq.${id}`,{method:'DELETE'});
      assert.ok(result.ok);assert.deepEqual(await read(actor,id),[]);
    }
  }
}

try {
  stage='normal password sign-ins';const a=await login(process.env.TEST_A_EMAIL,process.env.TEST_A_PASSWORD),b=await login(process.env.TEST_B_EMAIL,process.env.TEST_B_PASSWORD);
  assert.notEqual(a.uid,b.uid);passed.push(stage);
  stage='no profile directory or admin API';
  for(const c of [a,b]){
    const profiles=await call(c.token,'/rest/v1/profiles?select=owner_id');
    assert.ok(profiles.ok);assert.deepEqual(profiles.data,[{owner_id:c.uid}]);
    const directory=await call(c.token,'/auth/v1/admin/users');
    assert.ok(!directory.ok && directory.status<500);
    const approvals=await call(c.token,'/rest/v1/approved_accounts?select=admission_no');
    assert.ok(!approvals.ok && approvals.status<500);
  }
  passed.push(stage);
  stage='own fixture creation';const af=await fixture(a),bf=await fixture(b);passed.push(stage);
  await provenanceIsolation(a,af,b,bf);await provenanceIsolation(b,bf,a,af);
  passed.push('I29a both directions: own manual provenance allowed; foreign/anonymous reads and writes and own AI INSERT/UPDATE denied; complete rows unchanged after denials');
  await settingsIsolation(a,b);await settingsIsolation(b,a);
  passed.push('I06 both directions: actual identity immutability, server version control, stale/foreign/anonymous field writes, unchanged sibling and fresh-version restoration');
  stage='independent Finnish and Swedish preferences';
  for(const [c,language] of [[a,'fi'],[b,'sv']]){
    const before=await profile(c);
    const saved=await call(c.token,`/rest/v1/profiles?owner_id=eq.${c.uid}&version=eq.${before.version}`,{method:'PATCH',body:{ui_language:language},returnRepresentation:true});
    assert.ok(saved.ok);assert.equal(saved.data.length,1);
    profileCleanups.push({c,previous:before.ui_language,assigned:language});c.language=language;
    const after=await profile(c);assert.equal(after.ui_language,language);
    assert.equal(after.timezone,before.timezone);assert.equal(after.currency,before.currency);assert.equal(Number(after.version),Number(before.version)+1);
    const invalid=await call(c.token,`/rest/v1/profiles?owner_id=eq.${c.uid}&version=eq.${after.version}`,{method:'PATCH',body:{ui_language:'de'}});
    assert.ok(!invalid.ok);assert.deepEqual(await profile(c),after);
  }
  passed.push(stage);
  for(const [c,own,other,f] of [[a,af,b,bf],[b,bf,a,af]]){
    stage='foreign language mutation isolation';
    const languageBefore=await profile(other);
    await call(c.token,`/rest/v1/profiles?owner_id=eq.${other.uid}`,{method:'PATCH',body:{ui_language:'en'}});
    assert.deepEqual(await profile(other),languageBefore);
    stage='private table read/mutation isolation';
    for(const t of tables){
      const before=await call(other.token,`/rest/v1/${t}?owner_id=eq.${other.uid}&select=*`);assert.ok(before.ok&&before.data.length>0);
      const r=await call(c.token,`/rest/v1/${t}?owner_id=eq.${other.uid}&select=owner_id`);
      assert.ok(!r.ok || Array.isArray(r.data)&&r.data.length===0);
      await call(c.token,`/rest/v1/${t}?owner_id=eq.${other.uid}`,{method:'PATCH',body:{owner_id:other.uid}});
      await call(c.token,`/rest/v1/${t}?owner_id=eq.${other.uid}`,{method:'DELETE'});
      const after=await call(other.token,`/rest/v1/${t}?owner_id=eq.${other.uid}&select=*`);assert.ok(after.ok);
      const stable=rows=>rows.map(row=>JSON.stringify(row)).sort();
      assert.deepEqual(stable(after.data),stable(before.data));
    }
    let r=await call(c.token,`/rest/v1/items?id=eq.${f.item}`,{method:'PATCH',body:{title:'Should never change'}});assert.ok(!r.ok || r.status===204 || Array.isArray(r.data)&&r.data.length===0);
    r=await call(c.token,`/rest/v1/items?id=eq.${f.item}`,{method:'DELETE'});assert.ok(!r.ok || r.status===204 || Array.isArray(r.data)&&r.data.length===0);
    r=await call(other.token,`/rest/v1/items?id=eq.${f.item}&select=title`);assert.equal(r.data[0].title,'Test overshirt');
    r=await call(c.token,'/rest/v1/items',{method:'POST',body:{id:randomUUID(),owner_id:other.uid,title:'Forged',category:'top'}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/outfit_items',{method:'POST',body:{owner_id:c.uid,outfit_id:own.outfit,item_id:f.item,position:2}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/suggestion_feedback',{method:'POST',body:{owner_id:c.uid,item_ids:[own.item,f.item],vote:-1}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/rpc/retire_image',{method:'POST',body:{p_image_id:f.image}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/rpc/commit_image',{method:'POST',body:{p_image_id:f.image}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/rpc/save_outfit',{method:'POST',body:{p_id:f.outfit,p_title:'Invalid foreign update',p_occasion:'everyday',p_notes:'',p_favourite:false,p_item_ids:[f.item],p_expected_version:1}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/rpc/save_wear_event',{method:'POST',body:{p_id:f.event,p_local_date:'2026-01-01',p_timezone:'Europe/Helsinki',p_state:'worn',p_label:'Invalid foreign update',p_outfit_id:null,p_item_ids:[f.item],p_expected_version:1}});assert.ok(!r.ok);
    r=await call(c.token,'/rest/v1/rpc/deletion_control',{method:'POST',body:{p_owner_id:other.uid,p_action:'begin',p_code:null}});assert.ok(!r.ok);
    stage='foreign Storage read/sign/list/upload/delete';
    r=await call(c.token,`/storage/v1/object/authenticated/wardrobe/${f.paths[0]}`);assert.ok(!r.ok);
    r=await call(c.token,`/storage/v1/object/public/wardrobe/${f.paths[0]}`);assert.ok(!r.ok);
    r=await call(c.token,`/storage/v1/object/sign/wardrobe/${f.paths[0]}`,{method:'POST',body:{expiresIn:86400}});assert.ok(!r.ok);
    r=await call(c.token,'/storage/v1/object/list/wardrobe',{method:'POST',body:{prefix:other.uid,limit:100,offset:0}});assert.ok(!r.ok || Array.isArray(r.data)&&r.data.length===0);
    r=await call(c.token,`/storage/v1/object/wardrobe/${other.uid}/${f.item}/${randomUUID()}/main.jpg`,{method:'POST',bytes:true,body:jpg});assert.ok(!r.ok);
    await call(c.token,'/storage/v1/object/wardrobe',{method:'DELETE',body:{prefixes:[f.paths[0]]}});
    r=await call(other.token,`/storage/v1/object/authenticated/wardrobe/${f.paths[0]}`);assert.ok(r.ok);assert.equal(createHash('sha256').update(r.data).digest('hex'),sha);
    stage='owner-only manifest';const manifest=await rpc(c,'export_manifest',{p_export_id:randomUUID()});assert.equal(manifest.owner_id,c.uid);
    for(const rows of Object.values(manifest.tables))assert.ok(rows.every(row=>row.owner_id===c.uid));
    assert.equal(manifest.tables.profiles.length,1);assert.equal(manifest.tables.profiles[0].ui_language,c.language);
  }
  passed.push('Both directions: foreign language changes have no effect; each export retains its own preference','Both directions: private reads/mutations/FKs/privileged RPC denied; owner data unchanged','Both directions: foreign Storage download/sign/list/upload/delete denied; owner image bytes unchanged','Both owner exports contain only their own rows');
  stage='anonymous access';for(const t of tables){const r=await call(null,`/rest/v1/${t}?select=owner_id`);assert.ok(!r.ok || Array.isArray(r.data)&&r.data.length===0);}
  let r=await call(null,'/rest/v1/rpc/export_manifest',{method:'POST',body:{p_export_id:randomUUID()}});assert.ok(!r.ok);
  r=await call(null,'/auth/v1/signup',{method:'POST',body:{email:`unapproved-${randomUUID()}@example.test`,password:randomUUID()+randomUUID()}});assert.ok(!r.ok);
  r=await call(null,'/auth/v1/signup',{method:'POST',body:{}});assert.ok(!r.ok && r.status<500);
  for(const [c,f] of [[a,af],[b,bf]]){
    r=await call(null,`/storage/v1/object/authenticated/wardrobe/${f.paths[0]}`);assert.ok(!r.ok);
    r=await call(null,`/storage/v1/object/public/wardrobe/${f.paths[0]}`);assert.ok(!r.ok);
    r=await call(null,`/storage/v1/object/sign/wardrobe/${f.paths[0]}`,{method:'POST',body:{expiresIn:60}});assert.ok(!r.ok);
    r=await call(null,'/storage/v1/object/list/wardrobe',{method:'POST',body:{prefix:c.uid,limit:100,offset:0}});assert.ok(!r.ok || Array.isArray(r.data)&&r.data.length===0);
    await call(null,'/storage/v1/object/wardrobe',{method:'DELETE',body:{prefixes:f.paths}});
    r=await call(c.token,`/storage/v1/object/authenticated/wardrobe/${f.paths[0]}`);assert.ok(r.ok);assert.equal(createHash('sha256').update(r.data).digest('hex'),sha);
  }
  passed.push('Anonymous tables/export/Storage, public signup and anonymous signup denied');
  stage='unapproved email OTP creation/no-create, recovery and invalid verification';
  await emailAdmission();
  passed.push('Unapproved OTP creation 422/signup_disabled; no-create 422/otp_disabled; recovery 200 without session; invalid email/recovery verification 403/otp_expired');
  stage='approved password access remains intact after email admission checks';
  for(const [label,owner] of [['A',a],['B',b]]){
    const current=await login(process.env[`TEST_${label}_EMAIL`],process.env[`TEST_${label}_PASSWORD`]);
    assert.equal(current.uid,owner.uid);assert.deepEqual(await profile(current),await profile(owner));
  }
  passed.push(stage);
} catch(error) {
  process.exitCode=securityFailureExitCode(process.exitCode,error);
  console.error(`${process.exitCode===2?'BLOCKED':'FAIL'} at ${stage}. Details intentionally omit credentials and response content.`);
} finally {
  for(const {c,x} of cleanups){
    try{
      const r=await call(c.token,'/storage/v1/object/wardrobe',{method:'DELETE',body:{prefixes:x.paths}});assert.ok(r.ok);
      for(const [table,id] of [['wear_events',x.event],['outfits',x.outfit],['items',x.item],['items',x.second]]){
        const d=await call(c.token,`/rest/v1/${table}?id=eq.${id}`,{method:'DELETE'});assert.ok(d.ok);
      }
    }catch(error){console.error('Fixture cleanup incomplete; rerun owner-scoped cleanup in the disposable test project.');process.exitCode=securityFailureExitCode(process.exitCode,error);}
  }
  for(const {c,previous,assigned} of profileCleanups){
    try{
      const current=await profile(c);assert.equal(current.ui_language,assigned);
      const restored=await call(c.token,`/rest/v1/profiles?owner_id=eq.${c.uid}&version=eq.${current.version}`,{method:'PATCH',body:{ui_language:previous},returnRepresentation:true});
      assert.ok(restored.ok);assert.equal(restored.data.length,1);assert.equal(restored.data[0].ui_language,previous);
    }catch(error){console.error('Test language preference cleanup incomplete; review the disposable owner profile.');process.exitCode=securityFailureExitCode(process.exitCode,error);}
  }
}
console.log(JSON.stringify({tests:passed,result:process.exitCode===2?'BLOCKED':process.exitCode?'FAIL':'PASS',credentials:'normal password sessions only; no service key'},null,2));
