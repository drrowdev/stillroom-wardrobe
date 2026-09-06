import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSanitizedJpeg, fitDimensions, JPEG_LIMITS, readJpegHeader, stripEncoderColorProfile } from '../../src/images/jpeg';
import { ImagePreparationError, prepareJpeg } from '../../src/images/process-jpeg';
import { exifSegment, insertSegments, joinBytes, jpegHeaderFixture, jpegSegment } from '../fixtures/jpeg-helpers';

function expectCode(action: () => unknown, code: ImagePreparationError['code']): void {
  expect(action).toThrowError(expect.objectContaining({ name: 'ImagePreparationError', code }));
}

afterEach(() => vi.unstubAllGlobals());

describe('JPEG headers without a decoder or canvas', () => {
  it.each([0xc0, 0xc1, 0xc2])('reads dimensions from supported frame %i', (frame) => {
    expect(readJpegHeader(jpegHeaderFixture(3000, 2000, frame))).toEqual({
      width: 3000, height: 2000, orientation: 1,
    });
  });

  it.each([true, false])('reads all EXIF orientations, little-endian=%s', (littleEndian) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      expect(readJpegHeader(insertSegments(jpegHeaderFixture(), exifSegment(orientation, littleEndian))))
        .toEqual({ width: 120, height: 80, orientation });
    }
  });

  it('accepts the exact 40 megapixel limit and rejects larger dimensions', () => {
    expect(readJpegHeader(jpegHeaderFixture(8000, 5000)).width).toBe(8000);
    expectCode(() => readJpegHeader(jpegHeaderFixture(8001, 5000)), 'tooLarge');
    expectCode(() => readJpegHeader(jpegHeaderFixture(65535, 65535)), 'tooLarge');
  });

  it.each([
    new Uint8Array(),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    new TextEncoder().encode('RIFF____WEBP'),
    new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    new TextEncoder().encode('....ftypheic'),
  ])('rejects non-JPEG signatures', (bytes) => {
    expectCode(() => readJpegHeader(bytes), 'unsupported');
  });

  it('rejects every truncation in a complete header', () => {
    const bytes = jpegHeaderFixture();
    const scanOffset = bytes.length - 6;
    for (let length = 2; length < scanOffset; length += 1) {
      expectCode(() => readJpegHeader(bytes.subarray(0, length)), 'invalid');
    }
  });

  it('rejects invalid segment lengths, framing, dimensions and scan components', () => {
    for (const bytes of [
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd8]),
      new Uint8Array([0xff, 0xd8, 0xff, 0xd0]),
      new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      new Uint8Array([0xff, 0xd8, 0x00, 0xe0]),
      jpegHeaderFixture(0, 80),
      jpegHeaderFixture(80, 0),
      joinBytes(new Uint8Array([0xff, 0xd8]), jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]))),
    ]) expectCode(() => readJpegHeader(bytes), 'invalid');
    const badScan = jpegHeaderFixture();
    badScan[20] = 9;
    expectCode(() => readJpegHeader(badScan), 'invalid');
    const duplicateFrame = jpegHeaderFixture();
    expectCode(() => readJpegHeader(insertSegments(duplicateFrame, duplicateFrame.subarray(2, 15))), 'invalid');
  });

  it('rejects unsupported JPEG frame/precision rather than guessing', () => {
    expectCode(() => readJpegHeader(jpegHeaderFixture(120, 80, 0xc3)), 'unsupported');
    const bytes = jpegHeaderFixture();
    bytes[6] = 12;
    expectCode(() => readJpegHeader(bytes), 'unsupported');
  });

  it('bounds both header bytes and marker count', () => {
    const large = jpegSegment(0xe2, new Uint8Array(65533));
    const bytes = insertSegments(jpegHeaderFixture(), ...Array.from({ length: 17 }, () => large));
    expectCode(() => readJpegHeader(bytes), 'tooLarge');
    const empty = jpegSegment(0xe2, new Uint8Array());
    expectCode(() => readJpegHeader(insertSegments(
      jpegHeaderFixture(), ...Array.from({ length: JPEG_LIMITS.headerSegments }, () => empty),
    )), 'tooLarge');
    expectCode(() => readJpegHeader(joinBytes(new Uint8Array([0xff, 0xd8]), new Uint8Array(JPEG_LIMITS.headerBytes).fill(0xff))), 'tooLarge');
  });

  it('rejects malformed and ambiguous EXIF without out-of-bounds reads', () => {
    for (const littleEndian of [true, false]) {
      for (const orientation of [0, 9, 65535]) {
        expectCode(() => readJpegHeader(insertSegments(jpegHeaderFixture(), exifSegment(orientation, littleEndian))), 'invalid');
      }
      const exif = exifSegment(1, littleEndian);
      new DataView(exif.buffer).setUint32(14, 0xfffffff0, littleEndian);
      expectCode(() => readJpegHeader(insertSegments(jpegHeaderFixture(), exif)), 'invalid');
      const count = exifSegment(1, littleEndian);
      new DataView(count.buffer).setUint16(18, 65535, littleEndian);
      expectCode(() => readJpegHeader(insertSegments(jpegHeaderFixture(), count)), 'invalid');
    }
    expectCode(() => readJpegHeader(insertSegments(
      jpegHeaderFixture(), exifSegment(1), exifSegment(6),
    )), 'invalid');
    expectCode(() => readJpegHeader(insertSegments(
      jpegHeaderFixture(), jpegSegment(0xe1, new TextEncoder().encode('Exif\0\0bad')),
    )), 'invalid');
  });
});

describe('fresh JPEG output validation', () => {
  it('omits only generated ICC profiles from fresh encoder bytes, never other metadata', () => {
    const bytes = jpegHeaderFixture();
    const profile = jpegSegment(0xe2, new TextEncoder().encode('ICC_PROFILE\0synthetic profile'));
    expect(stripEncoderColorProfile(insertSegments(bytes, profile, profile))).toEqual(bytes);
    for (const marker of [0xe1, 0xe2, 0xed, 0xfe]) {
      const metadata = jpegSegment(marker, new TextEncoder().encode('private metadata'));
      expectCode(() => assertSanitizedJpeg(
        stripEncoderColorProfile(insertSegments(bytes, profile, metadata)), 120, 80,
      ), 'invalid');
    }
  });

  it('accepts sanitized scan bytes and standard JFIF only', () => {
    const jfif = jpegSegment(0xe0, new Uint8Array([74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
    expect(() => assertSanitizedJpeg(insertSegments(jpegHeaderFixture(), jfif), 120, 80)).not.toThrow();
  });

  it.each([0xe1, 0xed, 0xfe, 0xe2, 0xec])('rejects metadata marker %i before and after scans', (marker) => {
    const bytes = jpegHeaderFixture();
    const privateSegment = jpegSegment(marker, new Uint8Array([1, 2, 3]));
    expectCode(() => assertSanitizedJpeg(insertSegments(bytes, privateSegment), 120, 80), 'invalid');
    const afterScan = joinBytes(bytes.subarray(0, -2), privateSegment, bytes.subarray(-2));
    expectCode(() => assertSanitizedJpeg(afterScan, 120, 80), 'invalid');
  });

  it('rejects EXIF/GPS, unexpected dimensions, truncation and trailing payloads', () => {
    const bytes = jpegHeaderFixture();
    expectCode(() => assertSanitizedJpeg(insertSegments(bytes, exifSegment(1)), 120, 80), 'invalid');
    expectCode(() => assertSanitizedJpeg(bytes, 80, 120), 'invalid');
    for (const end of [bytes.length - 1, bytes.length - 2, bytes.length - 4]) {
      expectCode(() => assertSanitizedJpeg(bytes.subarray(0, end), 120, 80), 'invalid');
    }
    expectCode(() => assertSanitizedJpeg(joinBytes(bytes, new Uint8Array([1])), 120, 80), 'invalid');
    expectCode(() => assertSanitizedJpeg(insertSegments(
      bytes, jpegSegment(0xe0, new TextEncoder().encode('not standard JFIF')),
    ), 120, 80), 'invalid');
  });

  it('walks additional progressive scans and escaped/restart markers', () => {
    const bytes = jpegHeaderFixture(120, 80, 0xc2);
    const multiScan = joinBytes(
      bytes.subarray(0, -2),
      new Uint8Array([0xff, 0xd0, 0xff, 0x00, 0x01]),
      jpegSegment(0xda, new Uint8Array([1, 1, 0, 1, 63, 0])),
      new Uint8Array([0x12, 0xff, 0xd9]),
    );
    expect(() => assertSanitizedJpeg(multiScan, 120, 80)).not.toThrow();
  });
});

describe('bounded dimensions', () => {
  it.each([
    [4000, 3000, 1600, 1600, 1200],
    [3000, 4000, 1600, 1200, 1600],
    [120, 80, 320, 120, 80],
    [65535, 1, 1600, 1600, 1],
    [901, 601, 800, 800, 534],
  ])('fits %i × %i into %i without upscaling', (width, height, side, expectedWidth, expectedHeight) => {
    expect(fitDimensions(width, height, side)).toEqual({ width: expectedWidth, height: expectedHeight });
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid sizes: %s', (width) => {
    expectCode(() => fitDimensions(width, 100, 1600), 'invalid');
  });
});

describe('public preparation preflight in Node without canvas', () => {
  it('has a stable coarse public error code', () => {
    const error = new ImagePreparationError('tooLarge');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('tooLarge');
    expect(error.message).toBe('tooLarge');
  });

  it('rejects more than 20 MiB without reading any bytes', async () => {
    const blob = new Blob([new Uint8Array(JPEG_LIMITS.sourceBytes + 1)]);
    const slice = vi.spyOn(blob, 'slice');
    await expect(prepareJpeg(blob)).rejects.toMatchObject({ code: 'tooLarge' });
    expect(slice).not.toHaveBeenCalled();
  });

  it('rejects excessive header dimensions without requiring a browser', async () => {
    await expect(prepareJpeg(new Blob([jpegHeaderFixture(9000, 5000)])))
      .rejects.toMatchObject({ code: 'tooLarge' });
  });

  it('rejects a truncated entropy stream before trying a browser decoder', async () => {
    const bytes = jpegHeaderFixture();
    await expect(prepareJpeg(new Blob([bytes.subarray(0, -2)])))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('uses the signature, not the MIME hint, and reads a bounded prefix', async () => {
    await expect(prepareJpeg(new Blob(['not a jpeg'], { type: 'image/jpeg' })))
      .rejects.toMatchObject({ code: 'unsupported' });
    const blob = new Blob([jpegHeaderFixture()], { type: 'text/plain' });
    const slice = vi.spyOn(blob, 'slice');
    await expect(prepareJpeg(blob)).rejects.toMatchObject({ code: 'unavailable' });
    expect(slice).toHaveBeenCalledWith(0, JPEG_LIMITS.headerBytes);
  });

  it('rejects cancellation with DOMException AbortError, including custom abort reasons', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private abort reason'));
    const result = prepareJpeg(new Blob(), controller.signal);
    await expect(result).rejects.toBeInstanceOf(DOMException);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts an in-flight prefix read without continuing into a decoder', async () => {
    const controller = new AbortController();
    const blob = new Blob([jpegHeaderFixture()]);
    const prefix = blob.slice();
    let finishRead: ((value: ArrayBuffer) => void) | undefined;
    vi.spyOn(prefix, 'arrayBuffer').mockReturnValue(new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve;
    }));
    vi.spyOn(blob, 'slice').mockReturnValue(prefix);
    const promise = prepareJpeg(blob, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    finishRead?.(jpegHeaderFixture().buffer);
  });
});
