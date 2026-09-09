import { describe, expect, it } from 'vitest';
import { isLanguage, itemCount, languages, messages, resolveLanguage, translate } from '../../src/i18n';
import { canonicalPrice, formatDateOnly, formatMoney, parsePrice, priceForDatabase } from '../../src/i18n/format';

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
  it('formats canonical prices without changing their value or recorded currency', () => {
    for (const language of languages) {
      for (const price of ['0.01', '0.10', '0.00', '9999999999.99']) {
        const display = formatMoney(price, 'USD', language);
        expect(display.length).toBeGreaterThan(0);
        expect(canonicalPrice(priceForDatabase(price))).toBe(price);
        expect(formatMoney(price, 'EUR', language)).not.toBe(display);
      }
    }
    expect(parsePrice('1,234.50', 'en')).toBe(parsePrice('1 234,50', 'fi'));
    expect(parsePrice('1\u202f234,50', 'sv')).toBe('1234.50');
    expect(() => formatMoney('1.234', 'EUR', 'en')).toThrow();
    expect(() => formatMoney('1.23', 'eur', 'en')).toThrow();
  });
  it('formats real date-only values using the same UTC calendar day in all languages', () => {
    const date = '2024-02-29';
    expect(formatDateOnly(date, 'en')).toBe('29/02/2024');
    expect(formatDateOnly(date, 'fi')).toBe('29.2.2024');
    expect(formatDateOnly(date, 'sv')).toContain('2024');
    for (const language of languages) {
      expect(formatDateOnly('2099-12-31', language)).toContain('2099');
      expect(() => formatDateOnly('2025-02-29', language)).toThrow();
      expect(() => formatDateOnly('2026-04-31', language)).toThrow();
    }
    expect(date).toBe('2024-02-29');
  });
});
