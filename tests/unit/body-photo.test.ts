import { describe, expect, it } from 'vitest';
import { BODY_ASPECT, BODY_MIN_CROP, BodyPhotoError, admitBodySource, bodyCropRect, prepareBodyPhoto } from '../../src/images/body-photo';
import { aspectFactor, aspectPixelRect, largestAspectCrop, resizeAspectCrop, snapAspectCrop, type Crop } from '../../src/images/crop';
import { JPEG_LIMITS } from '../../src/images/jpeg';
import { TRYON_LIMITS } from '../../src/domain/tryon';

const code = async (work: Promise<unknown> | (() => unknown)) => {
  try { await (typeof work === 'function' ? work() : work); } catch (error) { return error instanceof BodyPhotoError ? error.code : String(error); }
  return 'ok';
};
const ratio = (rect: { width: number; height: number }) => rect.height / rect.width;

describe('fixed 4:5 crop geometry (rev4 §4.1)', () => {
  const sizes: [number, number][] = [[3024, 4032], [4032, 3024], [1080, 1350], [1000, 1000], [2001, 2999], [640, 800]];
  it('gives the largest centred 4:5 crop that maps to one exact pixel rectangle, for every orientation', () => {
    for (const [width, height] of sizes) {
      for (const turns of [0, 1, 2, 3, -1]) {
        const crop = largestAspectCrop(width, height, turns, BODY_ASPECT);
        const [w, h] = ((turns % 4) + 4) % 2 ? [height, width] : [width, height];
        const rect = aspectPixelRect(w, h, crop, 4, 5);
        expect(rect, `${width}x${height} turns ${turns}`).not.toBeNull();
        expect(rect!.height).toBe(Math.round(rect!.width * 5 / 4));
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(w);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(h);
        // Largest: one side is (nearly) full.
        expect(Math.max(rect!.width / w, rect!.height / h)).toBeGreaterThan(0.995);
      }
    }
  });
  it('keeps the ratio through corner drags and stays inside the image', () => {
    const width = 3000, height = 4000, factor = aspectFactor(width, height, 4, 5);
    let crop: Crop = largestAspectCrop(width, height, 0, BODY_ASPECT);
    for (const [corner, dx, dy] of [['nw', 0.2, 0.05], ['se', -0.1, 0.3], ['ne', 0.5, -0.5], ['sw', -1, 1], ['se', 2, 2]] as const) {
      crop = resizeAspectCrop(crop, corner, dx, dy, 0.05, 0.05, factor);
      expect(crop.height / crop.width).toBeCloseTo(factor, 9);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1 + 1e-12);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1 + 1e-12);
      const snapped = snapAspectCrop(width, height, crop, 4, 5)!;
      expect(aspectPixelRect(width, height, snapped, 4, 5)).not.toBeNull();
    }
  });
  it('refuses crops that are not 4:5, leave the image or are below 512x640', () => {
    const source = { width: 3000, height: 4000 };
    const good = largestAspectCrop(source.width, source.height, 0, BODY_ASPECT);
    expect(ratio(bodyCropRect(source, { turns: 0, crop: good }))).toBeCloseTo(1.25, 2);
    expect(() => bodyCropRect(source, { turns: 0, crop: { x: 0, y: 0, width: 1, height: 1 } })).toThrow(BodyPhotoError);
    expect(() => bodyCropRect(source, { turns: 0.5, crop: good })).toThrow(BodyPhotoError);
    const small = snapAspectCrop(source.width, source.height, { x: 0, y: 0, width: 400 / 3000, height: 500 / 4000 }, 4, 5)!;
    expect(() => bodyCropRect(source, { turns: 0, crop: small })).toThrow('small');
    const minimum = snapAspectCrop(source.width, source.height, { x: 0, y: 0, width: BODY_MIN_CROP.width / 3000, height: BODY_MIN_CROP.height / 4000 }, 4, 5)!;
    expect(bodyCropRect(source, { turns: 0, crop: minimum })).toEqual({ x: 0, y: 0, width: 512, height: 640 });
    // A landscape crop turned a quarter uses the oriented size.
    const turned = largestAspectCrop(source.width, source.height, 1, BODY_ASPECT);
    const rect = bodyCropRect(source, { turns: 1, crop: turned });
    expect(rect.x + rect.width).toBeLessThanOrEqual(4000);
    expect(rect.y + rect.height).toBeLessThanOrEqual(3000);
    expect(rect.height).toBe(Math.round(rect.width * 1.25));
  });
});

describe('body photo admission and preparation', () => {
  it('encodes to exactly the try-on input size', () => {
    expect([TRYON_LIMITS.personWidth, TRYON_LIMITS.personHeight, TRYON_LIMITS.personBytes]).toEqual([1024, 1280, 512_000]);
  });
  it('refuses oversized and non-image sources before decoding', async () => {
    expect(await code(admitBodySource(new Blob([new Uint8Array(JPEG_LIMITS.sourceBytes + 1)], { type: 'image/jpeg' })))).toBe('unusable');
    expect(['invalid', 'unsupported']).toContain(await code(admitBodySource(new Blob(['not an image'], { type: 'text/plain' }))));
  });
  it('checks the crop before anything is drawn, and needs a browser to encode', async () => {
    const source = { blob: new Blob([]), width: 3000, height: 4000 };
    expect(await code(prepareBodyPhoto(source, { turns: 0, crop: { x: 0, y: 0, width: 1, height: 1 } }))).toBe('invalid');
    expect(await code(prepareBodyPhoto(source, { turns: 0, crop: largestAspectCrop(3000, 4000, 0, BODY_ASPECT) }))).toBe('unavailable');
  });
  it('stops at once when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = { blob: new Blob([]), width: 3000, height: 4000 };
    await expect(prepareBodyPhoto(source, { turns: 0, crop: largestAspectCrop(3000, 4000, 0, BODY_ASPECT) }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
