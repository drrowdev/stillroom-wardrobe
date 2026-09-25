import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitDimensions, ImagePreparationError, JPEG_LIMITS } from '../../src/images/jpeg';
import { inspectRestoreJpeg, RESTORE_JPEG_BUDGET } from '../../src/images/restore-jpeg';
import { planRestorePhoto, type RestorePhotoDeps } from '../../src/images/restore-photo';
import { verifyStoredImage } from '../../supabase/functions/finalize-analyzed-item/verify-image';
import { exifSegment, joinBytes, jpegSegment } from '../fixtures/jpeg-helpers';
import { findMarker, findMarkers, flatJpeg } from '../fixtures/restore-jpeg-fixtures';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (value: string) => new TextEncoder().encode(value);
const insertAt = (bytes: Uint8Array, offset: number, ...parts: Uint8Array[]) =>
  joinBytes(bytes.subarray(0, offset), ...parts, bytes.subarray(offset));
const beforeEoi = (bytes: Uint8Array, ...parts: Uint8Array[]) => insertAt(bytes, bytes.length - 2, ...parts);
const afterSoi = (bytes: Uint8Array, ...parts: Uint8Array[]) => insertAt(bytes, 2, ...parts);
const setU16 = (bytes: Uint8Array, offset: number, value: number) => { bytes[offset] = value >> 8; bytes[offset + 1] = value & 0xff; };
const code = (run: () => unknown) => {
  try { run(); } catch (error) { return error instanceof ImagePreparationError ? error.code : 'other'; }
  return 'accepted';
};
const inspect = (bytes: Uint8Array, width: number, height: number) => code(() => inspectRestoreJpeg(bytes, width, height));

const base = flatJpeg({ width: 1200, height: 900 });
const icc = jpegSegment(0xe2, joinBytes(text('ICC_PROFILE\0'), new Uint8Array([1, 1, 0, 0])));
const mpf = jpegSegment(0xe2, joinBytes(text('MPF\0'), new Uint8Array(12)));

describe('restore JPEG profile (Q6, A1)', () => {
  it('keeps the app encoder profile byte for byte, for colour, grey and uneven sizes', () => {
    for (const [bytes, width, height] of [
      [base, 1200, 900], [flatJpeg({ width: 17, height: 9, colour: [90] }), 17, 9],
      [flatJpeg({ width: 33, height: 65, sampling: [[1, 1], [1, 1], [1, 1]] }), 33, 65],
      [flatJpeg({ width: 250, height: 31, sampling: [[2, 1], [1, 1], [1, 1]] }), 250, 31],
      [flatJpeg({ width: 40, height: 40, jfif: false }), 40, 40],
      [flatJpeg({ width: 40, height: 40, tableId: 1 }), 40, 40],
    ] as const) expect(inspectRestoreJpeg(bytes, width, height)).toEqual({ kind: 'preserve' });
  });

  it('is deterministic', () => {
    const verdicts = Array.from({ length: 3 }, () => inspectRestoreJpeg(base, 1200, 900));
    expect(new Set(verdicts.map(verdict => JSON.stringify(verdict))).size).toBe(1);
  });

  it('re-encodes metadata it can read safely: EXIF, XMP, ICC, MPF, comments and other APP segments', () => {
    const cases = [
      afterSoi(base.subarray(0), exifSegment(1)).subarray(0),
      flatJpeg({ width: 1200, height: 900, segments: [exifSegment(1)] }),
      flatJpeg({ width: 1200, height: 900, segments: [jpegSegment(0xe1, text('http://ns.adobe.com/xap/1.0/\0<x/>'))] }),
      flatJpeg({ width: 1200, height: 900, segments: [icc] }),
      flatJpeg({ width: 1200, height: 900, segments: [mpf] }),
      flatJpeg({ width: 1200, height: 900, segments: [jpegSegment(0xfe, text('comment'))] }),
      flatJpeg({ width: 1200, height: 900, segments: [jpegSegment(0xed, text('Photoshop 3.0\0'))] }),
      // A second APP0, JFXX, JFIF with an embedded thumbnail, and JFIF that is not first.
      flatJpeg({ width: 1200, height: 900, segments: [jpegSegment(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'))] }),
      flatJpeg({ width: 1200, height: 900, jfif: false, segments: [jpegSegment(0xe0, text('JFXX\0\x10'))] }),
      flatJpeg({ width: 1200, height: 900, jfif: false, segments: [jpegSegment(0xe0, joinBytes(text('JFIF\0'), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 1, 1]), new Uint8Array(3)))] }),
      flatJpeg({ width: 1200, height: 900, jfif: false, segments: [jpegSegment(0xfe, text('x')), jpegSegment(0xe0, text('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'))] }),
    ];
    for (const bytes of cases) expect(inspectRestoreJpeg(bytes, 1200, 900)).toEqual({ kind: 'reencode', reason: 'metadata' });
  });

  it('re-encodes other encodings that parse safely: progressive, restart markers, extended, 16-bit tables, high table IDs', () => {
    for (const bytes of [
      flatJpeg({ width: 1200, height: 900, mode: 'progressive' }),
      flatJpeg({ width: 1200, height: 900, mode: 'restart', restartInterval: 3 }),
      flatJpeg({ width: 1200, height: 900, mode: 'extended' }),
      flatJpeg({ width: 1200, height: 900, dqt16: true }),
      flatJpeg({ width: 1200, height: 900, tableId: 2 }),
    ]) expect(inspectRestoreJpeg(bytes, 1200, 900)).toEqual({ kind: 'reencode', reason: 'encoding' });
    // Metadata is reported first when both apply.
    expect(inspectRestoreJpeg(flatJpeg({ width: 64, height: 48, mode: 'progressive', segments: [exifSegment(1)] }), 64, 48))
      .toEqual({ kind: 'reencode', reason: 'metadata' });
  });

  it('re-encodes anything between the counted scan and EOI, legal fill bytes and four-component frames', () => {
    const small = flatJpeg({ width: 16, height: 16 });
    const reencode = { kind: 'reencode', reason: 'encoding' };
    // An unused but valid table after the scan decodes the same, but is not the app's output.
    const unusedTable = beforeEoi(small, jpegSegment(0xc4, new Uint8Array([0, 0, 0, 0, 12, ...new Array<number>(12).fill(0), 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])));
    expect(inspectRestoreJpeg(unusedTable, 16, 16)).toEqual(reencode);
    expect(inspectRestoreJpeg(beforeEoi(small, new Uint8Array([0xff, 0xff])), 16, 16)).toEqual(reencode);
    expect(inspectRestoreJpeg(afterSoi(base, new Uint8Array([0xff])), 1200, 900)).toEqual(reencode);
    expect(inspectRestoreJpeg(insertAt(base, findMarker(base, 0xda), new Uint8Array([0xff, 0xff, 0xff])), 1200, 900)).toEqual(reencode);
    const progressive = flatJpeg({ width: 64, height: 48, mode: 'progressive' });
    expect(inspectRestoreJpeg(insertAt(progressive, findMarkers(progressive, 0xda)[2]!, new Uint8Array([0xff])), 64, 48)).toEqual(reencode);
    const cmyk = flatJpeg({ width: 40, height: 24, colour: [10, 200, 30, 90], sampling: [[1, 1], [1, 1], [1, 1], [1, 1]] });
    expect(inspectRestoreJpeg(cmyk, 40, 24)).toEqual(reencode);
    // Fill is bounded for the whole file, and still never allowed inside the counted blocks.
    const tooMuch = new Uint8Array(RESTORE_JPEG_BUDGET.fill + 1).fill(0xff);
    expect(inspect(afterSoi(base, tooMuch), 1200, 900)).toBe('tooLarge');
    expect(inspect(beforeEoi(small, tooMuch), 16, 16)).toBe('tooLarge');
    const scan = findMarker(small, 0xda) + 14;
    expect(inspect(insertAt(small, scan + 1, new Uint8Array([0xff])), 16, 16)).toBe('invalid');
  });

  it('refuses dimensions that differ from the backup, or are empty or too large', () => {
    expect(inspect(base, 900, 1200)).toBe('invalid');
    expect(inspect(base, 1200, 901)).toBe('invalid');
    const empty = base.slice();
    setU16(empty, findMarker(empty, 0xc0) + 5, 0);
    expect(inspect(empty, 1200, 0)).toBe('invalid');
    expect(inspect(flatJpeg({ width: 1601, height: 8 }), 1601, 8)).toBe('tooLarge');
  });

  it('refuses oversized input before reading it, and anything that is not a single complete JPEG', () => {
    expect(inspect(new Uint8Array(JPEG_LIMITS.mainBytes + 1), 1200, 900)).toBe('tooLarge');
    expect(inspect(base.subarray(2), 1200, 900)).toBe('invalid');
    expect(inspect(base.subarray(0, base.length - 1), 1200, 900)).toBe('invalid');
    expect(inspect(base.subarray(0, base.length - 20), 1200, 900)).toBe('invalid');
    // Anything after EOI, including an MPF second image.
    expect(inspect(joinBytes(base, new Uint8Array([0])), 1200, 900)).toBe('invalid');
    const mpfImage = flatJpeg({ width: 1200, height: 900, segments: [mpf] });
    expect(inspect(joinBytes(mpfImage, flatJpeg({ width: 160, height: 120 })), 1200, 900)).toBe('invalid');
  });

  it('refuses extra or missing entropy data in the counted scan', () => {
    const small = flatJpeg({ width: 16, height: 16 });
    expect(inspect(small, 16, 16)).toBe('accepted');
    expect(inspect(beforeEoi(small, new Uint8Array([0x12])), 16, 16)).toBe('invalid');
    expect(inspect(beforeEoi(small, new Uint8Array([0x00, 0x00])), 16, 16)).toBe('invalid');
    // A restart marker without a restart interval, and a stray marker inside the scan.
    expect(inspect(beforeEoi(small, new Uint8Array([0xff, 0xd3])), 16, 16)).toBe('unsupported');
    // Frames that claim more, or fewer, blocks than the scan holds.
    const grid = flatJpeg({ width: 32, height: 32 });
    expect(inspect(grid, 32, 32)).toBe('accepted');
    for (const height of [48, 16]) {
      const changed = grid.slice();
      setU16(changed, findMarker(changed, 0xc0) + 5, height);
      expect(inspect(changed, 32, height)).toBe('invalid');
    }
    // Padding bits that are not all ones.
    const padded = flatJpeg({ width: 8, height: 8, colour: [128] });
    const eoi = padded.length - 2;
    const cleared = padded.slice();
    cleared[eoi - 1] = cleared[eoi - 1]! & 0xfe;
    expect(inspect(padded, 8, 8)).toBe('accepted');
    expect(inspect(cleared, 8, 8)).toBe('invalid');
  });

  it('refuses malformed tables and segments', () => {
    const replaceSegment = (marker: number, payload: Uint8Array) => {
      const offset = findMarker(base, marker);
      const length = base[offset + 2]! * 256 + base[offset + 3]!;
      return joinBytes(base.subarray(0, offset), jpegSegment(marker, payload), base.subarray(offset + 2 + length));
    };
    const quant = (first: number, fill: number) => new Uint8Array([first, ...new Array<number>(64).fill(fill)]);
    const cases: [string, Uint8Array][] = [
      ['empty DQT', replaceSegment(0xdb, new Uint8Array(0))],
      ['DQT zero value', replaceSegment(0xdb, quant(0, 0))],
      ['DQT table 4', replaceSegment(0xdb, quant(4, 8))],
      ['DQT precision 2', replaceSegment(0xdb, quant(0x20, 8))],
      ['short DQT', replaceSegment(0xdb, new Uint8Array([0, 8, 8]))],
      ['empty DHT', replaceSegment(0xc4, new Uint8Array(0))],
      ['DHT no codes', replaceSegment(0xc4, new Uint8Array([0, ...new Array<number>(16).fill(0)]))],
      ['DHT DC symbol 12', replaceSegment(0xc4, new Uint8Array([0, 1, ...new Array<number>(15).fill(0), 12]))],
      ['DHT overfull', replaceSegment(0xc4, new Uint8Array([0, 3, ...new Array<number>(15).fill(0), 0, 1, 2]))],
      ['DHT class 2', replaceSegment(0xc4, new Uint8Array([0x20, 1, ...new Array<number>(15).fill(0), 0]))],
      ['oversized DRI', afterSoi(base, jpegSegment(0xdd, new Uint8Array([0, 1, 0])))],
      ['second SOF', beforeEoi(base.subarray(0, base.length), jpegSegment(0xc0, new Uint8Array([8, 0, 8, 0, 8, 1, 1, 0x11, 0])))],
      ['SOF before SOF', afterSoi(base, jpegSegment(0xc0, new Uint8Array([8, 3, 132, 4, 176, 1, 1, 0x11, 0])))],
      ['bad length', afterSoi(base, new Uint8Array([0xff, 0xfe, 0, 1]))],
      ['segment past end', joinBytes(base.subarray(0, 2), new Uint8Array([0xff, 0xfe, 0xff, 0xff]))],
    ];
    for (const [name, bytes] of cases) expect([name, inspect(bytes, 1200, 900)]).not.toEqual([name, 'accepted']);
    const frame = (count: number, components: number[], precision = 8, marker = 0xc0) => {
      const offset = findMarker(base, 0xc0);
      const length = base[offset + 2]! * 256 + base[offset + 3]!;
      return joinBytes(base.subarray(0, offset), jpegSegment(marker, new Uint8Array([precision, 3, 132, 4, 176, count, ...components])),
        base.subarray(offset + 2 + length));
    };
    expect(inspect(frame(3, [1, 0x22, 0, 1, 0x11, 0, 3, 0x11, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(frame(3, [1, 0x52, 0, 2, 0x11, 0, 3, 0x11, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(frame(3, [1, 0x44, 0, 2, 0x11, 0, 3, 0x11, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(frame(2, [1, 0x11, 0, 2, 0x11, 0]), 1200, 900)).toBe('unsupported');
    expect(inspect(frame(3, [1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0], 12), 1200, 900)).toBe('unsupported');
    expect(inspect(frame(3, [1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0], 8, 0xc3), 1200, 900)).toBe('unsupported');
    expect(inspect(frame(3, [1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0], 8, 0xc9), 1200, 900)).toBe('unsupported');
    for (const marker of [0xdc, 0xde, 0xdf, 0xc8, 0xcc, 0xf0, 0x01]) {
      expect(inspect(afterSoi(base, jpegSegment(marker, new Uint8Array([0, 0]))), 1200, 900)).toBe('unsupported');
    }
  });

  it('refuses scans that do not match the frame or tables', () => {
    const offset = findMarker(base, 0xda);
    const scan = (payload: number[]) => joinBytes(base.subarray(0, offset), jpegSegment(0xda, new Uint8Array(payload)), base.subarray(offset + 14));
    expect(inspect(scan([3, 1, 0, 2, 0, 3, 0, 0, 63, 0]), 1200, 900)).toBe('accepted');
    expect(inspect(scan([3, 2, 0, 1, 0, 3, 0, 0, 63, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(scan([3, 1, 0, 1, 0, 3, 0, 0, 63, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(scan([3, 1, 0x33, 2, 0, 3, 0, 0, 63, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(scan([3, 1, 0, 2, 0, 3, 0, 0, 62, 0]), 1200, 900)).toBe('invalid');
    expect(inspect(scan([3, 1, 0, 2, 0, 9, 0, 0, 63, 0]), 1200, 900)).toBe('invalid');
    // A scan before any frame.
    expect(inspect(afterSoi(base, jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]))), 1200, 900)).toBe('invalid');
  });

  it('refuses metadata or tables between scans, too many scans and too many segments', () => {
    const progressive = flatJpeg({ width: 64, height: 48, mode: 'progressive' });
    const scans = findMarkers(progressive, 0xda);
    expect(scans).toHaveLength(4);
    const second = scans[1]!;
    expect(inspect(progressive, 64, 48)).toBe('accepted');
    expect(inspect(insertAt(progressive, second, exifSegment(1)), 64, 48)).toBe('invalid');
    expect(inspect(insertAt(progressive, second, jpegSegment(0xfe, text('x'))), 64, 48)).toBe('invalid');
    expect(inspect(insertAt(progressive, second, jpegSegment(0xdb, new Uint8Array([0, ...new Array<number>(64).fill(8)]))), 64, 48)).toBe('invalid');
    const last = scans[3]!;
    const lastScan = progressive.subarray(last, progressive.length - 2);
    const many = beforeEoi(progressive, ...new Array<Uint8Array>(RESTORE_JPEG_BUDGET.scans).fill(lastScan));
    expect(inspect(many, 64, 48)).toBe('tooLarge');
    const comments = new Array<Uint8Array>(RESTORE_JPEG_BUDGET.segments).fill(jpegSegment(0xfe, text('x')));
    expect(inspect(flatJpeg({ width: 64, height: 48, segments: comments }), 64, 48)).toBe('tooLarge');
  });
});

describe('restore photo plan (Q6, A1-A2)', () => {
  const photo = (bytes: Uint8Array<ArrayBuffer>, width: number, height: number) =>
    ({ main: new Blob([bytes], { type: 'image/jpeg' }), thumb: new Blob([]), width, height, mainSha256: sha(bytes), thumbSha256: '' });
  const deps = (overrides: Partial<RestorePhotoDeps> = {}) => {
    const value = {
      decodedSize: vi.fn<RestorePhotoDeps['decodedSize']>(async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const offset = findMarker(bytes, 0xc0) >= 0 ? findMarker(bytes, 0xc0) : findMarker(bytes, 0xc2) >= 0 ? findMarker(bytes, 0xc2) : findMarker(bytes, 0xc1);
        return { width: bytes[offset + 7]! * 256 + bytes[offset + 8]!, height: bytes[offset + 5]! * 256 + bytes[offset + 6]! };
      }),
      reencode: vi.fn<RestorePhotoDeps['reencode']>(async blob => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const offset = findMarker(bytes, 0xc0) >= 0 ? findMarker(bytes, 0xc0) : findMarker(bytes, 0xc2) >= 0 ? findMarker(bytes, 0xc2) : findMarker(bytes, 0xc1);
        const width = bytes[offset + 7]! * 256 + bytes[offset + 8]!, height = bytes[offset + 5]! * 256 + bytes[offset + 6]!;
        return photo(flatJpeg({ width, height, colour: [100, 120, 140] }), width, height);
      }),
      thumbnail: vi.fn<RestorePhotoDeps['thumbnail']>(async (_main, width, height) => {
        const size = fitDimensions(width, height, JPEG_LIMITS.thumbSide);
        const bytes = flatJpeg({ ...size, colour: [60, 128, 128] });
        return { blob: new Blob([bytes], { type: 'image/jpeg' }), sha256: sha(bytes), ...size };
      }),
      ...overrides,
    };
    return value;
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps an in-profile photo unchanged and makes a new thumbnail from it', async () => {
    const d = deps();
    const { plan, photo: result } = await planRestorePhoto('img', base, 1200, 900, undefined, d);
    expect(new Uint8Array(await result.main.arrayBuffer())).toEqual(base);
    expect(plan).toMatchObject({ main: 'preserved', reason: null, sourceSha256: sha(base), mainSha256: sha(base), width: 1200, height: 900 });
    expect(d.reencode).not.toHaveBeenCalled();
    expect(d.thumbnail).toHaveBeenCalledWith(result.main, 1200, 900, undefined);
    expect(result.thumbSha256).toBe(plan.thumbSha256);
  });

  it('re-encodes a photo outside the profile at exactly the backup dimensions and checks the output', async () => {
    const source = flatJpeg({ width: 900, height: 1200, mode: 'progressive', segments: [exifSegment(1)] });
    const d = deps();
    const { plan, photo: result } = await planRestorePhoto('img', source, 900, 1200, undefined, d);
    expect(plan).toMatchObject({ main: 'reencoded', reason: 'metadata', sourceSha256: sha(source), width: 900, height: 1200 });
    expect(plan.mainSha256).toBe(sha(new Uint8Array(await result.main.arrayBuffer())));
    expect(d.thumbnail).toHaveBeenCalledWith(result.main, 900, 1200, undefined);
  });

  it('never starts a decoder for input refused by its structure', async () => {
    for (const [bytes, width, height] of [
      [beforeEoi(base, new Uint8Array([0x12])), 1200, 900], [base, 1199, 900],
      [joinBytes(base, new Uint8Array([1])), 1200, 900], [new Uint8Array(JPEG_LIMITS.mainBytes + 1), 1200, 900],
    ] as const) {
      const d = deps();
      await expect(planRestorePhoto('img', bytes, width, height, undefined, d)).rejects.toBeInstanceOf(ImagePreparationError);
      expect(d.decodedSize).not.toHaveBeenCalled();
      expect(d.reencode).not.toHaveBeenCalled();
      expect(d.thumbnail).not.toHaveBeenCalled();
    }
  });

  it('refuses a decoded size that differs from the frame, such as an orientation that turns a non-square photo', async () => {
    const turned = flatJpeg({ width: 1200, height: 900, segments: [exifSegment(6)] });
    const d = deps({ decodedSize: vi.fn(async () => ({ width: 900, height: 1200 })) });
    await expect(planRestorePhoto('img', turned, 1200, 900, undefined, d)).rejects.toMatchObject({ code: 'invalid' });
    expect(d.reencode).not.toHaveBeenCalled();
  });

  it('refuses re-encoded output that changes size, keeps metadata, is outside the profile or has another hash', async () => {
    const source = flatJpeg({ width: 1200, height: 900, mode: 'restart' });
    for (const output of [
      photo(flatJpeg({ width: 1020, height: 765 }), 1020, 765),
      { ...photo(flatJpeg({ width: 1200, height: 900 }), 1200, 900), width: 1020 },
      photo(flatJpeg({ width: 1200, height: 900, segments: [exifSegment(1)] }), 1200, 900),
      photo(flatJpeg({ width: 1200, height: 900, mode: 'progressive' }), 1200, 900),
      { ...photo(flatJpeg({ width: 1200, height: 900 }), 1200, 900), mainSha256: '0'.repeat(64) },
    ]) {
      const d = deps({ reencode: vi.fn(async () => output) });
      await expect(planRestorePhoto('img', source, 1200, 900, undefined, d)).rejects.toMatchObject({ code: 'invalid' });
      expect(d.thumbnail).not.toHaveBeenCalled();
    }
  });

  it('refuses a thumbnail with the wrong size, metadata or hash', async () => {
    const thumb = (bytes: Uint8Array<ArrayBuffer>, width: number, height: number, hash = sha(bytes)) =>
      vi.fn(async () => ({ blob: new Blob([bytes]), sha256: hash, width, height }));
    for (const thumbnail of [
      thumb(flatJpeg({ width: 320, height: 320 }), 320, 320),
      thumb(flatJpeg({ width: 320, height: 240, segments: [exifSegment(1)] }), 320, 240),
      thumb(flatJpeg({ width: 320, height: 240 }), 320, 240, '0'.repeat(64)),
    ]) await expect(planRestorePhoto('img', base, 1200, 900, undefined, deps({ thumbnail }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('passes on a browser that cannot process photos now as unavailable', async () => {
    const d = deps({ decodedSize: vi.fn(async () => { throw new ImagePreparationError('unavailable'); }) });
    await expect(planRestorePhoto('img', base, 1200, 900, undefined, d)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('produces files the server image check accepts, kept and re-encoded, on non-square photos', async () => {
    const owner = '10000000-0000-4000-8000-000000000001', item = '20000000-0000-4000-8000-000000000001', image = '30000000-0000-4000-8000-000000000001';
    for (const [source, width, height] of [
      [flatJpeg({ width: 1200, height: 900 }), 1200, 900],
      [flatJpeg({ width: 900, height: 1600, mode: 'progressive' }), 900, 1600],
    ] as const) {
      const { photo: result } = await planRestorePhoto('img', source, width, height, undefined, deps());
      const files = { main: new Uint8Array(await result.main.arrayBuffer()), thumb: new Uint8Array(await result.thumb.arrayBuffer()) };
      vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('/main.jpg') ? files.main : files.thumb,
        { headers: { 'Content-Type': 'image/jpeg' } })));
      const prefix = `${owner}/${item}/${image}`;
      await expect(verifyStoredImage({ id: image, owner_id: owner, item_id: item, state: 'pending', retired_at: null,
        main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, main_bytes: files.main.length, thumb_bytes: files.thumb.length,
        main_sha256: sha(files.main), thumb_sha256: sha(files.thumb), width, height, alt_text: 'x', created_at: '2026-09-27T00:00:00Z',
        description_version: 1 }, { ownerId: owner, itemId: item, imageId: image, state: 'pending' },
      { supabaseUrl: 'http://127.0.0.1:54321', publicKey: 'public-fixture', bearer: 'Bearer '.concat('fixture'), signal: new AbortController().signal }))
        .resolves.toBeUndefined();
      vi.unstubAllGlobals();
    }
  });
});
