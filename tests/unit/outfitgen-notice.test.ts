import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTFITGEN_NOTICE_REVISION, OUTFITGEN_SETTINGS } from '../../src/domain/outfitgen';
import { OUTFITGEN_NOTICE_KEYS } from '../../src/features/outfitgen/outfitgen-store';
import { messages } from '../../src/i18n/all';

// The suggested-outfits consent notice. Revision 1 is frozen below (it was the consent text of OUTFITGEN1b); revision 2 (OUTFITGEN2) adds the
// automatic pictures of you. Any change to these strings needs a new notice revision (the server, the app constant and the consent) and a new
// pin. The shared titles and the training sentence are the wording already approved for the same Azure deployment (photo analysis and the stylist).
const REVISION_1_KEYS = [
  'stylistC.fieldsTitle', 'outfitgenC.sent', 'outfitgenC.when', 'stylistC.processing', 'outfitgenC.processing', 'aiC.retentionTitle',
  'aiC.azureTrainingNotice', 'outfitgenC.stored', 'aiC.chargesTitle', 'outfitgenC.charges', 'outfitgenC.optOut',
] as const;
const pin = (revision: number, keys: readonly (keyof typeof messages)[]) => createHash('sha256')
  .update(JSON.stringify({ noticeRevision: revision, ...Object.fromEntries(keys.map((key) => [key, messages[key]])) })).digest('hex');

describe('suggested outfits notice', () => {
  it('keeps revision 1 frozen over EN, FI and SV', () => {
    expect(pin(1, REVISION_1_KEYS)).toBe('493827adc53315128512bd9648b2ceab22e8f65e6286c182d62744cdc45730b3');
  });
  it('pins revision 2 over EN, FI and SV', () => {
    expect(OUTFITGEN_NOTICE_REVISION).toBe(2);
    expect(pin(OUTFITGEN_NOTICE_REVISION, OUTFITGEN_NOTICE_KEYS)).toBe('2e69ce4ee3c4bc2c42987b3eceaf86a4ee746f61c6ba87708afcb0ef2ab1018b');
  });
  it('keeps the reviewed manifest settings at their original revision', () => {
    expect(OUTFITGEN_SETTINGS.noticeRevision).toBe(1);
  });  it('is shown in full by the Settings card, in the same order', () => {
    const source = readFileSync('src/features/settings/outfitgen-settings.tsx', 'utf8');
    const used = [...source.matchAll(/t\('((?:outfitgenC|stylistC|aiC)\.[A-Za-z0-9]+)'\)/g)].map((match) => match[1]);
    const noticeUsed = used.filter((key) => (OUTFITGEN_NOTICE_KEYS as readonly string[]).includes(key!));
    expect(noticeUsed).toEqual([...OUTFITGEN_NOTICE_KEYS]);
  });
  it('says plainly that pictures of you are made automatically, what they cost and what Remove deletes', () => {
    const text = (language: 'en' | 'fi' | 'sv') => messages['outfitgenC.pictures'][language];
    expect(text('en')).toContain('without you tapping Try on');
    expect(text('en')).toContain('no separate cap');
    expect(text('en')).toContain('counts toward your monthly AI limit');
    expect(text('en')).toContain('until you delete them');
    expect(text('en')).toContain('made after the suggestion appeared');
    expect(text('en')).toContain('including one you made yourself');
    expect(text('en')).toContain('Pictures made earlier stay');
    expect(text('en')).not.toMatch(/always|every picture is deleted/i);
    expect(text('fi')).toContain('Tehty tekoälyllä');
    expect(text('sv')).toContain('Gjord med AI');
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
    // Decided suggestions stay stored, and when they are deleted.
    expect(en('outfitgenC.stored')).toContain('Kept and removed suggestions stay saved, with their reason and list of garments');
    expect(en('outfitgenC.stored')).toContain('permanently delete one of those garments, or your account');
    expect(en('outfitgenC.charges')).toContain('counts toward your monthly AI limit');
    expect(en('outfitgenC.charges')).toContain('even if nothing is suggested');
    expect(en('outfitgenC.optOut2')).toContain('Turning it off stops new runs and new pictures');
    expect(messages['outfitgenC.processing'].fi).toContain('EU Data Zone');
    expect(messages['outfitgenC.processing'].sv).toContain('EU Data Zone');
    expect(messages['outfitgenC.stored'].fi).toContain('Tänään');
    expect(messages['outfitgenC.stored'].sv).toContain('Idag');
  });
});
