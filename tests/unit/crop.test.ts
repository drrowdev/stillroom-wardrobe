import { describe, expect, it, vi } from 'vitest';
import { aspectCrop, cropGeometry, cropValues, FULL_CROP, inverse, mapPoint, orientationTransform, parseCropValues, validCrop } from '../../src/images/crop';
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
  for (const [width, height] of [[1600, 607], [1600, 530], [607, 1600], [530, 1600]] as const) {
    it(`round-trips Original ratio at ${width}x${height}, including after rotation`, () => {
      expect(parseCropValues(cropValues(aspectCrop(width, height, width / height)))).toEqual(FULL_CROP);
      const rotated = parseCropValues(cropValues(aspectCrop(height, width, width / height)));
      expect(validCrop(rotated)).toBe(true);
      expect(rotated).not.toEqual(FULL_CROP);
      expect(rotated.width * height / (rotated.height * width)).toBeCloseTo(width / height, 9);
    });
  }
  it('round-trips paired boundaries and positive dimensions without exponent strings', () => {
    for (const width of [Number.MIN_VALUE, 1e-20, 1 / 40_000_000, 0.123456789012345, 0.9999999999999999, 1]) {
      for (const height of [Number.MIN_VALUE, 1e-20, 0.234567890123456, 0.9999999999999999, 1]) {
        const original = { x: 1 - width, y: 1 - height, width, height };
        const values = cropValues(original), crop = parseCropValues(values);
        expect(Object.values(values).every((value) => /^\d+(?:\.\d{1,10})?$/.test(value))).toBe(true);
        expect(validCrop(crop)).toBe(true);
        expect(crop.x + crop.width).toBeLessThanOrEqual(1 + Number.EPSILON);
        expect(crop.y + crop.height).toBeLessThanOrEqual(1 + Number.EPSILON);
        expect(crop.width).toBeGreaterThan(0);
        expect(crop.height).toBeGreaterThan(0);
        for (const field of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(crop[field] - original[field])).toBeLessThanOrEqual(1.01e-12);
        expect(cropValues(crop)).toEqual(values);
        expect(cropGeometry(40_000_000, 1, 1, { turns: 0, crop }).width).toBeGreaterThanOrEqual(1);
      }
    }
    const tolerated = { x: 0.50000000005, y: 0.50000000005, width: 0.5, height: 0.5 };
    expect(validCrop(tolerated)).toBe(true);
    expect(validCrop(parseCropValues(cropValues(tolerated)))).toBe(true);
  });
  it('does not normalize invalid or cleared user input into a valid crop', () => {
    for (const value of ['', ' ', '1e-12', '-1', 'Infinity', 'NaN', '1,2.3', '101']) {
      expect(validCrop(parseCropValues({ ...cropValues(FULL_CROP), width: value }))).toBe(false);
    }
    expect(validCrop(parseCropValues({ x: '0', y: '0', width: '0', height: '100' }))).toBe(false);
    expect(parseCropValues({ x: ' 0 ', y: '0', width: '50,5', height: '.5' })).toEqual({ x: 0, y: 0, width: 0.505, height: 0.005 });
    expect(() => cropValues({ ...FULL_CROP, x: 0.1 })).toThrow('invalid');
  });
  it('keeps enhancement unavailable without network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await imageEnhancementProvider.enhance()).toEqual({ status: 'unavailable' });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
