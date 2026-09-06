// Catalog/helper checks only. Real browser UI and native-speaker review remain release gates.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {languages,locales,resolveLanguage,translate,translateCount,formatMoney,parsePrice,formatDateOnly,searchText} from '../reference-scripts/i18n.mjs';
const catalog=JSON.parse(await fs.readFile(new URL('../reference-scripts/locales.json',import.meta.url),'utf8'));
const checks=[];
const pass=name=>checks.push({name,result:'PASS'});
const params=text=>[...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(m=>m[1]))].sort();
for(const [key,row] of Object.entries(catalog)){
  assert.deepEqual(Object.keys(row).sort(),[...languages].sort(),key);
  for(const lang of languages){
    assert.equal(typeof row[lang],'string',key);assert.ok(row[lang].trim(),key);
    assert.ok(!/[<>]|\ufffd/.test(row[lang]),key);
    assert.deepEqual(params(row[lang]),params(row.en),key);
    const resolved=translate(catalog,lang,key,Object.fromEntries(params(row.en).map(p=>[p,'1'])));
    assert.ok(!/\{[A-Za-z]/.test(resolved),key);
  }
  if(key.endsWith('_one'))assert.ok(catalog[key.replace(/_one$/,'_other')],key);
  if(key.endsWith('_other'))assert.ok(catalog[key.replace(/_other$/,'_one')],key);
}
pass('Every catalog key has nonempty EN/FI/SV values, matching parameters and valid plural pairs');
for(const family of ['nav','auth','profile','item','photo','outfits','calendar','stats','suggestion','weather','backup','deletion','error','a11y','install']){
  assert.ok(Object.keys(catalog).some(key=>key.startsWith(family+'.')),family);
}
pass('Critical navigation, form, privacy, recovery and accessibility message families are present');
assert.equal(resolveLanguage(['fr-FR','sv-SE','fi-FI']),'sv');
assert.equal(resolveLanguage(['FI-fi']),'fi');
assert.equal(resolveLanguage(['de-DE']),'en');
assert.equal(resolveLanguage(['fi-FI'],'sv','en'),'sv');
assert.equal(resolveLanguage(['fi-FI'],null,'sv'),'sv');
assert.equal(resolveLanguage(['fi-FI'],'xx'),'fi');
assert.equal(resolveLanguage([]),'en');
pass('Saved-owner, sign-in selection, browser preference and English fallback precedence');
assert.equal(translate(catalog,'fi','common.save'),'Tallenna');
assert.equal(translate(catalog,'sv','common.save'),'Spara');
assert.equal(translate(catalog,'fi','profile.active',{name:'Åsa & <test>'}),'Kirjautuneena: Åsa & <test>');
assert.throws(()=>translate(catalog,'fi','profile.active'));
assert.throws(()=>translate(catalog,'sv','missing.key'));
assert.equal(translate({...catalog,'example':{en:'Fallback'}},'sv','example',{},false),'Fallback');
assert.equal(translate(catalog,'sv','missing.key',{},false),catalog['error.unavailable'].sv);
pass('Text interpolation, literal user content and strict/runtime fallback behaviour');
assert.equal(translateCount(catalog,'fi','wardrobe.count',0),'0 vaatetta');
assert.equal(translateCount(catalog,'fi','wardrobe.count',1),'1 vaate');
assert.equal(translateCount(catalog,'fi','wardrobe.count',2),'2 vaatetta');
assert.equal(translateCount(catalog,'sv','stats.wears',1),'1 användning');
assert.equal(translateCount(catalog,'sv','stats.wears',2),'2 användningar');
assert.equal(translateCount(catalog,'en','wardrobe.count',2),'2 items');
pass('Localized cardinal count messages for zero, one and multiple records');
for(const lang of ['fi','sv']){
  assert.equal(parsePrice('1 234,50',lang),'1234.50');
  assert.equal(parsePrice('1\u00a0234,5',lang),'1234.50');
  assert.equal(parsePrice('12.50',lang),'12.50');
  assert.equal(parsePrice('0',lang),'0.00');
  for(const bad of ['1.234','1,234.56','12,3,4','1 23,00','-1','12,','1e3','10000000000'])assert.throws(()=>parsePrice(bad,lang),bad);
  assert.ok(formatMoney('1234.50','EUR',lang).includes(',50'));
}
assert.equal(parsePrice('1,234.50','en'),'1234.50');
assert.throws(()=>parsePrice('12,50','en'));
pass('Finnish/Swedish decimal input and EUR formatting preserve SQL decimals and reject ambiguity');
for(const lang of languages){
  const formatted=formatDateOnly('2026-09-05',lang);
  const parts=new Intl.DateTimeFormat(locales[lang],{day:'numeric',month:'numeric',year:'numeric',timeZone:'UTC'}).formatToParts(new Date('2026-09-05T12:00:00Z'));
  assert.equal(Number(parts.find(x=>x.type==='day').value),5);assert.equal(Number(parts.find(x=>x.type==='month').value),9);
  assert.ok(formatted.includes('2026'));assert.throws(()=>formatDateOnly('2026-02-30',lang));
}
pass('Locale presentation preserves date-only calendar values and validates real dates');
assert.equal(searchText('A\u030ASA ÄITI Ö', 'fi'),'åsa äiti ö');
assert.notEqual(searchText('a','fi'),searchText('ä','fi'));
assert.deepEqual(['Ö','Z','Ä','Å'].sort(new Intl.Collator('sv-FI').compare),['Z','Å','Ä','Ö']);
pass('Nordic text keeps diacritics, NFC normalization and locale-aware display ordering');
console.log(JSON.stringify({executedOn:'2026-09-05',runtime:process.version,scope:'Translation references only; no implemented app or native-speaker review',languages,keys:Object.keys(catalog).length,checks},null,2));
