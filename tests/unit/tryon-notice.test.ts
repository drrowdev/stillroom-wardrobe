import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTryOnStatus } from '../../src/data/tryon';
import { TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import { TRYON_NOTICE_KEYS, tryOnViewOf, type TryOnState, type TryOnStore } from '../../src/features/settings/tryon-store';
import baseMessages from '../../src/i18n/messages.json';
import messages from '../../src/i18n/tryon.json';

// The owner-approved try-on notice (G5a, #84), revision 1, with the backup retention settled at G3 (7 days, Supabase
// daily backups; no PITR). Any change to these strings needs a new revision and a new pin.
const text = (key: (typeof TRYON_NOTICE_KEYS)[number]) => messages[key];
const languages = ['en', 'fi', 'sv'] as const;

describe('try-on notice (revision 1)', () => {
  it('stays out of the startup catalog: the try-on messages load with the try-on screens', () => {
    expect(Object.keys(baseMessages).filter((key) => /^tryonC?\./.test(key))).toEqual([]);
    expect(Object.keys(messages).every((key) => /^tryonC?\./.test(key))).toBe(true);
  });
  it('pins revision 1 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: TRYON_NOTICE_REVISION,
      ...Object.fromEntries(TRYON_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(TRYON_NOTICE_REVISION).toBe(1);
    expect(createHash('sha256').update(notice).digest('hex')).toBe('3676041c99e6f91b54dfa6eac0016afed17ff098dddf2ea9b67360d090daf8ac');
  });
  it('has four paragraphs in the order of the clean-up notice, with no placeholder left', () => {
    expect(TRYON_NOTICE_KEYS).toEqual(['tryonC.noticeSent', 'tryonC.noticeResult', 'tryonC.noticeProcessing', 'tryonC.noticeCharges']);
    for (const key of TRYON_NOTICE_KEYS) for (const language of languages) expect(text(key)[language], `${key} ${language}`).not.toMatch(/\{\w+\}/);
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
