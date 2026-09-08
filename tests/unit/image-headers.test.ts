import { describe, expect, it } from 'vitest';
import { readTiffOrientation, validateImage, WEBP_FLAGS } from '../../src/images/validate';
import { JPEG_LIMITS } from '../../src/images/jpeg';
import { joinBytes } from '../fixtures/jpeg-helpers';
import { PNG_SIGNATURE, pngChunk, pngHeader, riff, tiff, vp8l, vp8x, webpChunk } from '../fixtures/image-helpers';

const data = pngChunk('IDAT', new Uint8Array([1]));
const end = pngChunk('IEND');
const png = (...chunks: Uint8Array<ArrayBuffer>[]) => new Blob([PNG_SIGNATURE, pngHeader(), ...chunks, end]);
const exif = (value: number) => pngChunk('eXIf', tiff(value));

describe('I07 bounded admission and deletion-only normalization', () => {
  for (const little of [true, false]) for (let orientation = 1; orientation <= 8; orientation++) {
    it(`reads TIFF orientation ${orientation}, little endian ${little}`, () => {
      expect(readTiffOrientation(tiff(orientation, little))).toBe(orientation);
      expect(readTiffOrientation(tiff(orientation, little, true), true)).toBe(orientation);
      expect(() => readTiffOrientation(tiff(orientation, little, true))).toThrow('invalid');
    });
  }
  it('accepts missing orientation and rejects malformed/duplicate values and cyclic directories', () => {
    expect(readTiffOrientation(tiff(null))).toBe(1);
    for (const value of [0, 9, 65535]) expect(() => readTiffOrientation(tiff(value))).toThrow('invalid');
    for (const offset of [0, 2, 4, 12, 14, 22]) {
      const bytes = tiff(1); bytes[offset] = 255;
      expect(() => readTiffOrientation(bytes)).toThrow('invalid');
    }
    const duplicate = joinBytes(tiff(1).subarray(0, 22), tiff(2).subarray(10));
    new DataView(duplicate.buffer).setUint16(8, 2, true);
    expect(() => readTiffOrientation(duplicate)).toThrow('invalid');
    const cycle = tiff(1); new DataView(cycle.buffer).setUint32(22, 8, true);
    expect(() => readTiffOrientation(cycle)).toThrow('invalid');
  });
  for (const before of [true, false]) for (let orientation = 1; orientation <= 8; orientation++) {
    it(`retains every non-Exif PNG byte, orientation ${orientation}, before data ${before}`, async () => {
      const text = pngChunk('tEXt', new TextEncoder().encode('Comment\0synthetic XMP colour alpha'));
      const base = png(text, data);
      const source = before ? png(text, exif(orientation), data) : png(text, data, exif(orientation));
      const result = await validateImage(source);
      expect(result.orientation).toBe(orientation);
      expect(result.width).toBe(120);
      if (orientation === 1) expect(result.blob).toBe(source);
      else expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array(await base.arrayBuffer()));
    });
  }
  it('preserves PNG identity with absent orientation and rejects bad structure/animation anywhere', async () => {
    for (const source of [png(data), png(pngChunk('eXIf', tiff(null)), data)]) expect((await validateImage(source)).blob).toBe(source);
    const corrupt = exif(6); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    for (const source of [
      png(exif(1), data, exif(6)), png(corrupt, data), png(data, pngChunk('tEXt'), data),
      png(pngHeader(), data), png(data, pngChunk('IEND')), new Blob([png(data), new Uint8Array([0])]),
      new Blob([PNG_SIGNATURE, pngHeader(), new Uint8Array([0xff, 0xff, 0xff, 0xff]), end]),
    ]) await expect(validateImage(source)).rejects.toMatchObject({ code: 'invalid' });
    for (const kind of ['acTL', 'fcTL', 'fdAT']) for (const before of [true, false]) {
      const animation = pngChunk(kind);
      await expect(validateImage(before ? png(animation, data) : png(data, animation))).rejects.toMatchObject({ code: 'unsupported' });
    }
  });
  it('walks past large pixel data using slices, never the entire source array', async () => {
    const bigData = pngChunk('IDAT', new Uint8Array(JPEG_LIMITS.headerBytes + 1));
    const source = png(bigData, exif(8));
    source.arrayBuffer = () => { throw new Error('full-source allocation'); };
    expect((await validateImage(source)).orientation).toBe(8);
    await expect(validateImage(png(bigData, pngChunk('acTL')))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(validateImage(png(pngChunk('tEXt', new Uint8Array(JPEG_LIMITS.headerBytes)), data))).rejects.toMatchObject({ code: 'tooLarge' });
    await expect(validateImage(png(...Array.from({ length: 4096 }, () => pngChunk('tEXt')), data))).rejects.toMatchObject({ code: 'tooLarge' });
  });
  it('checks WebP flags against literal specification masks and 24-bit fields', async () => {
    expect(WEBP_FLAGS).toEqual({ icc: 32, alpha: 16, exif: 8, xmp: 4, animation: 2 });
    for (const [width, height] of [[16384, 255], [257, 16383]]) {
      const result = await validateImage(new Blob([riff(vp8x(width!, height!), vp8l(width, height))]));
      expect([result.width, result.height]).toEqual([width, height]);
    }
  });
  for (let orientation = 1; orientation <= 8; orientation++) {
    it(`preserves WebP ICC/alpha/XMP/unknown/pixel bytes, orientation ${orientation}`, async () => {
      const retained = [
        webpChunk('ICCP', new Uint8Array([1, 2, 3])), vp8l(120, 80, true),
        webpChunk('XMP ', new TextEncoder().encode('synthetic XMP')), webpChunk('zzzz', new Uint8Array([7])),
      ];
      const source = new Blob([riff(vp8x(120, 80, 0x3c), ...retained, webpChunk('EXIF', tiff(orientation, false, true)))]);
      const result = await validateImage(source);
      expect(result.orientation).toBe(orientation);
      if (orientation === 1) expect(result.blob).toBe(source);
      else {
        const expected = riff(vp8x(120, 80, 0x34), ...retained);
        expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(expected);
        expect(result.blob.size).toBe(source.size - webpChunk('EXIF', tiff(orientation, false, true)).length);
      }
    });
  }
  it('rejects WebP ambiguity, malformed sizes, padding, flags, order and animation', async () => {
    const wrongSize = riff(vp8l()); wrongSize[4] = 0;
    const wrongPad = webpChunk('zzzz', new Uint8Array([1])); wrongPad[9] = 1;
    for (const bytes of [
      wrongSize, riff(vp8l(), wrongPad), riff(vp8l(), vp8l()), riff(vp8x(121, 80), vp8l()),
      riff(vp8x(120, 80, 8), vp8l()), riff(vp8x(120, 80), vp8l(), webpChunk('EXIF', tiff(1))),
      riff(vp8x(120, 80, 8), webpChunk('EXIF', tiff(1)), vp8l()),
      riff(vp8x(120, 80, 8), vp8l(), webpChunk('EXIF', tiff(1)), webpChunk('EXIF', tiff(1))),
      riff(vp8x(120, 80, 0x80), vp8l()), riff(vp8l(), vp8x(120, 80)),
    ]) await expect(validateImage(new Blob([bytes]))).rejects.toMatchObject({ code: 'invalid' });
    for (const bytes of [riff(vp8x(120, 80, 2), vp8l()), riff(vp8l(), webpChunk('ANIM', new Uint8Array())), riff(webpChunk('ANMF', new Uint8Array()))]) {
      await expect(validateImage(new Blob([bytes]))).rejects.toMatchObject({ code: 'unsupported' });
    }
    const tooMany = riff(vp8l(), ...Array.from({ length: 64 }, () => webpChunk('zzzz', new Uint8Array())));
    await expect(validateImage(new Blob([tooMany])))
      .rejects.toMatchObject({ code: 'tooLarge' });
  });
  it('bounds source bytes/pixels, refuses unsupported signatures and honors abort', async () => {
    await expect(validateImage(new Blob([new Uint8Array(JPEG_LIMITS.sourceBytes + 1)]))).rejects.toMatchObject({ code: 'tooLarge' });
    await expect(validateImage(new Blob([PNG_SIGNATURE, pngHeader(10000, 10000), data, end]))).rejects.toMatchObject({ code: 'tooLarge' });
    for (const value of ['<svg/>', '<html/>', 'GIF89a', '\0\0\0\x18ftypheic']) {
      await expect(validateImage(new Blob([value]))).rejects.toMatchObject({ code: 'unsupported' });
    }
    await expect(validateImage(png(data), AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
});
