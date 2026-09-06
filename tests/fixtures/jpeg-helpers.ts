export function joinBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = payload.length + 2;
  if (length > 65535) throw new Error('fixture segment limit');
  return joinBytes(new Uint8Array([0xff, marker, length >> 8, length & 255]), payload);
}

export function exifSegment(orientation: number, littleEndian = true): Uint8Array<ArrayBuffer> {
  const tiff = new Uint8Array(80);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 2, littleEndian);
  view.setUint16(10, 0x0112, littleEndian);
  view.setUint16(12, 3, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, orientation, littleEndian);
  view.setUint16(22, 0x8825, littleEndian);
  view.setUint16(24, 4, littleEndian);
  view.setUint32(26, 1, littleEndian);
  view.setUint32(30, 38, littleEndian);
  view.setUint16(38, 1, littleEndian);
  view.setUint16(40, 2, littleEndian);
  view.setUint16(42, 5, littleEndian);
  view.setUint32(44, 3, littleEndian);
  view.setUint32(48, 56, littleEndian);
  // Synthetic zero-degree latitude; no external fixtures or real location data.
  for (const offset of [60, 68, 76]) view.setUint32(offset, 1, littleEndian);
  return jpegSegment(0xe1, joinBytes(new Uint8Array([69, 120, 105, 102, 0, 0]), tiff));
}

export function jpegHeaderFixture(width = 120, height = 80, frame = 0xc0): Uint8Array<ArrayBuffer> {
  return joinBytes(
    new Uint8Array([0xff, 0xd8]),
    jpegSegment(frame, new Uint8Array([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0])),
    jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
    new Uint8Array([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]),
  );
}

export function insertSegments(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return joinBytes(jpeg.subarray(0, 2), ...segments, jpeg.subarray(2));
}

export async function addPrivateMetadata(jpeg: Blob, orientation: number, littleEndian = true): Promise<Blob> {
  const encoder = new TextEncoder();
  return new Blob([insertSegments(
    new Uint8Array(await jpeg.arrayBuffer()),
    exifSegment(orientation, littleEndian),
    jpegSegment(0xe1, encoder.encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS_PRIVATE_FIXTURE</x:xmpmeta>')),
    jpegSegment(0xed, encoder.encode('Photoshop 3.0\0IPTC_PRIVATE_FIXTURE')),
    jpegSegment(0xfe, encoder.encode('COMMENT_PRIVATE_FIXTURE')),
  )], { type: 'image/jpeg' });
}

export const CORNER_COLOURS = [
  [240, 30, 30], [30, 210, 50], [30, 70, 230], [230, 200, 20],
] as const;

export const ORIENTATION_CORNERS = [
  [0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1],
  [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2],
] as const;

export async function makeCanvasJpeg(width = 120, height = 80, dense = false): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fixture canvas unavailable');
    if (dense) {
      const image = context.createImageData(width, height);
      let state = 123456789;
      for (let index = 0; index < image.data.length; index += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          image.data[index + channel] = state & 255;
        }
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    } else {
      CORNER_COLOURS.forEach((colour, index) => {
        context.fillStyle = `rgb(${colour.join(',')})`;
        context.fillRect((index % 2) * width / 2, Math.floor(index / 2) * height / 2, width / 2, height / 2);
      });
    }
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('fixture encoding failed')), 'image/jpeg', 1);
    });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

export function listJpegMarkers(bytes: Uint8Array): number[] {
  const markers: number[] = [];
  let offset = 2;
  let entropy = false;
  while (offset < bytes.length) {
    if (entropy && bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    if (bytes[offset++] !== 0xff) throw new Error('fixture marker expected');
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined) throw new Error('fixture truncated marker');
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    markers.push(marker);
    if (marker === 0xd9) break;
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) throw new Error('fixture truncated segment');
    offset += length;
    entropy = marker === 0xda;
  }
  return markers;
}

export async function summarizeJpeg(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const image = new Image();
  const url = URL.createObjectURL(blob);
  const canvas = document.createElement('canvas');
  try {
    image.src = url;
    await image.decode();
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('fixture canvas unavailable');
    context.drawImage(image, 0, 0);
    const corners = [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) =>
      Array.from(context.getImageData(Math.floor(x! * canvas.width), Math.floor(y! * canvas.height), 1, 1).data).slice(0, 3),
    );
    const text = new TextDecoder('latin1').decode(bytes);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return {
      width: canvas.width, height: canvas.height, corners, size: blob.size, type: blob.type,
      markers: listJpegMarkers(bytes),
      hasPrivateText: ['Exif', 'xap/1.0', 'GPS_PRIVATE', 'IPTC_PRIVATE', 'COMMENT_PRIVATE'].some((textPart) => text.includes(textPart)),
      hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      hasFilename: 'name' in blob,
    };
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
    canvas.width = 1;
    canvas.height = 1;
  }
}
