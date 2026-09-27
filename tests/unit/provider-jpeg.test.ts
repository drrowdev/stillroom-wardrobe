// BG2b (H1): provider-output admission. Every hostile stream is refused before any decoder starts; an accepted photo
// keeps its scan bytes exactly and is the app's own byte-preservable baseline profile at 1024x1280.
import { describe, expect, it } from 'vitest';
import { ImagePreparationError } from '../../src/images/jpeg';
import { admitProviderJpeg, decodeProviderBase64, PROVIDER_JPEG } from '../../src/images/provider-jpeg';
import { inspectRestoreJpeg } from '../../src/images/restore-jpeg';
import { exifSegment, joinBytes, jpegSegment } from '../fixtures/jpeg-helpers';
import { findMarker, findMarkers, flatJpeg } from '../fixtures/restore-jpeg-fixtures';

const W = PROVIDER_JPEG.width, H = PROVIDER_JPEG.height;
const good = (options: Partial<Parameters<typeof flatJpeg>[0]> = {}) => flatJpeg({ width: W, height: H, ...options });
const text = (value: string) => new TextEncoder().encode(value);
const segment = (marker: number, size = 8) => jpegSegment(marker, new Uint8Array(size).fill(0x41));
const splice = (bytes: Uint8Array, at: number, remove: number, ...insert: Uint8Array[]) =>
  joinBytes(bytes.subarray(0, at), ...insert, bytes.subarray(at + remove));
const beforeEoi = (bytes: Uint8Array, ...insert: Uint8Array[]) => splice(bytes, bytes.length - 2, 0, ...insert);
const sof = (marker: number, width: number, height: number) => jpegSegment(marker,
  new Uint8Array([8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]));
const rejected = (bytes: Uint8Array) => {
  let failure: unknown;
  try { admitProviderJpeg(bytes); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ImagePreparationError);
};

describe('provider-output admission', () => {
  it('admits the baseline profile unchanged, with or without JFIF', () => {
    for (const jfif of [true, false]) {
      const input = good({ jfif });
      const admitted = admitProviderJpeg(input);
      expect(admitted).toMatchObject({ width: W, height: H, stripped: false });
      expect(admitted.bytes).toEqual(input);
      expect(inspectRestoreJpeg(admitted.bytes, W, H).kind).toBe('preserve');
    }
  });

  it('removes EXIF, XMP, C2PA APP11, COM and a non-canonical APP0, keeping every scan byte', () => {
    const xmp = jpegSegment(0xe1, joinBytes(text('http://ns.adobe.com/xap/1.0/\0'), text('<x:xmpmeta/>')));
    const c2pa = jpegSegment(0xeb, joinBytes(text('JP'), new Uint8Array(64).fill(7)));
    const extraApp0 = jpegSegment(0xe0, text('JFXX\0thumb'));
    const input = good({ segments: [exifSegment(1), xmp, c2pa, jpegSegment(0xfe, text('generator')), extraApp0, segment(0xe2, 300)] });
    const clean = good();
    const admitted = admitProviderJpeg(input);
    expect(admitted.stripped).toBe(true);
    expect(admitted.bytes).toEqual(clean);
    const scan = findMarker(input, 0xda), cleanScan = findMarker(admitted.bytes, 0xda);
    expect(admitted.bytes.subarray(cleanScan)).toEqual(input.subarray(scan));
    expect(inspectRestoreJpeg(admitted.bytes, W, H).kind).toBe('preserve');
    // Idempotent: the client re-admits the accepted bytes and gets them back as they are.
    expect(admitProviderJpeg(admitted.bytes).bytes).toEqual(admitted.bytes);
  });

  it('refuses the reviewer stream: a second frame after the scan declaring 65535x65535', () => {
    rejected(beforeEoi(good(), sof(0xc0, 65535, 65535)));
    const tiny = joinBytes(new Uint8Array([0xff, 0xd8]), sof(0xc0, W, H),
      jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])), new Uint8Array([0]), sof(0xc0, 65535, 65535), new Uint8Array([0xff, 0xd9]));
    expect(tiny.length).toBeLessThanOrEqual(64);
    rejected(tiny);
  });

  it('refuses duplicate or conflicting frames and every coding process except baseline', () => {
    const input = good();
    const frame = findMarker(input, 0xc0);
    rejected(splice(input, frame, 0, sof(0xc0, W, H)));
    rejected(splice(input, frame, 0, sof(0xc2, W, H)));
    rejected(good({ mode: 'progressive' }));
    rejected(good({ mode: 'extended' }));
    for (const marker of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      const patched = input.slice();
      patched[frame + 1] = marker;
      rejected(patched);
    }
    for (const marker of [0xde, 0xdf, 0xdc]) rejected(splice(input, frame, 0, segment(marker, 4)));
  });

  it('refuses the wrong size, oversized frames and restart intervals', () => {
    rejected(flatJpeg({ width: 1024, height: 1024 }));
    rejected(flatJpeg({ width: 1280, height: 1024 }));
    const input = good();
    const frame = findMarker(input, 0xc0);
    const huge = input.slice();
    huge.set([0xff, 0xff, 0xff, 0xff], frame + 5);
    rejected(huge);
    rejected(good({ mode: 'restart', restartInterval: 8 }));
  });

  it('refuses malformed tables and scans', () => {
    const input = good();
    const dqt = findMarker(input, 0xdb);
    const zeroQuant = input.slice();
    zeroQuant[dqt + 5] = 0;
    rejected(zeroQuant);
    const dht = findMarker(input, 0xc4);
    const badHuffman = input.slice();
    badHuffman[dht + 4] = 0x25;
    rejected(badHuffman);
    const sos = findMarker(input, 0xda);
    const sosLength = input[sos + 2]! * 256 + input[sos + 3]!;
    // Truncated entropy data, a stray restart marker inside it and a wrong block count.
    rejected(joinBytes(input.subarray(0, sos + 2 + sosLength + 50), new Uint8Array([0xff, 0xd9])));
    rejected(splice(input, sos + 2 + sosLength + 40, 0, new Uint8Array([0xff, 0xd0])));
    const small = flatJpeg({ width: 1024, height: 1264 });
    const smallScan = findMarker(small, 0xda);
    rejected(joinBytes(input.subarray(0, sos), small.subarray(smallScan)));
    // A second scan of the same components.
    rejected(beforeEoi(input, input.subarray(sos, input.length - 2)));
    // A segment length that runs past the end.
    const overrun = input.slice();
    overrun[dqt + 2] = 0xff;
    rejected(overrun);
  });

  it('refuses stray markers, trailing data and anything that is not a JPEG', () => {
    const input = good();
    rejected(joinBytes(input, new Uint8Array([0])));
    rejected(joinBytes(input, new Uint8Array([0xff, 0xd9])));
    rejected(beforeEoi(input, segment(0xfe)));
    rejected(splice(input, 2, 0, new Uint8Array([0xff, 0xd8])));
    rejected(new Uint8Array(0));
    rejected(new Uint8Array([0xff, 0xd8]));
    rejected(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    rejected(joinBytes(text('RIFF'), new Uint8Array([0, 0, 0, 0]), text('WEBPVP8 ')));
  });

  it('enforces the segment budget, the raw cap and the accepted-size cap', () => {
    rejected(good({ segments: Array.from({ length: 520 }, () => segment(0xfe, 1)) }));
    rejected(new Uint8Array(PROVIDER_JPEG.rawBytes + 1));
    // Kept tables (not metadata) that push the stored bytes over 512,000.
    const table = new Uint8Array([0x00, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const repeated = new Uint8Array(table.length * 2200);
    for (let index = 0; index < 2200; index++) repeated.set(table, index * table.length);
    const big = good({ segments: Array.from({ length: 8 }, () => jpegSegment(0xc4, repeated)) });
    expect(big.length).toBeGreaterThan(PROVIDER_JPEG.acceptedBytes);
    expect(inspectRestoreJpeg(big, W, H, { bytes: PROVIDER_JPEG.rawBytes, side: 1600 }).kind).toBe('preserve');
    let failure: unknown;
    try { admitProviderJpeg(big); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'tooLarge' });
    expect(findMarkers(big, 0xc4).length).toBe(10);
  });

  it('decodes only canonical base64 within the bounded size', () => {
    const input = good();
    let binary = '';
    for (const byte of input) binary += String.fromCharCode(byte);
    expect(decodeProviderBase64(btoa(binary))).toEqual(input);
    for (const value of [null, 42, '', 'abc', 'ab$=', 'YQ==YQ==', ' YWJj']) expect(() => decodeProviderBase64(value)).toThrow(ImagePreparationError);
    const oversized = 'A'.repeat(Math.ceil((PROVIDER_JPEG.rawBytes + 3) / 3) * 4);
    expect(() => decodeProviderBase64(oversized)).toThrow(expect.objectContaining({ code: 'tooLarge' }));
  });
});
