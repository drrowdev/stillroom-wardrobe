import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { OUTFITGEN_LANGUAGES, OUTFITGEN_LIMITS, plainText } from '../../src/domain/outfitgen';
import { PLAIN_TEXT } from '../../src/domain/outfit-plain-text';

describe('plain look text (OUTFITGEN-QUALITY2)', () => {
  it('is the very text the CI probes store through claim and finish', async () => {
    const probes = await readFile(new URL('../integration/outfitgen.sessions.mjs', import.meta.url), 'utf8');
    for (const language of OUTFITGEN_LANGUAGES) {
      expect(probes).toContain(`'${PLAIN_TEXT[language].title}'`);
      expect(probes).toContain(`'${PLAIN_TEXT[language].reason}'`);
    }
  });
  it('exists for every language the app supports, fits what a suggestion may store, and differs by language', () => {
    expect(Object.keys(PLAIN_TEXT).sort()).toEqual([...OUTFITGEN_LANGUAGES].sort());
    for (const language of OUTFITGEN_LANGUAGES) {
      expect(plainText(PLAIN_TEXT[language].title, OUTFITGEN_LIMITS.title)).toBe(true);
      expect(plainText(PLAIN_TEXT[language].reason, OUTFITGEN_LIMITS.reason)).toBe(true);
    }
    expect(new Set(OUTFITGEN_LANGUAGES.map((language) => PLAIN_TEXT[language].reason)).size).toBe(OUTFITGEN_LANGUAGES.length);
  });
});
