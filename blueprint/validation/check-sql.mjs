// PostgreSQL policy execution with simulated JWT identity claims, NOT live Supabase Auth.
// Install @electric-sql/pglite as a validation-only dependency; then run this file.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const migration=await fs.readFile(new URL('../07-DATABASE-AND-RLS.sql',import.meta.url),'utf8');
const languageUpgrade=await fs.readFile(new URL('../reference-scripts/20260905000001_languages.sql',import.meta.url),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex');
const report={executedOn:new Date().toISOString().slice(0,10),engine:'PGlite PostgreSQL',authentication:'authenticated role; simulated JWT identity claims',migrationSha256:hash(migration),languageUpgradeSha256:hash(languageUpgrade),checks:[]};
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const ids=(letter)=>Array.from({length:8},(_,i)=>`${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${String(i+1).padStart(12,'0')}`);
const aa=ids('a'),bb=ids('b');
const check=(name)=>report.checks.push({name,result:'PASS'});
async function as(uid,fn){
 await db.exec(`set role ${uid?'authenticated':'anon'}`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid||'']);
 try{return await fn();}finally{await db.exec('reset role');}
}
async function denied(sql,args=[]){let blocked=false;try{await db.query(sql,args);}catch{blocked=true;}assert.ok(blocked,'Operation should be denied');}
await db.exec(`
 create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 create schema auth; create schema storage;
 create table auth.users(id uuid primary key,email text not null);
 create function auth.uid() returns uuid language sql stable as
 $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,storage,public to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,owner_id text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant select,insert,update,delete on storage.objects to authenticated;
`);
await db.exec(migration);
check('Complete migration executes on PostgreSQL with minimal Supabase schema stubs');
await db.exec("insert into private.approved_accounts(admission_no,email) values (1,'user-a@example.test'),(2,'user-b@example.test')");
await db.query('insert into auth.users values ($1,$2),($3,$4)',[A,'user-a@example.test',B,'user-b@example.test']);
await denied("insert into auth.users values ('33333333-3333-4333-8333-333333333333','third@example.test')");
check('Two independent approvals admit their accounts; an unapproved third account is rejected');
// Simulate the previous schema's missing column on fictional rows only, then
// execute the supplied additive upgrade. No real project or data is changed.
const beforeLanguageUpgrade=(await db.query('select owner_id,display_name,timezone,currency,version from public.profiles order by owner_id')).rows;
await db.exec('alter table public.profiles drop column ui_language');
await db.exec(languageUpgrade);
assert.deepEqual((await db.query('select owner_id,display_name,timezone,currency,version from public.profiles order by owner_id')).rows,beforeLanguageUpgrade);
assert.ok((await db.query('select ui_language from public.profiles')).rows.every(p=>p.ui_language===null));
check('Additive language upgrade preserves existing profile values and leaves each preference independently unset');
for(const [uid,other,language] of [[A,B,'fi'],[B,A,'sv']])await as(uid,async()=>{
 const old=(await db.query('select * from public.profiles')).rows[0];
 await db.query('update public.profiles set ui_language=$1 where owner_id=$2',[language,uid]);
 await denied("update public.profiles set ui_language='de' where owner_id=$1",[uid]);
 assert.equal((await db.query("update public.profiles set ui_language='en' where owner_id=$1 returning *",[other])).rows.length,0);
 const changed=(await db.query('select * from public.profiles')).rows[0];
 assert.equal(changed.ui_language,language);assert.equal(changed.currency,old.currency);assert.equal(changed.timezone,old.timezone);
 const manifest=(await db.query('select public.export_manifest($1)',[aa[7]])).rows[0].export_manifest;
 assert.equal(manifest.tables.profiles[0].ui_language,language);
});
await as(A,async()=>assert.equal((await db.query('select ui_language from public.profiles')).rows[0].ui_language,'fi'));
check('Finnish/Swedish preferences remain owner-only, reject unsupported codes, preserve timezone/currency and export correctly');
async function seed(uid,x){await as(uid,async()=>{
 await db.query("insert into public.items(id,title,category,notes,purchase_price) values ($1,'Olive overshirt','top','Owner secret',75),($2,'Blue trousers','bottom','',null)",[x[0],x[1]]);
 await db.query(`insert into public.item_images(id,item_id,main_bytes,thumb_bytes,main_sha256,thumb_sha256,width,height,alt_text)
 values($1,$2,123,23,$3,$3,1200,1600,'Olive cotton overshirt')`,[x[2],x[0],'a'.repeat(64)]);
 const root=`${uid}/${x[0]}/${x[2]}`;
 await db.query("insert into storage.objects(bucket_id,name,owner_id) values ('wardrobe',$1,$3),('wardrobe',$2,$3)",[`${root}/main.jpg`,`${root}/thumb.jpg`,uid]);
 await db.query('select public.commit_image($1)',[x[2]]);
 await db.query('select public.save_outfit($1,$2,$3,$4,$5,$6,null)',[x[3],'Everyday','everyday','',false,[x[0],x[1]]]);
 await db.query('select public.save_wear_event($1,$2,$3,$4,$5,$6,$7,null)',[x[4],'2026-01-01','Europe/Helsinki','worn','Daily outfit',x[3],[x[0],x[1]]]);
 await db.query('insert into public.combination_rules(item_low,item_high) values($1,$2)',[x[0],x[1]]);
 await db.query('insert into public.suggestion_feedback(item_ids,vote) values($1,1)',[[x[0],x[1]]]);
});}
await seed(A,aa);await seed(B,bb);
check('Owner operations create images, outfits, wear history and feedback with real constraints');
const tables=['profiles','style_preferences','items','item_images','outfits','outfit_items','wear_events','wear_event_items','combination_rules','suggestion_feedback'];
for(const uid of [A,B])await as(uid,async()=>{
 const other=uid===A?B:A;
 for(const table of tables){
  assert.equal((await db.query(`select * from public.${table} where owner_id=$1`,[other])).rows.length,0);
  assert.equal((await db.query(`update public.${table} set owner_id=owner_id where owner_id=$1 returning *`,[other]).catch(()=>({rows:[]}))).rows.length,0);
  assert.equal((await db.query(`delete from public.${table} where owner_id=$1 returning *`,[other]).catch(()=>({rows:[]}))).rows.length,0);
 }
 assert.equal((await db.query('select * from public.items')).rows.length,2);
});
check('A/B cannot read, change or delete each other across all ten private public tables; own records remain');
for(const [uid,own,foreign,other] of [[A,aa,bb,B],[B,bb,aa,A]])await as(uid,async()=>{
 await denied("insert into public.items(owner_id,title,category) values($1,'Forged','top')",[other]);
 await denied('insert into public.outfit_items(outfit_id,item_id,position) values($1,$2,2)',[own[3],foreign[0]]);
 await denied('select public.save_outfit($1,$2,$3,$4,false,$5,1)',[foreign[3],'Tampered','everyday','',[own[0]]]);
 await denied('select public.commit_image($1)',[foreign[2]]);
 await denied('select public.retire_image($1)',[foreign[2]]);
 await denied('insert into public.suggestion_feedback(item_ids,vote) values($1,-1)',[[own[0],foreign[1]]]);
 await denied('select public.restore_history_entry($1,$2,null,$3,$4,$5)',[own[5],foreign[4],'Old item','top',own[6]]);
 await denied("select public.deletion_control($1,'begin',null)",[other]);
 await denied('select * from private.approved_accounts');
 const path=`${other}/${foreign[0]}/${foreign[2]}/main.jpg`;
 assert.equal((await db.query('select * from storage.objects where name=$1',[path])).rows.length,0);
 assert.equal((await db.query('delete from storage.objects where name=$1 returning *',[path])).rows.length,0);
 await denied("insert into storage.objects(bucket_id,name) values('wardrobe',$1)",[`${other}/${foreign[0]}/${foreign[2]}/fake.jpg`]);
 const exp=(await db.query('select public.export_manifest($1)',[own[7]])).rows[0].export_manifest;
 assert.equal(exp.owner_id,uid);for(const rows of Object.values(exp.tables))assert.ok(rows.every(r=>r.owner_id===uid));
});
check('Forged ownership, foreign FKs/RPCs/images/admission access and service-only deletion are denied in both directions');
check('Consistent export snapshots contain only the authenticated owner across every exported table');
await as(A,async()=>{
 const original=(await db.query('select * from public.outfits where id=$1',[aa[3]])).rows[0];
 await denied('select public.save_outfit($1,$2,$3,$4,false,$5,99)',[aa[3],'Conflict','everyday','',[aa[0]]]);
 assert.equal((await db.query('select * from public.outfits where id=$1',[aa[3]])).rows[0].title,original.title);
 assert.equal((await db.query('select public.save_outfit($1,$2,$3,$4,false,$5,null)',[aa[3],'Everyday','everyday','',[aa[0],aa[1]]])).rows[0].save_outfit,1);
 await db.query('select public.restore_history_entry($1,$2,null,$3,$4,$5)',[aa[5],aa[4],'Retired historical garment','top',aa[6]]);
 await denied('insert into public.wear_event_items(event_id,item_id,import_id,title_snapshot,category_snapshot) values($1,null,$2,$3,$4)',[aa[4],aa[6],'Bypass','top']);
 await denied("update public.item_images set state='pending' where id=$1",[aa[2]]);
 assert.equal((await db.query("update storage.objects set metadata='{}' where name=$1 returning *",[`${A}/${aa[0]}/${aa[2]}/main.jpg`])).rows.length,0);
 await denied("update public.profiles set timezone='invalid/timezone'");
 await denied("insert into public.wear_events(local_date,state) values('2199-01-01','worn')");
});
check('Atomic writes reject stale versions; identical retry succeeds; restored history uses a restricted import path');
check('Image-state edits/overwrites, invalid timezone and future worn events are rejected');
await db.query("update public.item_images set created_at=now()-interval '1 year' where id=$1",[aa[2]]);
await as(A,async()=>{
 const hash=(await db.query("select encode(sha256(convert_to($1,'UTF8')),'hex') as value",[[aa[0],aa[1]].sort().join('|')])).rows[0].value;
 assert.equal((await db.query('select signature from public.suggestion_feedback')).rows[0].signature,hash);
 await db.query('select public.retire_image($1)',[aa[2]]);
 const retired=(await db.query('select * from public.item_images where id=$1',[aa[2]])).rows[0];
 assert.equal(retired.state,'retired');assert.ok(new Date(retired.retired_at)>new Date(retired.created_at));
 await db.query('select public.retire_image($1)',[aa[2]]);
 assert.deepEqual((await db.query('select retired_at from public.item_images where id=$1',[aa[2]])).rows[0].retired_at,retired.retired_at);
 await denied('select public.commit_image($1)',[aa[2]]);
});
check('Feedback signatures are derived from owned item IDs; retired photo recovery starts at retirement and retries do not reset it');
await as(A,async()=>{
 const entry=(await db.query('select * from public.wear_event_items where item_id=$1',[aa[1]])).rows[0];
 await db.query('delete from public.items where id=$1',[aa[1]]);
 const historical=(await db.query('select * from public.wear_event_items where id=$1',[entry.id])).rows[0];
 assert.equal(historical.item_id,null);assert.equal(historical.title_snapshot,entry.title_snapshot);
 assert.equal((await db.query('select * from public.outfit_items where item_id=$1',[aa[1]])).rows.length,0);
 assert.equal((await db.query('select * from public.suggestion_feedback')).rows.length,0);
});
check('Permanent item deletion preserves owner history text with a null item link and removes current outfit references');
await as(null,async()=>{for(const t of tables)await denied(`select * from public.${t}`);await denied('select public.export_manifest($1)',[aa[7]]);});
check('Anonymous role cannot read any private table or export RPC');
const userTables=(await db.query("select n.nspname,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in('public','private')")).rows;
assert.equal(userTables.length,12);assert.ok(userTables.every(r=>r.relrowsecurity));
check('All twelve application tables have RLS enabled');
const forbidden=(await db.query("select table_name,column_name from information_schema.columns where table_schema in('public','private') and column_name in('recipient_id','household_id','peer_id','partner_id')")).rows;
assert.equal(forbidden.length,0);
assert.equal((await db.query("select to_regprocedure('public.my_peer()') as value")).rows[0].value,null);
assert.ok(!userTables.some(t=>/share|household|partner|relationship/.test(t.relname)));
check('No relationship tables, recipient/household/peer columns or peer-discovery RPC exist');
await db.query('update private.approved_accounts set enabled=false where user_id=$1',[A]);
await as(A,async()=>{assert.equal((await db.query('select * from public.items')).rows.length,0);assert.equal((await db.query('select * from storage.objects')).rows.length,0);});
await as(B,async()=>assert.equal((await db.query('select * from public.items')).rows.length,2));
check('Disabling A blocks its old user context immediately and leaves B unaffected');
const bBefore={};
for(const t of tables)bBefore[t]=(await db.query(`select * from public.${t} t where owner_id=$1 order by to_jsonb(t)::text`,[B])).rows;
await db.exec('set role service_role');
await db.query("select public.deletion_control($1,'begin',null)",[A]);
await denied("select public.deletion_control($1,'storage_removed',null)",[A]);
await db.exec('reset role');
// Stub metadata deletion below is only a PostgreSQL stage test. Real byte deletion
// must use the Storage API, never DELETE FROM storage.objects in production.
await db.query("delete from storage.objects where split_part(name,'/',1)=$1",[A]);
await db.exec('set role service_role');
await db.query("select public.deletion_control($1,'storage_removed',null)",[A]);
await denied("select public.deletion_control($1,'auth_removed',null)",[A]);
await db.exec('reset role');
await db.query('delete from auth.users where id=$1',[A]);
await db.exec('set role service_role');
await db.query("select public.deletion_control($1,'auth_removed',null)",[A]);
assert.equal((await db.query("select public.deletion_control($1,'begin',null) as job",[A])).rows[0].job.stage,'complete');
await db.exec('reset role');
for(const t of tables){
 assert.equal((await db.query(`select * from public.${t} where owner_id=$1`,[A])).rows.length,0);
 assert.deepEqual((await db.query(`select * from public.${t} t where owner_id=$1 order by to_jsonb(t)::text`,[B])).rows,bBefore[t]);
}
assert.equal((await db.query('select stage from private.deletion_jobs where owner_id=$1',[A])).rows[0].stage,'complete');
await as(B,async()=>{assert.equal((await db.query('select * from public.items')).rows.length,2);assert.equal((await db.query('select * from storage.objects')).rows.length,2);});
check('Deletion controller enforces file-before-row-before-Auth stages, removes only A and safely retries completion (Storage metadata stub only)');
report.checks.push({name:'Live Supabase Auth/REST/Storage and implemented browser/deletion function',result:'NOT RUN',reason:'No configured Supabase project or normal test credentials supplied. Run security-sessions.mjs in Phase 0 and later feature gates.'});
await db.close();console.log(JSON.stringify(report,null,2));
