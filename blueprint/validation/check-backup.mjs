// Local golden-format/crypto checks. No network, real credentials or personal data.
import assert from 'node:assert/strict';
import {canonical,sha256,encryptPart,decryptPart} from '../reference-scripts/export-own.mjs';
const passphrase='synthetic test passphrase only';
const part={format:'stillroom-export',schemaVersion:1,exportId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',partIndex:0,partCount:2,manifestSha256:'a'.repeat(64),manifest:{owner_id:'11111111-1111-4111-8111-111111111111',tables:{items:[]}},files:[]};
assert.equal(canonical({z:1,a:{c:3,b:2}}),'{"a":{"b":2,"c":3},"z":1}');
assert.equal(sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
const envelope=await encryptPart(part,passphrase);
assert.deepEqual(await decryptPart(envelope,passphrase),part);
assert.equal(Buffer.from(envelope.salt,'base64').length,16);
assert.equal(Buffer.from(envelope.iv,'base64').length,12);
assert.equal(envelope.iterations,600000);
await assert.rejects(decryptPart(envelope,'different synthetic passphrase'));
const changed=Buffer.from(envelope.ciphertext,'base64');changed[7]^=1;
await assert.rejects(decryptPart({...envelope,ciphertext:changed.toString('base64')},passphrase));
await assert.rejects(decryptPart({...envelope,aad:envelope.aad.replace(':0:',':1:')},passphrase));
await assert.rejects(decryptPart({...envelope,iterations:1},passphrase));
const {manifest,...rest}=part;
const secondPart={...rest,partIndex:1};
const secondEnvelope=await encryptPart(secondPart,passphrase);
assert.notEqual(secondEnvelope.iv,envelope.iv);assert.notEqual(secondEnvelope.salt,envelope.salt);
assert.deepEqual(await decryptPart(secondEnvelope,passphrase),secondPart);
console.log(JSON.stringify({runtime:process.version,scope:'Reference encryption/serialization only; live export and restore not run',goldenCanonicalSha256:sha256(canonical(part)),checks:[
 'Canonical object ordering and known SHA-256 vector','AES-GCM round trip and specified KDF parameters','Wrong passphrase rejected','Ciphertext tampering rejected','Part identity tampering rejected','Unsupported KDF rejected','Independent parts use distinct salt/IV and round trip'
].map(name=>({name,result:'PASS'}))},null,2));
