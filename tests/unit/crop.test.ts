import { describe, expect, it, vi } from 'vitest';
import { aspectCrop, cropGeometry, FULL_CROP, inverse, mapPoint, orientationTransform, validCrop } from '../../src/images/crop';
import { imageEnhancementProvider } from '../../src/providers/enhancement';

describe('I07 geometry', () => {
  for (let orientation = 1; orientation <= 8; orientation++) {
    for (let turns = 0; turns < 4; turns++) {
      it(`maps and inverts EXIF ${orientation} with quarter-turn ${turns}`, () => {
        const result = orientationTransform(121, 83, orientation, turns);
        const points = [[0, 0], [121, 0], [0, 83], [121, 83], [17, 29]] as const;
        for (const [x, y] of points) {
          const mapped = mapPoint(result.matrix, x, y);
          expect(mapped[0]).toBeGreaterThanOrEqual(0);
          expect(mapped[0]).toBeLessThanOrEqual(result.width);
          expect(mapped[1]).toBeGreaterThanOrEqual(0);
          expect(mapped[1]).toBeLessThanOrEqual(result.height);
          expect(mapPoint(inverse(result.matrix), ...mapped)).toEqual([x, y]);
        }
        expect(orientationTransform(121, 83, orientation, turns + 4)).toEqual(result);
        const crop = cropGeometry(121, 83, orientation, { turns, crop: { x: 0.99, y: 0.999, width: 0.01, height: 0.001 } });
        expect(crop.width).toBeGreaterThanOrEqual(1);
        expect(crop.height).toBe(1);
        expect(crop.source.x + crop.source.width).toBeLessThanOrEqual(121);
        expect(crop.source.y + crop.source.height).toBeLessThanOrEqual(83);
      });
    }
  }
  it('keeps identity/default and bounded centered aspect crops', () => {
    expect(cropGeometry(120, 80).identity).toBe(true);
    expect(aspectCrop(120, 80, 1)).toEqual({ x: (1 - 2 / 3) / 2, y: 0, width: 2 / 3, height: 1 });
    expect(aspectCrop(120, 80, 1.5)).toEqual(FULL_CROP);
    for (const crop of [{ ...FULL_CROP, width: 0 }, { ...FULL_CROP, x: -1 }, { ...FULL_CROP, height: NaN }, { ...FULL_CROP, x: 0.1 }]) {
      expect(validCrop(crop)).toBe(false);
      expect(() => cropGeometry(120, 80, 1, { turns: 0, crop })).toThrow('invalid');
    }
  });
  it('uses independently specified mirrored and rotated points', () => {
    const expected = [[17, 29], [103, 29], [103, 51], [17, 51], [29, 17], [51, 17], [51, 103], [29, 103]];
    expected.forEach((point, index) => expect(mapPoint(orientationTransform(120, 80, index + 1).matrix, 17, 29)).toEqual(point));
  });
  it('keeps enhancement unavailable without network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await imageEnhancementProvider.enhance()).toEqual({ status: 'unavailable' });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
