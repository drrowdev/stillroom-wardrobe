import { describe, expect, it } from 'vitest';
import { presentAiFacts, usdCents } from '../../src/domain/ai-presentation';
import { languages, locales } from '../../src/i18n';

describe('local presentation, not a second inference', () => {
  it.each(languages)('generates bounded supported text in %s without inventing facts', (language) => {
    const presentation = presentAiFacts({ outcome: 'ready', fields: { category: 'top', colours: ['green', 'navy'],
      material: 'Unverified fabric', brand: 'Private brand', size_label: 'M' } }, language);
    expect(presentation.title.length).toBeGreaterThan(0);
    expect([...presentation.title].length).toBeLessThanOrEqual(100);
    expect([...presentation.description].length).toBeLessThanOrEqual(240);
    expect(presentation.tags.every((tag) => [...tag].length <= 40)).toBe(true);
    expect(JSON.stringify(presentation)).not.toMatch(/Unverified|Private|warm|waterproof/);
  });
  it('leaves unknown and unclear fields empty', () => {
    expect(presentAiFacts({ outcome: 'unclear', fields: {} }, 'en')).toEqual({ title: '', description: '', tags: [] });
    expect(presentAiFacts({ outcome: 'ready', fields: {} }, 'fi')).toEqual({ title: '', description: '', tags: [] });
  });
  it('names the item by singular category and first colour, and suggests style words as tags only', () => {
    const fields = { category: 'top', colours: ['green', 'navy'], style_tags: [' Relaxed ', 'relaxed', 'Minimal'] } as const;
    expect(presentAiFacts({ outcome: 'ready', fields }, 'en')).toEqual({
      title: 'Green top', description: 'Green top', tags: ['Relaxed', 'Minimal'] });
    expect(presentAiFacts({ outcome: 'ready', fields }, 'fi')).toMatchObject({ title: 'Vihreä yläosa', description: 'Vihreä yläosa' });
    expect(presentAiFacts({ outcome: 'ready', fields }, 'sv')).toMatchObject({ title: 'Grön överdel', description: 'Grön överdel' });
    expect(JSON.stringify(presentAiFacts({ outcome: 'ready', fields }, 'en'))).not.toMatch(/·|navy/iu);
    expect(presentAiFacts({ outcome: 'ready', fields: { category: 'footwear' } }, 'en').title).toBe('Footwear');
    expect(presentAiFacts({ outcome: 'ready', fields: { colours: ['navy'] } }, 'sv').title).toBe('Marinblå');
    expect(presentAiFacts({ outcome: 'ready', fields: { category: 'outerwear', colours: ['burgundy', 'gold'] } }, 'en').title).toBe('Burgundy outerwear');
    expect(presentAiFacts({ outcome: 'ready', fields: { category: 'outerwear', colours: ['burgundy'] } }, 'fi').title).toBe('Viininpunainen ulkovaate');
    expect(presentAiFacts({ outcome: 'ready', fields: { category: 'footwear', colours: ['silver'] } }, 'sv').title).toBe('Silverfärgade skor');
    expect(presentAiFacts({ outcome: 'ready', fields: { category: 'top', colours: ['green'] } }, 'en').tags).toEqual([]);
  });
  it('rounds usage up and the limit down to whole cents', () => {
    expect(usdCents('0', 'en', 'used')).toBe('$0.00');
    expect(usdCents('1', 'en', 'used')).toBe('$0.01');
    expect(usdCents('10000', 'en', 'used')).toBe('$0.01');
    expect(usdCents('10001', 'en', 'used')).toBe('$0.02');
    expect(usdCents('20000000', 'en', 'limit')).toBe('$20');
    expect(usdCents('20005000', 'en', 'limit')).toBe('$20');
    expect(usdCents('20015000', 'en', 'limit')).toBe('$20.01');
    expect(usdCents('9999', 'en', 'limit')).toBe('$0');
  });
  it.each(['fi', 'sv'] as const)('formats cents with native %s conventions', (language) => {
    const format = (value: string, whole: boolean) => new Intl.NumberFormat(locales[language], { style: 'currency', currency: 'USD',
      currencyDisplay: 'narrowSymbol', minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(value as `${number}`);
    expect(usdCents('10001', language, 'used')).toBe(format('0.02', false));
    expect(usdCents('20000000', language, 'limit')).toBe(format('20', true));
    expect(usdCents('20015000', language, 'limit')).toBe(format('20.01', false));
  });
  it('rejects invalid or unsafe amounts', () => {
    for (const value of ['-1', '1.2', '01', '', '9'.repeat(65), '9'.repeat(30)]) {
      expect(() => usdCents(value, 'en', 'used')).toThrow();
      expect(() => usdCents(value, 'en', 'limit')).toThrow();
    }
  });
});
