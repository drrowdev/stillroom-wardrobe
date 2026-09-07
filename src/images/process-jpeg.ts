import {
  assertSanitizedJpeg,
  fitDimensions,
  ImagePreparationError,
  JPEG_LIMITS,
  readJpegHeader,
  stripEncoderMetadata,
  type ImagePreparationStage,
} from './jpeg';

export { ImagePreparationError } from './jpeg';

export type PreparedPhoto = {
  main: Blob;
  thumb: Blob;
  width: number;
  height: number;
  mainSha256: string;
  thumbSha256: string;
};

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};
type EncodedImage = { blob: Blob; canvas: HTMLCanvasElement };
const QUALITIES = [0.82, 0.75, 0.68, 0.61, 0.55] as const;
const MAX_SIZE_ATTEMPTS = 6;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  releaseLate?: (value: T) => void,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', abort);
      if (settled) {
        releaseLate?.(value);
      } else {
        settled = true;
        resolve(value);
      }
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (signal.aborted) abort();
  });
}

async function decodeWithImage(blob: Blob, signal?: AbortSignal): Promise<DecodedImage> {
  if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new ImagePreparationError('unavailable');
  }
  const image = new Image();
  const url = URL.createObjectURL(blob);
  const release = () => {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      image.onload = () => finish();
      image.onerror = () => finish(new ImagePreparationError('invalid'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else {
        image.decoding = 'async';
        image.src = url;
      }
    });
    checkAbort(signal);
    if (!image.naturalWidth || !image.naturalHeight) throw new ImagePreparationError('invalid');
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function decode(blob: Blob, signal?: AbortSignal): Promise<DecodedImage> {
  checkAbort(signal);
  if (typeof createImageBitmap === 'function') {
    try {
      // Both browser paths already apply EXIF: never rotate these pixels a second time.
      const bitmap = await abortable(
        createImageBitmap(blob, { imageOrientation: 'from-image' }),
        signal,
        (late) => late.close(),
      );
      return {
        source: bitmap, width: bitmap.width, height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch (error) {
      checkAbort(signal);
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      // Some browsers expose ImageBitmap but cannot decode JPEGs/options through it.
    }
  }
  return decodeWithImage(blob, signal);
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 1;
  canvas.height = 1;
}

async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  maxBytes: number,
  minSide: number,
  signal?: AbortSignal,
): Promise<EncodedImage> {
  const canvas = document.createElement('canvas');
  let side = Math.min(Math.max(width, height), maxSide);
  const floor = Math.min(side, minSide);
  try {
    for (let attempt = 0; attempt < MAX_SIZE_ATTEMPTS; attempt += 1) {
      checkAbort(signal);
      const dimensions = fitDimensions(width, height, side);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!context || typeof canvas.toBlob !== 'function') {
        throw new ImagePreparationError('unavailable');
      }
      context.fillStyle = '#f6f3ed';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        checkAbort(signal);
        const blob = await abortable(new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((result) => {
            if (!result || result.type !== 'image/jpeg' || !result.size) {
              reject(new ImagePreparationError('unavailable'));
            } else resolve(result);
          }, 'image/jpeg', quality);
        }), signal);
        checkAbort(signal);
        if (blob.size <= maxBytes) return { blob, canvas };
      }
      if (side <= floor) break;
      side = Math.max(floor, Math.floor(side * 0.85));
    }
    throw new ImagePreparationError('tooLarge');
  } catch (error) {
    releaseCanvas(canvas);
    throw error;
  }
}

async function verifyAndHash(image: EncodedImage, signal?: AbortSignal): Promise<string> {
  let stage: ImagePreparationStage = 'outputCheck';
  try {
    checkAbort(signal);
    const buffer = await abortable(image.blob.arrayBuffer(), signal);
    checkAbort(signal);
    const bytes = stripEncoderMetadata(new Uint8Array(buffer));
    assertSanitizedJpeg(bytes, image.canvas.width, image.canvas.height);
    image.blob = new Blob([bytes], { type: 'image/jpeg' });
    stage = 'hash';
    const hash = await abortable(crypto.subtle.digest('SHA-256', bytes), signal);
    checkAbort(signal);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ImagePreparationError(error instanceof ImagePreparationError ? error.code : 'invalid', stage);
  }
}

/** Phase 0: JPEG pixels only, prepared locally; no source upload or persistent storage. */
export async function prepareJpeg(file: Blob, signal?: AbortSignal): Promise<PreparedPhoto> {
  let decoded: DecodedImage | undefined;
  let main: EncodedImage | undefined;
  let thumb: EncodedImage | undefined;
  let stage: ImagePreparationStage = 'source';
  try {
    checkAbort(signal);
    if (file.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge');
    const headerBytes = await abortable(file.slice(0, JPEG_LIMITS.headerBytes).arrayBuffer(), signal);
    checkAbort(signal);
    const header = readJpegHeader(new Uint8Array(headerBytes));
    const trailer = new Uint8Array(await abortable(file.slice(-2).arrayBuffer(), signal));
    checkAbort(signal);
    if (trailer[0] !== 0xff || trailer[1] !== 0xd9) throw new ImagePreparationError('invalid');
    if (typeof document === 'undefined' || !globalThis.crypto?.subtle) {
      throw new ImagePreparationError('unavailable');
    }
    // Normalizing MIME locally also makes the HTMLImageElement fallback signature-driven.
    stage = 'decode';
    decoded = await decode(new Blob([file], { type: 'image/jpeg' }), signal);
    checkAbort(signal);
    const swapped = header.orientation >= 5;
    if (decoded.width !== (swapped ? header.height : header.width) ||
        decoded.height !== (swapped ? header.width : header.height)) {
      throw new ImagePreparationError('unsupported');
    }
    stage = 'mainEncode';
    main = await encode(
      decoded.source, decoded.width, decoded.height,
      JPEG_LIMITS.mainSide, JPEG_LIMITS.mainBytes, 800, signal,
    );
    decoded.release();
    decoded = undefined;
    stage = 'thumbEncode';
    thumb = await encode(
      main.canvas, main.canvas.width, main.canvas.height,
      JPEG_LIMITS.thumbSide, JPEG_LIMITS.thumbBytes, 160, signal,
    );
    const mainSha256 = await verifyAndHash(main, signal);
    const thumbSha256 = await verifyAndHash(thumb, signal);
    checkAbort(signal);
    return {
      main: main.blob, thumb: thumb.blob,
      width: main.canvas.width, height: main.canvas.height,
      mainSha256, thumbSha256,
    };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ImagePreparationError(
      error instanceof ImagePreparationError ? error.code : 'invalid',
      error instanceof ImagePreparationError ? error.stage ?? stage : stage,
    );
  } finally {
    decoded?.release();
    if (main) releaseCanvas(main.canvas);
    if (thumb) releaseCanvas(thumb.canvas);
  }
}
