// BG2b (H1): the one strict admission profile for a generated photo, shared by the Edge function and the browser.
// Nothing is decoded and nothing is re-encoded: the whole stream is walked by inspectRestoreJpeg, provider metadata
// (APP1-APP15, COM, a non-canonical APP0) before the scan is removed, and the result must be the app's own
// byte-preservable baseline profile at exactly the requested size. Anything else is refused.
import { ImagePreparationError, JPEG_LIMITS } from './jpeg.ts';
import { inspectRestoreJpeg } from './restore-jpeg.ts';

export const PROVIDER_JPEG = Object.freeze({
  width: 1024,
  height: 1280,
  /** Decoded provider bytes before stripping; the Edge response read uses the same cap. */
  rawBytes: 4 * 1024 * 1024,
  /** The item_images main cap. */
  acceptedBytes: JPEG_LIMITS.mainBytes,
});

function fail(code: 'invalid' | 'tooLarge' | 'unsupported' = 'invalid'): never {
  throw new ImagePreparationError(code);
}

const isCanonicalJfif = (bytes: Uint8Array, start: number, end: number) => end - start === 14
  && [0x4a, 0x46, 0x49, 0x46, 0].every((value, index) => bytes[start + index] === value)
  && bytes[end - 2] === 0 && bytes[end - 1] === 0;

/**
 * Decodes the provider's base64 image. The decoded size is bounded from the text length before any decoding, and only
 * canonical standard base64 is accepted.
 */
export function decodeProviderBase64(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) fail();
  if (text.length / 4 * 3 > PROVIDER_JPEG.rawBytes + 2) fail('tooLarge');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail();
  const binary = atob(text);
  if (binary.length > PROVIDER_JPEG.rawBytes) fail('tooLarge');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Removes metadata segments before the first scan and keeps every other byte as it is. The input has already passed
// the full structural walk, so every segment length is inside the buffer and the first scan exists.
function stripProviderMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2, keptSegments = 0, total = 2;
  for (;;) {
    if (offset + 4 > bytes.length || bytes[offset] !== 0xff) fail();
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) fail();
    if (marker === 0xda) {
      const rest = bytes.subarray(offset);
      kept.push(rest);
      total += rest.length;
      break;
    }
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) fail();
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe
      || (marker === 0xe0 && (keptSegments > 0 || !isCanonicalJfif(bytes, offset + 4, end)));
    if (!drop) {
      kept.push(bytes.subarray(offset, end));
      total += end - offset;
      keptSegments++;
    }
    offset = end;
  }
  const result = new Uint8Array(total);
  let at = 0;
  for (const part of kept) { result.set(part, at); at += part.length; }
  return result;
}

export type AdmittedProviderJpeg = { bytes: Uint8Array<ArrayBuffer>; width: number; height: number; stripped: boolean };

/**
 * Admits one generated photo. Throws ImagePreparationError for anything that is not exactly one baseline frame of
 * 1024x1280 with one complete scan and nothing after EOI, for a second or conflicting frame, an unsupported coding
 * process, malformed tables or scans, a segment or scan budget overrun, and for a result over 512,000 bytes.
 * The returned bytes are the accepted bytes: hash them unchanged.
 */
export function admitProviderJpeg(input: Uint8Array): AdmittedProviderJpeg {
  const { width, height, rawBytes, acceptedBytes } = PROVIDER_JPEG;
  if (input.length > rawBytes) fail('tooLarge');
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) fail('unsupported');
  // The whole stream, before stripping: one frame, every table and the one scan, nothing after EOI.
  inspectRestoreJpeg(input, width, height, { bytes: rawBytes, side: Math.max(width, height) });
  const bytes = stripProviderMetadata(input);
  if (bytes.length > acceptedBytes) fail('tooLarge');
  // Re-run on the exact bytes that will be stored: only the preserved baseline profile is admitted.
  if (inspectRestoreJpeg(bytes, width, height, { bytes: acceptedBytes, side: Math.max(width, height) }).kind !== 'preserve') {
    fail('unsupported');
  }
  return { bytes, width, height, stripped: bytes.length !== input.length };
}
