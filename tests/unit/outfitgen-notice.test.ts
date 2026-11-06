import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTFITGEN_NOTICE_REVISION } from '../../src/domain/outfitgen';
import { OUTFITGEN_NOTICE_KEYS } from '../../src/features/outfitgen/outfitgen-store';
import { messages } from '../../src/i18n/all';

// The suggested-outfits consent notice, revision 1 (OUTFITGEN1b). Any change to these strings needs a new notice
// revision (the server, the app constant and the consent) and a new pin. The shared titles and the training sentence are
// the wording already approved for the same Azure deployment (photo analysis and the stylist).
describe('suggested outfits notice', () => {
  it('pins revision 1 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: OUTFITGEN_NOTICE_REVISION,
      ...Object.fromEntries(OUTFITGEN_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(OUTFITGEN_NOTICE_REVISION).toBe(1);
    expect(createHash('sha256').update(notice).digest('hex')).toBe('66f4a5cbb15d510a1856ea48b12919656f30c90d14082add75a709e703884a7b');
  });
  it('is shown in full by the Settings card, in the same order', () => {
    const source = readFileSync('src/features/settings/outfitgen-settings.tsx', 'utf8');
    const used = [...source.matchAll(/t\('((?:outfitgenC|stylistC|aiC)\.[A-Za-z]+)'\)/g)].map((match) => match[1]);
    const noticeUsed = used.filter((key) => (OUTFITGEN_NOTICE_KEYS as readonly string[]).includes(key!));
    expect(noticeUsed).toEqual([...OUTFITGEN_NOTICE_KEYS]);
  });
  it('says what is sent, how often, where, what is stored, what Remove does and what a run costs', () => {
    const en = (key: (typeof OUTFITGEN_NOTICE_KEYS)[number]) => messages[key].en;
    expect(en('outfitgenC.sent')).toContain('Photos of your saved clothes');
    expect(en('outfitgenC.sent')).toContain('many photos');
    expect(en('outfitgenC.sent')).toContain('Names, notes, brands, sizes, materials and prices aren\'t sent');
    expect(en('outfitgenC.when')).toContain('when you tap Find new outfits');
    expect(en('outfitgenC.when')).toContain('after you save a garment');
    expect(en('outfitgenC.when')).toContain('when the app opens');
    expect(en('outfitgenC.processing')).toContain('Azure OpenAI GPT-5.6 Terra');
    expect(en('outfitgenC.processing')).toContain('EU Data Zone');
    expect(en('outfitgenC.stored')).toContain('Suggestions are saved in the app until you keep or remove them');
    expect(en('outfitgenC.stored')).toContain('marks the set as not wanted in Today');
    expect(en('outfitgenC.charges')).toContain('counts toward your monthly AI limit');
    expect(en('outfitgenC.charges')).toContain('even if nothing is suggested');
    expect(en('outfitgenC.optOut')).toContain('Turning it off stops new runs');
    expect(messages['outfitgenC.processing'].fi).toContain('EU Data Zone');
    expect(messages['outfitgenC.processing'].sv).toContain('EU Data Zone');
    expect(messages['outfitgenC.stored'].fi).toContain('Tänään');
    expect(messages['outfitgenC.stored'].sv).toContain('Idag');
  });
});
