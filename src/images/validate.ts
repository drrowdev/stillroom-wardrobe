import { ImagePreparationError, JPEG_LIMITS } from './jpeg';

type Range = { start: number; end: number };
export type ImageAdmission = {
  blob: Blob; width: number; height: number; orientation: number; format: 'png' | 'webp';
};
function fail(): never { throw new ImagePreparationError('invalid'); }
const unsupported = (): never => { throw new ImagePreparationError('unsupported'); };
const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const u32 = (bytes: Uint8Array, offset = 0, little = false) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, little);
const u24 = (bytes: Uint8Array, offset: number) => bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
export const WEBP_FLAGS = Object.freeze({ icc: 0x20, alpha: 0x10, exif: 0x08, xmp: 0x04, animation: 0x02 });

function dimensions(width: number, height: number) {
  if (!width || !height) fail();
  if (width * height > JPEG_LIMITS.sourcePixels) throw new ImagePreparationError('tooLarge');
  return { width, height };
}

function reader(blob: Blob, signal?: AbortSignal) {
  let total = 0;
  return async (start: number, length: number) => {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > blob.size) fail();
    total += length;
    if (total > JPEG_LIMITS.headerBytes) throw new ImagePreparationError('tooLarge');
    const bytes = new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.length !== length) fail();
    return bytes;
  };
}

/** New-format TIFF only; JPEG keeps its existing, independent parser. */
export function readTiffOrientation(input: Uint8Array, allowExifPrefix = false): number {
  let bytes = input;
  if (allowExifPrefix && text(input.subarray(0, 6)) === 'Exif\0\0') bytes = input.subarray(6);
  if (bytes.length < 8) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) fail();
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) fail();
  let offset = view.getUint32(4, little);
  if (offset < 8) fail();
  let orientation: number | undefined;
  const ranges: Range[] = [];
  const sizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  while (offset !== 0) {
    if (offset < 8 || offset + 2 > bytes.length || ranges.length >= JPEG_LIMITS.headerSegments) fail();
    const count = view.getUint16(offset, little);
    const end = offset + 2 + count * 12 + 4;
    if (end > bytes.length || ranges.some((range) => offset < range.end && end > range.start)) fail();
    ranges.push({ start: offset, end });
    for (let index = 0; index < count; index++) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const size = sizes[type];
      const length = view.getUint32(entry + 4, little) * (size ?? 0);
      if (!size || !length) fail();
      if (length > 4) {
        const valueOffset = view.getUint32(entry + 8, little);
        if (valueOffset < 8 || valueOffset + length > bytes.length) fail();
      }
      if (tag === 0x0112) {
        if (orientation !== undefined || ranges.length !== 1 || type !== 3 || length !== 2) fail();
        orientation = view.getUint16(entry + 8, little);
        if (orientation < 1 || orientation > 8) fail();
      }
    }
    offset = view.getUint32(end - 4, little);
  }
  return orientation ?? 1;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalize(blob: Blob, remove: Range, patches: { start: number; bytes: Uint8Array<ArrayBuffer> }[] = []): Blob {
  if (remove.start < 12 || remove.end <= remove.start || remove.end > blob.size
    || patches.length > 2 || patches.reduce((count, patch) => count + patch.bytes.length, 0) > 5) fail();
  const parts: BlobPart[] = [];
  let start = 0;
  for (const patch of patches) {
    if (patch.start < start || patch.start + patch.bytes.length > remove.start
      || !(patch.start === 4 && patch.bytes.length === 4 || patch.start === 20 && patch.bytes.length === 1)) fail();
    parts.push(blob.slice(start, patch.start), patch.bytes);
    start = patch.start + patch.bytes.length;
  }
  parts.push(blob.slice(start, remove.start), blob.slice(remove.end));
  const result = new Blob(parts, { type: blob.type });
  if (result.size !== blob.size - (remove.end - remove.start)) fail();
  return result;
}

async function png(blob: Blob, read: ReturnType<typeof reader>): Promise<ImageAdmission> {
  let offset = 8;
  let size: { width: number; height: number } | undefined;
  let colour = -1, depth = 0, palette = false, data = false, endedData = false;
  let orientation = 1;
  let exif: Range | undefined;
  const unique = new Set<string>();
  for (let count = 0; count < JPEG_LIMITS.headerSegments; count++) {
    const head = await read(offset, 8);
    const length = u32(head), kind = text(head.subarray(4));
    const end = offset + 12 + length;
    if (end > blob.size || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind)) fail();
    if (!size && kind !== 'IHDR') fail();
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) unsupported();
    if (['IHDR', 'PLTE', 'eXIf', 'tRNS', 'iCCP', 'sRGB', 'gAMA', 'cHRM'].includes(kind)) {
      if (unique.has(kind)) fail();
      unique.add(kind);
    }
    if (kind === 'IDAT') {
      if (endedData || colour === 3 && !palette) fail();
      data = true;
    } else {
      if (data) endedData = true;
      const contents = await read(offset + 8, length + 4);
      const payload = contents.subarray(0, length);
      const checked = new Uint8Array(4 + length);
      checked.set(head.subarray(4));
      checked.set(payload, 4);
      if (crc32(checked) !== u32(contents, length)) fail();
      if (kind === 'IHDR') {
        if (offset !== 8 || length !== 13) fail();
        size = dimensions(u32(payload), u32(payload, 4));
        depth = payload[8]!;
        colour = payload[9]!;
        const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!depths[colour]?.includes(depth) || payload[10] !== 0 || payload[11] !== 0 || payload[12]! > 1) fail();
      } else if (kind === 'PLTE') {
        if (data || [0, 4].includes(colour) || !length || length % 3 || length > 768 || colour === 3 && length / 3 > 2 ** depth) fail();
        palette = true;
      } else if (kind === 'tRNS') {
        if (data || !(colour === 0 && length === 2 || colour === 2 && length === 6 || colour === 3 && palette && length > 0 && length <= 256)) fail();
      } else if (kind === 'eXIf') {
        orientation = readTiffOrientation(payload);
        exif = { start: offset, end };
      } else if (kind === 'IEND') {
        if (length || !data || !size || end !== blob.size) fail();
        return { ...size, orientation, format: 'png', blob: orientation !== 1 && exif ? normalize(blob, exif) : blob };
      } else if (kind[0] === kind[0]!.toUpperCase()) unsupported();
    }
    offset = end;
  }
  throw new ImagePreparationError('tooLarge');
}

async function webp(blob: Blob, read: ReturnType<typeof reader>, header: Uint8Array): Promise<ImageAdmission> {
  if (u32(header, 4, true) !== blob.size - 8) fail();
  let offset = 12, flags = 0, orientation = 1;
  let canvas: { width: number; height: number } | undefined;
  let pixels: { width: number; height: number } | undefined;
  let pixelKind = '', losslessAlpha = false;
  let exif: Range | undefined;
  const seen = new Set<string>();
  for (let count = 0; offset < blob.size; count++) {
    if (count >= 64) throw new ImagePreparationError('tooLarge');
    const head = await read(offset, 8);
    const kind = text(head.subarray(0, 4)), length = u32(head, 4, true);
    const end = offset + 8 + length + (length % 2);
    if (end > blob.size || !/^[\x20-\x7e]{4}$/.test(kind)) fail();
    if (length % 2 && (await read(end - 1, 1))[0] !== 0) fail();
    if (['ANIM', 'ANMF'].includes(kind)) unsupported();
    if (['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) {
      if (seen.has(kind)) fail();
      seen.add(kind);
    }
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10) fail();
      const contents = await read(offset + 8, length);
      flags = contents[0]!;
      if (flags & WEBP_FLAGS.animation) unsupported();
      if (flags & 0xc1 || contents[1] || contents[2] || contents[3]) fail();
      canvas = dimensions(1 + u24(contents, 4), 1 + u24(contents, 7));
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (pixels || seen.has('EXIF') || seen.has('XMP ') || !length) fail();
      pixelKind = kind;
      if (kind === 'VP8 ') {
        if (length < 10) fail();
        const contents = await read(offset + 8, 10);
        if (contents[0]! & 1 || (contents[0]! >> 1 & 7) > 3 || !(contents[0]! & 16)
          || text(contents.subarray(3, 6)) !== '\x9d\x01\x2a') fail();
        pixels = dimensions((contents[6]! + contents[7]! * 256) & 0x3fff, (contents[8]! + contents[9]! * 256) & 0x3fff);
      } else {
        if (length < 5 || seen.has('ALPH')) fail();
        const contents = await read(offset + 8, 5);
        if (contents[0] !== 0x2f || contents[4]! >> 5) fail();
        const bits = u32(contents, 1, true);
        pixels = dimensions(1 + (bits & 0x3fff), 1 + (bits >>> 14 & 0x3fff));
        losslessAlpha = Boolean(bits & 0x10000000);
      }
      if (canvas && (canvas.width !== pixels.width || canvas.height !== pixels.height)) fail();
    } else {
      if (!canvas && ['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(kind)) fail();
      if (kind === 'ALPH') {
        if (pixels || !length) fail();
        const alpha = (await read(offset + 8, 1))[0]!;
        if (alpha & 0xc0 || (alpha & 3) > 1 || (alpha >> 4 & 3) > 1) fail();
      } else {
        const contents = await read(offset + 8, length);
        if (kind === 'ICCP' && (pixels || seen.has('ALPH') || !length)) fail();
        if ((kind === 'EXIF' || kind === 'XMP ') && !pixels) fail();
        if (kind === 'EXIF') {
          orientation = readTiffOrientation(contents, true);
          exif = { start: offset, end };
        }
      }
    }
    offset = end;
  }
  if (!pixels || offset !== blob.size || seen.has('ALPH') && pixelKind !== 'VP8 ') fail();
  if (canvas && (Boolean(flags & WEBP_FLAGS.icc) !== seen.has('ICCP')
    || Boolean(flags & WEBP_FLAGS.exif) !== seen.has('EXIF')
    || Boolean(flags & WEBP_FLAGS.xmp) !== seen.has('XMP ')
    || Boolean(flags & WEBP_FLAGS.alpha) !== (seen.has('ALPH') || losslessAlpha))) fail();
  let normalized = blob;
  if (orientation !== 1 && exif) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, blob.size - 8 - (exif.end - exif.start), true);
    normalized = normalize(blob, exif, [
      { start: 4, bytes: length }, { start: 20, bytes: new Uint8Array([flags & ~WEBP_FLAGS.exif]) },
    ]);
  }
  return { ...pixels, orientation, format: 'webp', blob: normalized };
}

export async function validateImage(blob: Blob, signal?: AbortSignal): Promise<ImageAdmission> {
  signal?.throwIfAborted();
  if (blob.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge');
  const read = reader(blob, signal);
  const header = await read(0, Math.min(12, blob.size));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)) return png(blob, read);
  if (text(header.subarray(0, 4)) === 'RIFF' && text(header.subarray(8, 12)) === 'WEBP') return webp(blob, read, header);
  return unsupported();
}
