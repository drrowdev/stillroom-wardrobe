// Reference owner-only encrypted export; no application is built by this helper.
// Node >=22. Environment: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, WARDROBE_EMAIL,
// WARDROBE_PASSWORD, BACKUP_PASSPHRASE. Pass --output PATH. Prefer an OS secret-store wrapper.
// Never place environment values literally in command history. Output is always encrypted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,createHash,webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const b64=(bytes)=>Buffer.from(bytes).toString('base64');
export async function encryptPart(part,passphrase){
  const salt=randomBytes(16),iv=randomBytes(12),iterations=600000;
  const aad=`stillroom:1:${part.exportId}:${part.partIndex}:${part.partCount}`;
  const material=await webcrypto.subtle.importKey('raw',Buffer.from(passphrase),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt']);
  const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:Buffer.from(aad),tagLength:128},key,Buffer.from(canonical(part)));
  return {format:'stillroom-encrypted',version:1,kdf:'PBKDF2-SHA256',iterations,salt:b64(salt),iv:b64(iv),aad,ciphertext:b64(ciphertext)};
}
export async function decryptPart(envelope,passphrase){
  if(envelope.format!=='stillroom-encrypted'||envelope.version!==1||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==600000)throw new Error('Unsupported envelope');
  const salt=Buffer.from(envelope.salt,'base64'),iv=Buffer.from(envelope.iv,'base64');
  if(salt.length!==16||iv.length!==12||typeof envelope.aad!=='string')throw new Error('Invalid envelope');
  const material=await webcrypto.subtle.importKey('raw',Buffer.from(passphrase),'PBKDF2',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:600000},material,{name:'AES-GCM',length:256},false,['decrypt']);
  const bytes=await webcrypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:Buffer.from(envelope.aad),tagLength:128},key,Buffer.from(envelope.ciphertext,'base64'));
  const part=JSON.parse(Buffer.from(bytes).toString());
  if(envelope.aad!==`stillroom:1:${part.exportId}:${part.partIndex}:${part.partCount}`)throw new Error('Envelope identity mismatch');
  return part;
}
function rowKey(table,r){
  if(r.id)return r.id;
  if(table==='outfit_items')return `${r.outfit_id}|${r.item_id}`;
  return r.owner_id;
}
async function main(){
  for(const key of ['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','WARDROBE_EMAIL','WARDROBE_PASSWORD','BACKUP_PASSPHRASE'])if(!process.env[key])throw new Error('Required private configuration missing');
  if(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY)throw new Error('Normal-owner export refuses administrator secrets');
  if(process.env.BACKUP_PASSPHRASE.length<16)throw new Error('Choose a password-manager passphrase of at least 16 characters');
  const index=process.argv.indexOf('--output');if(index<0||!process.argv[index+1])throw new Error('Supply --output PATH');
  const output=path.resolve(process.argv[index+1]),base=process.env.SUPABASE_URL.replace(/\/$/,''),apiKey=process.env.SUPABASE_PUBLISHABLE_KEY;
  const endpoint=new URL(base);
  if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)))throw new Error('HTTPS required outside local development');
  let keyRole;try{keyRole=JSON.parse(Buffer.from(apiKey.split('.')[1],'base64url').toString()).role;}catch{}
  if(apiKey.startsWith('sb_secret_')||keyRole==='service_role')throw new Error('Publishable key required');
  let token;
  async function request(route,body){
    const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{apikey:apiKey,...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new Error('Export incomplete: authenticated provider request failed');
    return r;
  }
  const login=await (await request('/auth/v1/token?grant_type=password',{email:process.env.WARDROBE_EMAIL,password:process.env.WARDROBE_PASSWORD})).json();token=login.access_token;
  const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());
  if(claims.role!=='authenticated'||claims.sub!==login.user.id)throw new Error('Normal user session required');
  const exportId=randomUUID(),manifest=await(await request('/rest/v1/rpc/export_manifest',{p_export_id:exportId})).json();
  if(!manifest||manifest.owner_id!==login.user.id)throw new Error('Owner manifest mismatch');
  for(const [table,rows] of Object.entries(manifest.tables)){
    if(!rows.every(row=>row.owner_id===login.user.id))throw new Error('Foreign owner in export');
    rows.sort((a,b)=>rowKey(table,a).localeCompare(rowKey(table,b),'en'));
  }
  const manifestText=canonical(manifest);if(Buffer.byteLength(manifestText)>8*1024*1024)throw new Error('V1 metadata size limit exceeded');
  const manifestSha256=sha256(manifestText);
  const images=manifest.tables.item_images;if(images.some(i=>i.state==='pending'))throw new Error('Finish or cancel pending uploads before a full backup');
  const batches=[[]];let size=0;
  for(const im of images)for(const variant of ['main','thumb']){
    const length=im[variant+'_bytes'];if(size+length>12*1024*1024){batches.push([]);size=0;}
    batches.at(-1).push({im,variant});size+=length;
  }
  const folder=path.join(output,exportId);await fs.mkdir(folder,{recursive:true,mode:0o700});
  for(let n=0;n<batches.length;n++){
    const files=[];
    for(const {im,variant} of batches[n]){
      const key=im[variant+'_path'];const expected=`${login.user.id}/${im.item_id}/${im.id}/${variant}.jpg`;
      if(key!==expected)throw new Error('Unexpected object path');
      const bytes=Buffer.from(await(await request('/storage/v1/object/authenticated/wardrobe/'+key)).arrayBuffer());
      if(bytes.length!==im[variant+'_bytes']||sha256(bytes)!==im[variant+'_sha256'])throw new Error('Export incomplete: image checksum/size mismatch');
      files.push({imageId:im.id,variant,sha256:sha256(bytes),byteLength:bytes.length,mime:'image/jpeg',base64:b64(bytes)});
    }
    const part={format:'stillroom-export',schemaVersion:1,exportId,partIndex:n,partCount:batches.length,manifestSha256,...(n===0?{manifest}:{}),files};
    const envelope=await encryptPart(part,process.env.BACKUP_PASSPHRASE);
    await fs.writeFile(path.join(folder,`stillroom-${exportId}-${n}.json.enc`),JSON.stringify(envelope),{mode:0o600,flag:'wx'});
  }
  await fs.writeFile(path.join(folder,'COMPLETE.json'),JSON.stringify({exportId,partCount:batches.length,manifestSha256,images:images.length}),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'complete',parts:batches.length,images:images.length,manifestSha256}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{await main();}catch{console.error('Export failed or incomplete. No successful backup is claimed. Check private configuration and run verify-backup before relying on files.');process.exitCode=1;}
}
