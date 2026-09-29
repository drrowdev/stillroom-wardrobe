import { describe, expect, it } from 'vitest';
import { parseTryOnStatus } from '../../src/data/tryon';
import { TRYON_MANIFEST, TRYON_MODEL, TRYON_NOTICE_REVISION } from '../../src/domain/tryon';
import {
  TRYON_BACKUP_DAYS, TRYON_NOTICE_KEYS, TRYON_NOTICE_PENDING, tryOnReleaseHeld, tryOnViewOf, type TryOnState, type TryOnStore,
} from '../../src/features/settings/tryon-store';
import baseMessages from '../../src/i18n/messages.json';
import messages from '../../src/i18n/tryon.json';

// The revision-1 notice is a DRAFT until the owner approves it at G5a; its hash pin is added then, not before. These
// checks keep the facts it must state, and keep Turn on closed while the text or the backup retention is pending.
const text = (key: (typeof TRYON_NOTICE_KEYS)[number]) => messages[key];
const languages = ['en', 'fi', 'sv'] as const;

describe('try-on notice (draft, revision 1)', () => {
  it('stays out of the startup catalog: the try-on messages load with the try-on screens', () => {
    expect(Object.keys(baseMessages).filter((key) => /^tryonC?\./.test(key))).toEqual([]);
    expect(Object.keys(messages).every((key) => /^tryonC?\./.test(key))).toBe(true);
  });
  it('is revision 1 and complete in EN, FI and SV', () => {
    expect(TRYON_NOTICE_REVISION).toBe(1);
    for (const key of TRYON_NOTICE_KEYS) for (const language of languages) expect(text(key)[language].trim(), `${key} ${language}`).not.toBe('');
  });
  it('has four paragraphs in the order of the clean-up notice', () => {
    expect(TRYON_NOTICE_KEYS).toEqual(['tryonC.noticeSent', 'tryonC.noticeResult', 'tryonC.noticeProcessing', 'tryonC.noticeCharges']);
  });
  it('says the photo is sent to Azure and never saved by Stillroom', () => {
    expect(text('tryonC.noticeSent').en).toContain('sent to Microsoft Azure OpenAI');
    expect(text('tryonC.noticeSent').en).toContain('Stillroom never saves your photo');
    expect(text('tryonC.noticeSent').fi).toContain('Stillroom ei koskaan tallenna kuvaasi');
    expect(text('tryonC.noticeSent').sv).toContain('Stillroom sparar aldrig din bild');
  });
  it('says the redraw can change body or garments and only the final picture is kept for 7 days', () => {
    const result = text('tryonC.noticeResult');
    expect(result.en).toContain('It can change how your body or the garments look');
    expect(result.en).toContain('Only the final picture is kept');
    expect(result.en).toContain('"Made with AI"');
    expect(result.en).toContain('for 7 days');
    expect(result.fi).toContain('7 päiväksi');
    expect(result.sv).toContain('i 7 dagar');
    for (const language of languages) expect(result[language].match(/\{backupDays\}/g), language).toHaveLength(1);
    for (const language of languages) {
      expect(result[language]).not.toMatch(/within a day|within 24|vuorokauden|dygn/i);
    }
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

describe('release hold (fail closed)', () => {
  const status = parseTryOnStatus({ code: 'CONSENT_REQUIRED', period: '2026-10', serverTimeMs: Date.parse('2026-10-05T00:00:00Z'),
    consent: { enabled: false, noticeRevision: null, consentedAt: null },
    policy: { activated: true, noticeRevision: TRYON_NOTICE_REVISION, manifestId: TRYON_MANIFEST, modelId: TRYON_MODEL,
      maxRequestMicro: '400000', tryOnAllowanceMicro: '5000000', totalAllowanceMicro: '20000000', maxRequestsPerHour: 20,
      maxSteps: 3, maxResults: 20, resultDays: 7, providerAvailable: true },
    results: 0, usage: { tryOnMicro: '0', totalMicro: '0', tryOnLastHour: 0, warning: false } })!;
  const state: TryOnState = { read: { kind: 'ready', status }, known: true, unresolved: false, reading: false, writing: false, settingsError: null };
  it('is held while the notice or the backup retention is pending', () => {
    expect(TRYON_NOTICE_PENDING).toBe(true);
    expect(TRYON_BACKUP_DAYS).toBeNull();
    expect(tryOnReleaseHeld()).toBe(true);
  });
  it('never offers Turn on while held, even when the backend is activated', () => {
    const view = tryOnViewOf({ consentOn: false } as TryOnStore, state);
    expect(view).toEqual({ kind: 'off', turnOn: false, turnOff: false });
    const on = tryOnViewOf({ consentOn: true } as TryOnStore, { ...state, read: { kind: 'ready', status: { ...status,
      consent: { enabled: true, noticeRevision: TRYON_NOTICE_REVISION } } } });
    expect(on.turnOff).toBe(true);
  });
});
