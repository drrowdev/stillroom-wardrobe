import { describe, expect, it } from 'vitest';
import { isLanguage, itemCount, languages, messages, resolveLanguage, translate } from '../../src/i18n';

describe('owner-isolated language', () => {
  it('resolves saved owner, sign-in, browser and English in order', () => {
    expect(resolveLanguage(['fi-FI'], 'sv', 'en')).toBe('sv');
    expect(resolveLanguage(['fi-FI'], null, 'en')).toBe('en');
    expect(resolveLanguage(['de-DE', 'sv-SE', 'fi-FI'])).toBe('sv');
    expect(resolveLanguage(['ja-JP'])).toBe('en');
    expect(resolveLanguage(['fi-FI'], null, null)).toBe('fi');
    expect(isLanguage('sv-SE')).toBe(false);
  });
  it('all catalogs have real translations with matching parameters', () => {
    for (const entry of Object.values(messages)) {
      const parameters = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      for (const language of languages) {
        expect(entry[language].trim().length).toBeGreaterThan(0);
        expect(parameters(entry[language])).toEqual(parameters(entry.en));
      }
    }
  });
  it('formats plural counts without changing identifiers or personal text', () => {
    expect(itemCount('en', 1)).toBe('1 item');
    expect(itemCount('en', 2)).toBe('2 items');
    expect(itemCount('fi', 0)).toContain('0');
    expect(() => itemCount('sv', -1)).toThrow();
    expect(translate('sv', 'item.deleteConfirm', { name: '<script>Åäö</script>' })).toContain('<script>Åäö</script>');
    expect(translate('fi', 'capture.save')).not.toBe(messages['capture.save'].en);
    expect(() => translate('en', 'wardrobe.count_other')).toThrow('parameter');
  });
});
