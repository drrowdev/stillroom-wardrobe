import { describe, expect, it } from 'vitest';
import { microUsd, presentAiFacts } from '../../src/domain/ai-presentation';
import { languages } from '../../src/i18n';

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
  it('formats exact microUSD without floating-point loss or garment conversion', () => {
    expect(microUsd('9007199254740993', 'en')).toBe('9,007,199,254.740993 USD');
    expect(microUsd('1', 'fi')).toBe('0,000001 USD');
    expect(microUsd('0', 'sv')).toBe('0,000000 USD');
    expect(microUsd('18446744073709551614', 'en')).toBe('18,446,744,073,709.551614 USD');
    for (const value of ['-1', '1.2', '01', '9'.repeat(65)]) expect(() => microUsd(value, 'en')).toThrow();
  });
});
