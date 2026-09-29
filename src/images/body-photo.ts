import { aspectPixelRect, rectGeometry, type PhotoEdit, type PixelRect } from './crop';
import { ImagePreparationError, JPEG_LIMITS, stripEncoderMetadata } from './jpeg';
import { abortable, checkAbort, decode, draw, releaseCanvas, type DecodedImage } from './process-jpeg';
import { admitter } from './process-image';
import { isPhotoInputJpeg } from './restore-jpeg';
import { TRYON_LIMITS } from '../domain/tryon';

/** VTO-2 body photo (rev4 §4.1): a fixed 4:5 crop of the oriented source, encoded to exactly 1024x1280. */
export const BODY_ASPECT = Object.freeze({ rw: 4, rh: 5 });
export const BODY_MIN_CROP = Object.freeze({ width: 512, height: 640 });
const QUALITIES = [0.92, 0.86, 0.8, 0.74, 0.68, 0.6] as const;

export type BodyPhotoErrorCode = 'small' | 'unusable' | 'unsupported' | 'invalid' | 'unavailable';
export class BodyPhotoError extends Error {
  readonly code: BodyPhotoErrorCode;
  constructor(code: BodyPhotoErrorCode) {
    super(code);
    this.name = 'BodyPhotoError';
    this.code = code;
  }
}

/** The admitted source: `width` x `height` are the oriented dimensions the crop editor and the encoder share. */
export type BodySource = { blob: Blob; width: number; height: number };
/** Only the encoded bytes and their hash are kept; nothing else of the source survives preparation. */
export type BodyPhoto = { bytes: Uint8Array<ArrayBuffer>; sha256: string };

const failure = (error: unknown, fallback: BodyPhotoErrorCode = 'invalid'): unknown => {
  if (error instanceof DOMException && error.name === 'AbortError') return error;
  if (error instanceof BodyPhotoError) return error;
  if (error instanceof ImagePreparationError) {
    return new BodyPhotoError(error.code === 'unsupported' ? 'unsupported' : error.code === 'unavailable' ? 'unavailable'
      : error.code === 'tooLarge' ? 'unusable' : 'invalid');
  }
  return new BodyPhotoError(fallback);
};

/** The existing source admission (type, byte caps and orientation header). Decoders apply the EXIF orientation. */
export async function admitBodySource(file: Blob, signal?: AbortSignal): Promise<BodySource> {
  try {
    checkAbort(signal);
    if (file.size > JPEG_LIMITS.sourceBytes) throw new BodyPhotoError('unusable');
    const admitted = await admitter(file, signal)();
    checkAbort(signal);
    // PNG and WebP carry their orientation separately from the pixels the preview shows, so only upright ones are used.
    if (admitted.orientation !== 1) throw new BodyPhotoError('unsupported');
    return { blob: admitted.blob, width: admitted.width, height: admitted.height };
  } catch (error) {
    throw failure(error);
  }
}

/**
 * Validates the crop independently of the editor: the rectangle is derived from the fractions (height from width at
 * 5:4), must match the stated height within one source pixel, stay inside the oriented image and be at least 512x640.
 */
export function bodyCropRect(source: { width: number; height: number }, edit: PhotoEdit): PixelRect {
  const turns = ((edit.turns % 4) + 4) % 4;
  if (!Number.isInteger(edit.turns)) throw new BodyPhotoError('invalid');
  const width = turns % 2 ? source.height : source.width, height = turns % 2 ? source.width : source.height;
  const rect = aspectPixelRect(width, height, edit.crop, BODY_ASPECT.rw, BODY_ASPECT.rh);
  if (!rect) throw new BodyPhotoError('invalid');
  if (rect.width < BODY_MIN_CROP.width || rect.height < BODY_MIN_CROP.height) throw new BodyPhotoError('small');
  return rect;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<string> {
  const hash = await abortable(crypto.subtle.digest('SHA-256', bytes), signal);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Draws the crop to an exactly 1024x1280 canvas (up to 2x upscaling) and walks a quality ladder; the dimensions never
 * shrink. The output must pass the photo input profile, decode at the same size, and is hashed in memory.
 */
export async function prepareBodyPhoto(source: BodySource, edit: PhotoEdit, signal?: AbortSignal): Promise<BodyPhoto> {
  const { width, height, maxBytes } = { width: TRYON_LIMITS.personWidth, height: TRYON_LIMITS.personHeight, maxBytes: TRYON_LIMITS.personBytes };
  let decoded: DecodedImage | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    checkAbort(signal);
    const rect = bodyCropRect(source, edit);
    const geometry = rectGeometry(source.width, source.height, edit.turns, rect);
    if (typeof document === 'undefined' || !globalThis.crypto?.subtle) throw new BodyPhotoError('unavailable');
    decoded = await decode(source.blob, signal, true);
    checkAbort(signal);
    if (decoded.width !== source.width || decoded.height !== source.height) throw new BodyPhotoError('unsupported');
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (typeof canvas.toBlob !== 'function') throw new BodyPhotoError('unavailable');
    draw(canvas, decoded.source, geometry);
    decoded.release();
    decoded = undefined;
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    for (const quality of QUALITIES) {
      checkAbort(signal);
      const target = canvas;
      const blob = await abortable(new Promise<Blob>((resolve, reject) => {
        target.toBlob((result) => {
          if (!result || result.type !== 'image/jpeg' || !result.size) reject(new BodyPhotoError('unavailable'));
          else resolve(result);
        }, 'image/jpeg', quality);
      }), signal);
      checkAbort(signal);
      if (blob.size > maxBytes) continue;
      bytes = stripEncoderMetadata(new Uint8Array(await abortable(blob.arrayBuffer(), signal)));
      break;
    }
    releaseCanvas(canvas);
    canvas = undefined;
    if (!bytes || bytes.length > maxBytes) throw new BodyPhotoError('unusable');
    if (!isPhotoInputJpeg(bytes, width, height, { bytes: maxBytes, side: height })) throw new BodyPhotoError('unusable');
    const check = await decode(new Blob([bytes], { type: 'image/jpeg' }), signal, true);
    const exact = check.width === width && check.height === height;
    check.release();
    if (!exact) throw new BodyPhotoError('unusable');
    checkAbort(signal);
    return { bytes, sha256: await sha256(bytes, signal) };
  } catch (error) {
    checkAbort(signal);
    throw failure(error, 'unusable');
  } finally {
    decoded?.release();
    if (canvas) releaseCanvas(canvas);
  }
}
