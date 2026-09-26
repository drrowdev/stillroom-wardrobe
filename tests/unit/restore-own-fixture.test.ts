import { describe, expect, it } from 'vitest';
import { parseGarmentValues } from '../../src/domain/garment-fields';
import { occasions } from '../../src/domain/outfits';
import { flatJpeg } from '../fixtures/restore-jpeg-fixtures';
import { syntheticMetadata } from '../fixtures/restore-own-backup';

// The restore-own gate's synthetic backup must hold rows the app itself accepts; an invalid row is only ever retried.
describe('restore-own synthetic backup', () => {
  it('has garment rows and outfits the app accepts', async () => {
    const photo = { bytes: flatJpeg({ width: 8, height: 8, colour: [1, 2, 3] }), width: 8, height: 8 };
    const metadata = await syntheticMetadata({ owner: '11111111-2222-4333-8444-555555555555', exportId: '99999999-2222-4333-8444-555555555555',
      items: [{ title: 'Fictional shirt', photos: [photo] }, { title: 'Fictional trousers', photos: [photo], notes: 'Fictional note' }], extras: true });
    const { items, outfits } = metadata.tables as unknown as Record<string, Record<string, unknown>[]>;
    expect(items).toHaveLength(2);
    for (const row of items!) expect(() => parseGarmentValues(row)).not.toThrow();
    for (const outfit of outfits!) expect(occasions).toContain(outfit.occasion);
  });
});
