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
  it('states what is sent, that Stillroom does not save the photo and what Microsoft may keep', () => {
    expect(text('tryonC.noticeSent').en).toContain('sent to Microsoft Azure OpenAI as they are');
    expect(text('tryonC.noticePhoto').en).toContain("Stillroom doesn't save your photo");
    expect(text('tryonC.noticePhoto').fi).toContain('Stillroom ei tallenna kuvaasi');
    expect(text('tryonC.noticePhoto').sv).toContain('Stillroom sparar inte din bild');
    expect(text('tryonC.noticeMicrosoft').en).toContain('Microsoft may keep submitted photos and generated pictures for a limited period');
    expect(text('tryonC.noticeMicrosoft').en).toContain("doesn't use it to train models");
    // Processing keeps the rev4 Azure Global statement (the enhancement revision-1 wording). The clean-up notice revision 2
    // (BG2c-2) shortened its own copy; whether try-on follows is decided with the draft text at G5a.
    expect(text('tryonC.noticeProcessing').en).toContain('Azure Global deployment');
    expect(text('tryonC.noticeProcessing').en).toContain('including outside the EU');
    expect(text('tryonC.noticeProcessing').fi).toContain('myös EU:n ulkopuolella');
    expect(text('tryonC.noticeProcessing').sv).toContain('även utanför EU');
  });
  it('keeps the three separate Result statements, with no cleanup deadline', () => {
    const result = text('tryonC.noticeResult');
    expect(result.en).toContain('You can see it for 7 days');
    expect(result.fi).toContain('7 päivän ajan');
    expect(result.sv).toContain('i 7 dagar');
    expect(result.en).toContain("it's deleted from the app automatically.");
    for (const language of languages) expect(result[language].match(/\{backupDays\}/g), language).toHaveLength(1);
    for (const language of languages) {
      expect(result[language]).not.toMatch(/within a day|within 24|vuorokauden|dygn/i);
    }
  });
  it('names the Made with AI label and charges per garment', () => {
    expect(text('tryonC.noticeLabel').en).toContain("'Made with AI'");
    expect(text('tryonC.noticeCharges').en).toContain('Each garment counts toward a monthly limit');
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
