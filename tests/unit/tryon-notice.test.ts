import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTryOnStatus } from '../../src/data/tryon';
import { TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { TRYON_NOTICE_KEYS, tryOnViewOf, type TryOnState, type TryOnStore } from '../../src/features/settings/tryon-store';
import baseMessages from '../../src/i18n/messages.json';
import messages from '../../src/i18n/tryon.json';

// The owner-approved try-on notice (G5a, #84), revision 1, with the backup retention settled at G3 (7 days, Supabase
// daily backups; no PITR). Revision 1 is frozen: literal revision, literal four keys, never edited. Revision 2 (TRYON-PHOTO1)
// states the one saved reference photo and has its own five keys and pin below.
const REVISION_1_KEYS = ['tryonC.noticeSent', 'tryonC.noticeResult', 'tryonC.noticeProcessing', 'tryonC.noticeCharges'] as const;
const text = (key: keyof typeof messages) => messages[key];
const languages = ['en', 'fi', 'sv'] as const;

describe('try-on notice (revision 1, frozen)', () => {
  it('stays out of the startup catalog: the try-on messages load with the try-on screens', () => {
    expect(Object.keys(baseMessages).filter((key) => /^tryonC?\./.test(key))).toEqual([]);
    expect(Object.keys(messages).every((key) => /^tryonC?\./.test(key))).toBe(true);
  });
  it('pins revision 1 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: 1, ...Object.fromEntries(REVISION_1_KEYS.map((key) => [key, messages[key]])) });
    expect(createHash('sha256').update(notice).digest('hex')).toBe('3676041c99e6f91b54dfa6eac0016afed17ff098dddf2ea9b67360d090daf8ac');
  });
  it('has four paragraphs in the order of the clean-up notice, with no placeholder left', () => {
    for (const key of REVISION_1_KEYS) for (const language of languages) expect(text(key)[language], `${key} ${language}`).not.toMatch(/\{\w+\}/);
  });
  it('says the photo is sent to Azure and never saved by Stillroom', () => {
    expect(text('tryonC.noticeSent').en).toContain('sent to Microsoft Azure OpenAI');
    expect(text('tryonC.noticeSent').en).toContain('Stillroom never saves your photo');
    expect(text('tryonC.noticeSent').fi).toContain('Stillroom ei koskaan tallenna kuvaasi');
    expect(text('tryonC.noticeSent').sv).toContain('Stillroom sparar aldrig din bild');
  });
  it('says the redraw can change body or garments, only the final picture is kept for 7 days, backups up to 7 days', () => {
    const result = text('tryonC.noticeResult');
    expect(result.en).toContain('It can change how your body or the garments look');
    expect(result.en).toContain('Only the final picture is kept');
    expect(result.en).toContain('"Made with AI"');
    expect(result.en).toContain('for 7 days, unless you delete it sooner');
    expect(result.en).toContain('encrypted database backups for up to 7 days.');
    expect(result.fi).toContain('7 päiväksi');
    expect(result.fi).toContain('enintään 7 päivää.');
    expect(result.sv).toContain('i 7 dagar');
    expect(result.sv).toContain('i upp till 7 dagar.');
    for (const language of languages) expect(result[language]).not.toMatch(/within a day|within 24|vuorokauden|dygn/i);
  });
  it('uses the reviewed clean-up processing statement: outside the EU, abuse-check retention, no training', () => {
    for (const language of languages) expect(text('tryonC.noticeProcessing')[language]).toBe(baseMessages['enhanceC.noticeProcessing'][language]);
    expect(text('tryonC.noticeProcessing').en).toContain('outside the EU');
    expect(text('tryonC.noticeProcessing').en).toContain('to check for abuse');
  });
  it('charges per garment against the monthly limit', () => {
    expect(text('tryonC.noticeCharges').en).toContain('Each garment counts toward your monthly AI limit');
  });
});

describe('try-on notice (revision 2, TRYON-PHOTO1)', () => {
  it('is the notice the app asks consent for, in the order sent, saved photo, result, processing, charges', () => {
    expect(TRYON_NOTICE_REVISION).toBe(2);
    expect(TRYON_NOTICE_KEYS).toEqual(['tryonC.notice2Sent', 'tryonC.notice2Saved', 'tryonC.notice2Result', 'tryonC.notice2Processing', 'tryonC.notice2Charges']);
    for (const key of TRYON_NOTICE_KEYS) for (const language of languages) expect(text(key)[language], `${key} ${language}`).not.toMatch(/\{\w+\}/);
  });
  it('pins revision 2 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: 2, ...Object.fromEntries(TRYON_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(createHash('sha256').update(notice).digest('hex')).toBe('34b6999740a19e5089bc8d9969146c8313755b629bc61cf63bf2ad0c3b453baa');
  });
  it('no longer says the photo is never saved, and says exactly what is kept', () => {
    for (const language of languages) expect(text('tryonC.notice2Sent')[language]).not.toMatch(/never saves|ei koskaan tallenna|sparar aldrig/);
    const saved = text('tryonC.notice2Saved');
    expect(saved.en).toContain('only if you choose Save photo, and only one at a time');
    expect(saved.en).toContain('Only your account can access it in Stillroom');
    expect(saved.en).toContain('Turning try-on off, removing the photo or deleting your account also deletes it');
    expect(saved.en).toContain('encrypted database backups for up to 7 days');
    expect(saved.en).toContain("isn't included in your own backups");
    expect(saved.fi).toContain('enintään 7 päivää');
    expect(saved.sv).toContain('i upp till 7 dagar');
  });
  it('qualifies the result paragraph so it does not contradict the saved photo', () => {
    expect(text('tryonC.notice2Result').en).toContain('Of the generated pictures, only the final one is kept');
    expect(text('tryonC.notice2Result').en).not.toContain('Only the final picture is kept');
    expect(text('tryonC.notice2Result').fi).toContain('Luoduista kuvista säilytetään vain valmis kuva');
    expect(text('tryonC.notice2Result').sv).toContain('Av de skapade bilderna behålls bara den färdiga');
  });
  it('keeps the reviewed processing and charge statements word for word', () => {
    for (const language of languages) {
      expect(text('tryonC.notice2Processing')[language]).toBe(text('tryonC.noticeProcessing')[language]);
      expect(text('tryonC.notice2Charges')[language]).toBe(text('tryonC.noticeCharges')[language]);
    }
  });
});


describe('Turn on (fail closed)', () => {
  const raw = (over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) => parseTryOnStatus({
    code: 'CONSENT_REQUIRED', period: '2026-10', serverTimeMs: Date.parse('2026-10-05T00:00:00Z'),
    consent: { enabled: false, noticeRevision: null, consentedAt: null },
    policy: { activated: true, noticeRevision: TRYON_NOTICE_REVISION, manifestId: TRYON_MANIFEST, modelId: TRYON_MODEL,
      maxRequestMicro: '400000',
      maxSteps: 3, maxResults: 20, resultDays: 7, providerAvailable: true, ...policy },
    results: 0, budget: { monthlyAllowanceMicro: '20000000', usedMicro: '0', remainingMicro: '20000000', warning: false }, ...over });
  const view = (status: ReturnType<typeof raw>, consentOn = false) => {
    const state: TryOnState = { read: { kind: 'ready', status: status! }, known: true, unresolved: false, reading: false, writing: false, settingsError: null };
    return tryOnViewOf({ consentOn } as TryOnStore, state);
  };
  it('is offered when the server policy is activated and matches the pinned notice, manifest and model', () => {
    expect(view(raw())).toEqual({ kind: 'off', turnOn: true, turnOff: false });
  });
  it('is never offered when the policy is not activated, names another notice, manifest or model, or has expired', () => {
    expect(view(raw({}, { activated: false })).turnOn).toBe(false);
    expect(view(raw({}, { noticeRevision: TRYON_NOTICE_REVISION + 1 })).turnOn).toBe(false);
    expect(view(raw({}, { manifestId: 'other' })).turnOn).toBe(false);
    expect(view(raw({}, { modelId: 'other' })).turnOn).toBe(false);
    expect(view(raw({ serverTimeMs: Date.parse('2027-01-01T00:00:00Z') })).turnOn).toBe(false);
    expect(view(parseTryOnStatus({ code: 'UNAVAILABLE' })).turnOn).toBe(false);
  });
  it('asks to turn on again when consent was given to another revision; Turn off stays', () => {
    const renew = raw({ code: 'OK', consent: { enabled: true, noticeRevision: TRYON_NOTICE_REVISION + 1, consentedAt: '2026-10-01T00:00:00Z' } });
    expect(view(renew, true)).toEqual({ kind: 'renew', turnOn: true, turnOff: true });
  });
});
