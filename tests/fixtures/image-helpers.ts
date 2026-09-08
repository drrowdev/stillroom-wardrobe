import { joinBytes } from './jpeg-helpers';

export function tiff(orientation: number | null = 1, little = true, prefix = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(orientation === null ? 14 : 26);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, little ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, orientation === null ? 0 : 1, little);
  if (orientation !== null) {
    view.setUint16(10, 0x112, little);
    view.setUint16(12, 3, little);
    view.setUint32(14, 1, little);
    view.setUint16(18, orientation, little);
  }
  return prefix ? joinBytes(new TextEncoder().encode('Exif\0\0'), bytes) : bytes;
}

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngChunk(kind: string, payload = new Uint8Array()): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length);
  bytes.set(new TextEncoder().encode(kind), 4);
  bytes.set(payload, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

export function pngHeader(width = 120, height = 80): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  bytes.set([8, 6], 8);
  return pngChunk('IHDR', bytes);
}

export function webpChunk(kind: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + payload.length + payload.length % 2);
  bytes.set(new TextEncoder().encode(kind));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

export function riff(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = joinBytes(new TextEncoder().encode('RIFF\0\0\0\0WEBP'), ...chunks);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

export function vp8x(width: number, height: number, flags = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(10);
  bytes[0] = flags;
  for (const [offset, value] of [[4, width - 1], [7, height - 1]] as const) {
    bytes[offset] = value & 255;
    bytes[offset + 1] = value >> 8 & 255;
    bytes[offset + 2] = value >> 16 & 255;
  }
  return webpChunk('VP8X', bytes);
}

export function vp8l(width = 120, height = 80, alpha = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(5);
  bytes[0] = 0x2f;
  new DataView(bytes.buffer).setUint32(1, (width - 1) | (height - 1) << 14 | (alpha ? 0x10000000 : 0), true);
  return webpChunk('VP8L', bytes);
}

export async function withExif(blob: Blob, format: 'png' | 'webp', orientation: number, after = true): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') {
    const offset = after ? bytes.length - 12 : 33;
    return new Blob([bytes.subarray(0, offset), pngChunk('eXIf', tiff(orientation)), bytes.subarray(offset)], { type: 'image/png' });
  }
  const chunks: Uint8Array[] = [];
  let width = 0, height = 0, flags = 0;
  for (let offset = 12; offset < bytes.length;) {
    const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = new DataView(bytes.buffer).getUint32(offset + 4, true);
    const end = offset + 8 + length + length % 2;
    if (kind === 'VP8X') {
      const view = new DataView(bytes.buffer);
      flags = bytes[offset + 8]!;
      width = (view.getUint32(offset + 12, true) & 0xffffff) + 1;
      height = (bytes[offset + 15]! | bytes[offset + 16]! << 8 | bytes[offset + 17]! << 16) + 1;
    } else {
      chunks.push(bytes.subarray(offset, end));
      if (kind === 'VP8 ') {
        width = (bytes[offset + 14]! | bytes[offset + 15]! << 8) & 0x3fff;
        height = (bytes[offset + 16]! | bytes[offset + 17]! << 8) & 0x3fff;
      } else if (kind === 'VP8L') {
        const bits = new DataView(bytes.buffer).getUint32(offset + 9, true);
        width = 1 + (bits & 0x3fff); height = 1 + (bits >>> 14 & 0x3fff);
        if (bits & 0x10000000) flags |= 0x10;
      }
    }
    offset = end;
  }
  if (!width || !height || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') throw new Error('Not a WebP fixture');
  return new Blob([riff(vp8x(width, height, flags | 0x08), ...chunks, webpChunk('EXIF', tiff(orientation, true, true)))], { type: 'image/webp' });
}
