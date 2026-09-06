// Pure reference helpers only; adapt to typed React context in Phase 0.
// Translation values and interpolated values must be rendered as text, never HTML.
export const languages=Object.freeze(['en','fi','sv']);
export const locales=Object.freeze({en:'en-GB',fi:'fi-FI',sv:'sv-FI'});
export function resolveLanguage(browserLanguages=[],saved=null,signInChoice=null){
  if(languages.includes(saved))return saved;
  if(languages.includes(signInChoice))return signInChoice;
  for(const tag of browserLanguages){
    if(typeof tag!=='string')continue;
    const base=tag.toLowerCase().split('-')[0];
    if(languages.includes(base))return base;
  }
  return 'en';
}
const own=(value,key)=>Object.hasOwn(value,key);
export function translate(messages,language,key,parameters={},strict=true){
  const lang=languages.includes(language)?language:'en';
  const row=own(messages,key)?messages[key]:undefined;
  let template=row?.[lang];
  if(typeof template!=='string'||template.length===0){
    if(strict)throw new Error('Missing translation');
    template=row?.en||messages['error.unavailable'][lang];
  }
  const required=[...new Set([...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(m=>m[1]))];
  if(required.some(name=>!own(parameters,name))){
    if(strict)throw new Error('Missing translation parameter');
    return messages['error.unavailable'][lang];
  }
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,(_,name)=>String(parameters[name]));
}
export function translateCount(messages,language,key,count,strict=true){
  if(!Number.isSafeInteger(count)||count<0)throw new Error('Invalid count');
  const lang=languages.includes(language)?language:'en';
  const rule=new Intl.PluralRules(locales[lang]).select(count);
  return translate(messages,lang,`${key}_${rule}`,{count:new Intl.NumberFormat(locales[lang]).format(count)},strict);
}
export function formatMoney(decimal,currency,language){
  if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(decimal)||!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid money');
  // Floating-point conversion is display-only; never use this result for storage/arithmetic.
  return new Intl.NumberFormat(locales[language]||locales.en,{style:'currency',currency}).format(Number(decimal));
}
export function parsePrice(text,language){
  if(typeof text!=='string'||!languages.includes(language))throw new Error('Invalid price');
  const value=text.trim();
  const commaDecimal=language!=='en';
  let integer,fraction;
  if(commaDecimal){
    // A lone point is accepted as a keyboard convenience, but never as a thousands mark.
    const sep=value.includes(',')?',':'.';
    const split=value.split(sep);if(split.length>2)throw new Error('Invalid price');
    [integer,fraction]=split;
    if(!/^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)$/.test(integer))throw new Error('Invalid price');
    integer=integer.replace(/[ \u00a0\u202f]/g,'');
  }else{
    const split=value.split('.');if(split.length>2)throw new Error('Invalid price');
    [integer,fraction]=split;
    if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(integer))throw new Error('Invalid price');
    integer=integer.replace(/,/g,'');
  }
  if(fraction!==undefined&&!/^\d{1,2}$/.test(fraction))throw new Error('Invalid price');
  integer=integer.replace(/^0+(?=\d)/,'');
  if(integer.length>10)throw new Error('Invalid price');
  return `${integer}.${(fraction||'').padEnd(2,'0')}`;
}
export function formatDateOnly(iso,language){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw new Error('Invalid date');
  const d=new Date(`${iso}T12:00:00.000Z`);
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==iso)throw new Error('Invalid date');
  return new Intl.DateTimeFormat(locales[language]||locales.en,{year:'numeric',month:'numeric',day:'numeric',timeZone:'UTC'}).format(d);
}
export function searchText(value,language){return value.normalize('NFC').toLocaleLowerCase(locales[language]||locales.en);}
