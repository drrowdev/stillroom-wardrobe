export type ImagePreparationErrorCode = 'unsupported' | 'tooLarge' | 'invalid' | 'unavailable';

export class ImagePreparationError extends Error {
  readonly code: ImagePreparationErrorCode;

  constructor(code: ImagePreparationErrorCode) {
    super(code);
    this.name = 'ImagePreparationError';
    this.code = code;
  }
}

export const JPEG_LIMITS = Object.freeze({
  sourceBytes: 20 * 1024 * 1024,
  sourcePixels: 40_000_000,
  headerBytes: 1024 * 1024,
  headerSegments: 4096,
  mainSide: 1600,
  mainBytes: 512_000,
  thumbSide: 320,
  thumbBytes: 61_440,
});

export type JpegHeader = { width: number; height: number; orientation: number };
type Segment = { marker: number; start: number; end: number };

function invalid(): never {
  throw new ImagePreparationError('invalid');
}

function requireBytes(bytes: Uint8Array, end: number, bounded: boolean): void {
  if (bounded && end > JPEG_LIMITS.headerBytes) {
    throw new ImagePreparationError('tooLarge');
  }
  if (end > bytes.length) invalid();
}

function readSegment(bytes: Uint8Array, offset: number, bounded: boolean): Segment {
  requireBytes(bytes, offset + 2, bounded);
  if (bytes[offset] !== 0xff) invalid();
  do {
    offset += 1;
    requireBytes(bytes, offset + 1, bounded);
  } while (bytes[offset] === 0xff);
  const marker = bytes[offset]!;
  if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
    invalid();
  }
  if (marker === 0xd9) return { marker, start: offset + 1, end: offset + 1 };
  requireBytes(bytes, offset + 3, bounded);
  const length = bytes[offset + 1]! * 256 + bytes[offset + 2]!;
  if (length < 2) invalid();
  const end = offset + 1 + length;
  requireBytes(bytes, end, bounded);
  return { marker, start: offset + 3, end };
}

function startsWith(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function exifOrientation(bytes: Uint8Array, segment: Segment): number | undefined {
  if (!startsWith(bytes.subarray(0, segment.end), segment.start, [69, 120, 105, 102, 0, 0])) {
    return undefined;
  }
  const start = segment.start + 6;
  if (segment.end - start < 8) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, segment.end - start);
  const byteOrder = view.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) invalid();
  const littleEndian = byteOrder === 0x4949;
  if (view.getUint16(2, littleEndian) !== 42) invalid();
  const offset = view.getUint32(4, littleEndian);
  if (offset < 8 || offset + 2 > view.byteLength) invalid();
  const count = view.getUint16(offset, littleEndian);
  if (offset + 2 + count * 12 + 4 > view.byteLength) invalid();
  let orientation: number | undefined;
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 2 + index * 12;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
    if (orientation !== undefined || view.getUint16(entry + 2, littleEndian) !== 3 ||
        view.getUint32(entry + 4, littleEndian) !== 1) invalid();
    orientation = view.getUint16(entry + 8, littleEndian);
    if (orientation < 1 || orientation > 8) invalid();
  }
  return orientation;
}

function isFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function parseHeader(bytes: Uint8Array): JpegHeader & { scanStart: number } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ImagePreparationError('unsupported');
  }
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let orientation: number | undefined;
  const components = new Set<number>();
  for (let index = 0; index < JPEG_LIMITS.headerSegments; index += 1) {
    const segment = readSegment(bytes, offset, true);
    const { marker, start, end } = segment;
    if (marker === 0xd9) invalid();
    if (isFrame(marker)) {
      if (dimensions || end - start < 6) invalid();
      const height = bytes[start + 1]! * 256 + bytes[start + 2]!;
      const width = bytes[start + 3]! * 256 + bytes[start + 4]!;
      if (!width || !height) invalid();
      if (width * height > JPEG_LIMITS.sourcePixels) {
        throw new ImagePreparationError('tooLarge');
      }
      if (![0xc0, 0xc1, 0xc2].includes(marker) || bytes[start] !== 8) {
        throw new ImagePreparationError('unsupported');
      }
      const count = bytes[start + 5]!;
      if (![1, 3, 4].includes(count) || end - start !== 6 + 3 * count) invalid();
      for (let component = start + 6; component < end; component += 3) {
        const id = bytes[component]!;
        const sampling = bytes[component + 1]!;
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 ||
            !(sampling & 15) || (sampling & 15) > 4 || bytes[component + 2]! > 3) invalid();
        components.add(id);
      }
      dimensions = { width, height };
    }
    if (marker === 0xe1) {
      const found = exifOrientation(bytes, segment);
      if (found !== undefined) {
        if (orientation !== undefined) invalid();
        orientation = found;
      }
    }
    if (marker === 0xda) {
      if (!dimensions || end - start < 4) invalid();
      const count = bytes[start]!;
      if (!count || count > components.size || end - start !== 4 + 2 * count) invalid();
      const selected = new Set<number>();
      for (let component = start + 1; component < end - 3; component += 2) {
        const id = bytes[component]!;
        const table = bytes[component + 1]!;
        if (!components.has(id) || selected.has(id) || (table >> 4) > 3 || (table & 15) > 3) {
          invalid();
        }
        selected.add(id);
      }
      return { ...dimensions, orientation: orientation ?? 1, scanStart: end };
    }
    offset = end;
  }
  throw new ImagePreparationError('tooLarge');
}

/** Inspects at most one MiB of headers, without decoding or allocating image pixels. */
export function readJpegHeader(bytes: Uint8Array): JpegHeader {
  const { width, height, orientation } = parseHeader(bytes);
  return { width, height, orientation };
}

/** Only for fresh sRGB canvas encodings: omit the browser's generated ICC profile. */
export function stripEncoderColorProfile(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  parseHeader(bytes);
  const parts: Uint8Array[] = [];
  let offset = 2;
  let retainedStart = 0;
  while (offset < bytes.length) {
    const segment = readSegment(bytes, offset, true);
    if (segment.marker === 0xda) break;
    if (segment.marker === 0xe2 &&
        startsWith(bytes.subarray(0, segment.end), segment.start, [73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0])) {
      parts.push(bytes.subarray(retainedStart, offset));
      retainedStart = segment.end;
    }
    offset = segment.end;
  }
  parts.push(bytes.subarray(retainedStart));
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let position = 0;
  for (const part of parts) {
    result.set(part, position);
    position += part.length;
  }
  return result;
}

/** Checks all scans, not just metadata before the first SOS marker. */
export function assertSanitizedJpeg(bytes: Uint8Array, width: number, height: number): void {
  const header = parseHeader(bytes);
  if (header.width !== width || header.height !== height) invalid();
  let offset = 2;
  let inScan = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (inScan) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const start = offset;
        do { offset += 1; } while (bytes[offset] === 0xff);
        if (offset >= bytes.length) invalid();
        const marker = bytes[offset]!;
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset = start;
        break;
      }
      inScan = false;
    }
    const segment = readSegment(bytes, offset, false);
    const { marker, start, end } = segment;
    if (marker === 0xd9) {
      if (!sawScan || end !== bytes.length) invalid();
      return;
    }
    if (marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)) {
      // A fresh encoder may emit JFIF, but no arbitrary APP data or embedded thumbnail.
      if (marker !== 0xe0 || end - start !== 14 ||
          !startsWith(bytes, start, [74, 70, 73, 70, 0]) ||
          bytes[end - 2] !== 0 || bytes[end - 1] !== 0) invalid();
    }
    if (marker === 0xda) {
      inScan = true;
      sawScan = true;
    }
    offset = end;
  }
  invalid();
}

export function fitDimensions(width: number, height: number, longestSide: number): {
  width: number; height: number;
} {
  if (![width, height, longestSide].every((value) => Number.isSafeInteger(value) && value > 0)) {
    invalid();
  }
  const scale = Math.min(1, longestSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
