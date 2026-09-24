import { describe, expect, it, vi } from 'vitest';
import {
  aspectCrop, cropGeometry, cropValues, FULL_CROP, handleMinimum, inverse, mapPoint, moveCrop, normalizeCrop, orientationTransform,
  parseCropValues, resizeCrop, sameEdit, validCrop, type Corner, type Crop,
} from '../../src/images/crop';
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

// The pre-L1b editor's keyboard nudge, kept verbatim so the new helper is proven equivalent.
const oldNudge = (crop: Crop, dx: number, dy: number): Crop => ({
  ...crop,
  x: Math.max(0, Math.min(1 - crop.width, crop.x + dx)),
  y: Math.max(0, Math.min(1 - crop.height, crop.y + dy)),
});
const tolerated: Crop[] = [
  { x: 0, y: 0, width: 1.00000000005, height: 0.5 },
  { x: 5e-11, y: 0.25, width: 1, height: 0.5 },
  { x: 0.25, y: 0, width: 0.5, height: 1.00000000005 },
  { x: 0.25, y: 5e-11, width: 0.5, height: 1 },
  { x: 5e-11, y: 5e-11, width: 1.00000000005, height: 1.00000000005 },
];
function seeded(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}
function randomCrops(count: number): Crop[] {
  const random = seeded(20260923), crops: Crop[] = [];
  while (crops.length < count) {
    const width = Math.max(1e-6, random()), height = Math.max(1e-6, random());
    crops.push({ x: random() * (1 - width), y: random() * (1 - height), width, height });
  }
  return crops;
}
const inside = (crop: Crop) => crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
  && crop.width <= 1 && crop.height <= 1 && crop.x + crop.width <= 1 + 1e-15 && crop.y + crop.height <= 1 + 1e-15;

describe('UX L1b crop frame helpers', () => {
  it('normalizes tolerance-admitted crops inside the photo without changing their values', () => {
    const plain = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(normalizeCrop(plain)).toEqual(plain);
    for (const crop of tolerated) {
      expect(validCrop(crop)).toBe(true);
      const normal = normalizeCrop(crop);
      expect(inside(normal)).toBe(true);
      expect(cropValues(normal)).toEqual(cropValues(crop));
    }
  });
  it('moves exactly like the previous keyboard nudge and never leaves the photo', () => {
    for (const crop of [...randomCrops(200), ...tolerated]) {
      for (const [dx, dy] of [[0.01, 0], [-0.01, 0], [0.1, 0], [-0.1, 0], [0, 0.01], [0, -0.01], [0, 0.1], [0, -0.1]] as const) {
        const moved = moveCrop(crop, dx, dy);
        expect(cropValues(moved)).toEqual(cropValues(oldNudge(crop, dx, dy)));
        expect(moved.x).toBeGreaterThanOrEqual(0);
        expect(moved.y).toBeGreaterThanOrEqual(0);
        expect(moved.width).toBe(Math.min(1, crop.width));
        expect(moved.height).toBe(Math.min(1, crop.height));
        expect(inside(moved)).toBe(true);
      }
    }
    expect(moveCrop({ x: 0.4, y: 0.4, width: 0.5, height: 0.5 }, 9, -9)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });
  it('resizes from each corner around a fixed opposite corner within the minimum and the photo', () => {
    const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];
    const start = { x: 0.2, y: 0.3, width: 0.5, height: 0.4 };
    const anchor = (crop: Crop, corner: Corner) => [
      corner.endsWith('w') ? crop.x + crop.width : crop.x,
      corner.startsWith('n') ? crop.y + crop.height : crop.y,
    ];
    for (const corner of corners) {
      expect(cropValues(resizeCrop(start, corner, 0, 0, 0.1, 0.1))).toEqual(cropValues(start));
      for (const [dx, dy] of [[0.05, -0.07], [-0.3, 0.2], [50, 50], [-50, -50], [50, -50], [-50, 50]] as const) {
        const next = resizeCrop(start, corner, dx, dy, 0.1, 0.12);
        const [ax, ay] = anchor(start, corner), [bx, by] = anchor(next, corner);
        expect(Math.abs(ax! - bx!)).toBeLessThanOrEqual(1e-12);
        expect(Math.abs(ay! - by!)).toBeLessThanOrEqual(1e-12);
        expect(next.width).toBeGreaterThanOrEqual(0.1 - 1e-12);
        expect(next.height).toBeGreaterThanOrEqual(0.12 - 1e-12);
        expect(inside(next)).toBe(true);
        expect(validCrop(next)).toBe(true);
      }
      const small = { x: 0.5, y: 0.5, width: 0.02, height: 0.03 };
      expect(cropValues(resizeCrop(small, corner, 0, 0, 0.1, 0.1))).toEqual(cropValues(small));
      const shrunk = resizeCrop(small, corner, corner.endsWith('w') ? 1 : -1, corner.startsWith('n') ? 1 : -1, 0.1, 0.1);
      expect([shrunk.width, shrunk.height].map((size) => cropValues({ ...FULL_CROP, width: size }).width)).toEqual(['2', '3']);
      for (const crop of tolerated) {
        const next = resizeCrop(crop, corner, -0.3, 0.3, 0.05, 0.05);
        expect(inside(next)).toBe(true);
        expect(validCrop(next)).toBe(true);
      }
    }
  });
  it('sizes the handle minimum from the stage pixels', () => {
    expect(handleMinimum(1000)).toBe(0.096);
    expect(handleMinimum(3000)).toBe(0.05);
    expect(handleMinimum(50)).toBe(1);
    expect(handleMinimum(0)).toBe(1);
    expect(handleMinimum(Number.NaN)).toBe(1);
    for (const px of [120, 213, 320, 777, 1234]) expect(handleMinimum(px) * px).toBeGreaterThanOrEqual(96);
  });
  it('compares edits after quantisation and quarter-turn normalisation', () => {
    const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    expect(sameEdit({ turns: 0, crop: FULL_CROP }, { turns: 4, crop: FULL_CROP })).toBe(true);
    expect(sameEdit({ turns: 1, crop: FULL_CROP }, { turns: 0, crop: FULL_CROP })).toBe(false);
    expect(sameEdit({ turns: 3, crop }, { turns: -1, crop: { ...crop, x: 0.1 + 1e-14 } })).toBe(true);
    expect(sameEdit({ turns: 0, crop }, { turns: 0, crop: { ...crop, x: 0.1 + 1e-12 } })).toBe(false);
    expect(sameEdit({ turns: 0, crop: { ...crop, width: 0 } }, { turns: 0, crop })).toBe(false);
    expect(sameEdit({ turns: 0, crop }, { turns: 0, crop: { ...crop, height: Number.NaN } })).toBe(false);
  });
});