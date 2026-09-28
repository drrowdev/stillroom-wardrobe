import {
  assertSanitizedJpeg,
  fitDimensions,
  ImagePreparationError,
  JPEG_LIMITS,
  readJpegHeader,
  stripEncoderMetadata,
  type ImagePreparationStage,
} from './jpeg';
import { cropGeometry, ORIGINAL_EDIT, type PhotoEdit } from './crop';
import { framePlan, referenceMask, type FramePlan } from './background/frame';
import { BackgroundRemovalError, MASK_SIDE, maskPixels } from './background/mask';
import type { Segmenter, SegmentJob } from './background/remover';
import { isPhotoInputJpeg } from './restore-jpeg';
import { ENHANCE_LIMITS } from '../domain/enhancement';

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

export function abortable<T>(
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

async function decode(blob: Blob, signal?: AbortSignal, waitForRelease = false): Promise<DecodedImage> {
  checkAbort(signal);
  if (typeof createImageBitmap === 'function') {
    try {
      // Both browser paths already apply EXIF: never rotate these pixels a second time.
      // Wait for native work to release even after cancellation, before another source starts.
      const pending = createImageBitmap(blob, { imageOrientation: 'from-image' });
      const bitmap = await (waitForRelease ? pending : abortable(pending, signal, (late) => late.close()));
      if (signal?.aborted) { bitmap.close(); checkAbort(signal); }
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

/** The app's neutral photo background, also used where background removal took the original away. */
export const PHOTO_BACKGROUND = '#f6f3ed';

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { colorSpace: 'srgb' });
  if (!context) throw new ImagePreparationError('unavailable');
  return context;
}

function fillBackground(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = context2d(canvas);
  context.fillStyle = PHOTO_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return context;
}

// Fills the neutral background, then draws `source` through the crop geometry scaled to the canvas size.
function draw(canvas: HTMLCanvasElement, source: CanvasImageSource, geometry?: ReturnType<typeof cropGeometry>): void {
  const context = fillBackground(canvas);
  if (!geometry || geometry.identity) {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  } else {
    const [a, b, c, d, e, f] = geometry.matrix;
    const scaleX = canvas.width / geometry.width, scaleY = canvas.height / geometry.height;
    context.setTransform(a * scaleX, b * scaleY, c * scaleX, d * scaleY,
      (e - geometry.x) * scaleX, (f - geometry.y) * scaleY);
    const rect = geometry.source;
    context.drawImage(source, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    context.setTransform(1, 0, 0, 1, 0, 0);
  }
}

async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  maxBytes: number,
  minSide: number,
  signal?: AbortSignal,
  geometry?: ReturnType<typeof cropGeometry>,
  waitForRelease = false,
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
      if (typeof canvas.toBlob !== 'function') throw new ImagePreparationError('unavailable');
      draw(canvas, source, geometry);
      for (const quality of QUALITIES) {
        checkAbort(signal);
        const pending = new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((result) => {
            if (!result || result.type !== 'image/jpeg' || !result.size) {
              reject(new ImagePreparationError('unavailable'));
            } else resolve(result);
          }, 'image/jpeg', quality);
        });
        const blob = await (waitForRelease ? pending : abortable(pending, signal));
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

/** Restore (Q6): the decoded size of already-checked bytes, with the decoder released before returning. */
export async function decodedSize(blob: Blob, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  let decoded: DecodedImage | undefined;
  try {
    if (typeof document === 'undefined') throw new ImagePreparationError('unavailable');
    decoded = await decode(blob, signal, true);
    checkAbort(signal);
    return { width: decoded.width, height: decoded.height };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ImagePreparationError(error instanceof ImagePreparationError ? error.code : 'invalid', 'decode');
  } finally {
    decoded?.release();
  }
}

/** Restore (Q6): a thumbnail made from the final main JPEG bytes by the usual thumbnail rule. */
export async function thumbnailFromMain(main: Blob, width: number, height: number, signal?: AbortSignal): Promise<{
  blob: Blob; sha256: string; width: number; height: number;
}> {
  let decoded: DecodedImage | undefined;
  let thumb: EncodedImage | undefined;
  let stage: ImagePreparationStage = 'decode';
  try {
    if (typeof document === 'undefined' || !globalThis.crypto?.subtle) throw new ImagePreparationError('unavailable');
    decoded = await decode(main, signal, true);
    checkAbort(signal);
    if (decoded.width !== width || decoded.height !== height) throw new ImagePreparationError('invalid');
    stage = 'thumbEncode';
    thumb = await encode(decoded.source, width, height, JPEG_LIMITS.thumbSide, JPEG_LIMITS.thumbBytes, 160,
      signal, undefined, true);
    decoded.release();
    decoded = undefined;
    const sha256 = await verifyAndHash(thumb, signal);
    return { blob: thumb.blob, sha256, width: thumb.canvas.width, height: thumb.canvas.height };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ImagePreparationError(
      error instanceof ImagePreparationError ? error.code : 'invalid',
      error instanceof ImagePreparationError ? error.stage ?? stage : stage,
    );
  } finally {
    decoded?.release();
    if (thumb) releaseCanvas(thumb.canvas);
  }
}

/** Phase 0: JPEG pixels only, prepared locally; no source upload or persistent storage. */
export async function prepareJpeg(file: Blob, signal?: AbortSignal): Promise<PreparedPhoto> {
  return prepareSource(file, () => admitJpeg(file, signal), ORIGINAL_EDIT, signal);
}

export async function admitJpeg(file: Blob, signal?: AbortSignal): Promise<AdmittedSource> {
  const headerBytes = await abortable(file.slice(0, JPEG_LIMITS.headerBytes).arrayBuffer(), signal);
  checkAbort(signal);
  const header = readJpegHeader(new Uint8Array(headerBytes));
  const trailer = new Uint8Array(await abortable(file.slice(-2).arrayBuffer(), signal));
  checkAbort(signal);
  if (trailer[0] !== 0xff || trailer[1] !== 0xd9) throw new ImagePreparationError('invalid');
  const swapped = header.orientation >= 5;
  return {
    blob: new Blob([file], { type: 'image/jpeg' }),
    width: swapped ? header.height : header.width, height: swapped ? header.width : header.height,
    orientation: 1,
  };
}

export type AdmittedSource = { blob: Blob; width: number; height: number; orientation: number };

/** One decoder/encoder/verifier for every admitted format; no source upload. */
export async function prepareSource(
  file: Blob, admit: () => Promise<AdmittedSource>, edit = ORIGINAL_EDIT, signal?: AbortSignal, waitForRelease = false,
): Promise<PreparedPhoto> {
  let decoded: DecodedImage | undefined;
  let main: EncodedImage | undefined;
  let thumb: EncodedImage | undefined;
  let stage: ImagePreparationStage = 'source';
  try {
    checkAbort(signal);
    if (file.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge');
    const header = await admit();
    checkAbort(signal);
    const geometry = cropGeometry(header.width, header.height, header.orientation, edit);
    if (typeof document === 'undefined' || !globalThis.crypto?.subtle) {
      throw new ImagePreparationError('unavailable');
    }
    // Normalizing MIME locally also makes the HTMLImageElement fallback signature-driven.
    stage = 'decode';
    decoded = await decode(header.blob, signal, waitForRelease);
    checkAbort(signal);
    if (decoded.width !== header.width || decoded.height !== header.height) {
      throw new ImagePreparationError('unsupported');
    }
    stage = 'mainEncode';
    main = await encode(
      decoded.source, geometry.width, geometry.height,
      JPEG_LIMITS.mainSide, JPEG_LIMITS.mainBytes, 800, signal, geometry, waitForRelease,
    );
    decoded.release();
    decoded = undefined;
    stage = 'thumbEncode';
    thumb = await encode(
      main.canvas, main.canvas.width, main.canvas.height,
      JPEG_LIMITS.thumbSide, JPEG_LIMITS.thumbBytes, 160, signal, undefined, waitForRelease,
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

/** A bounded, oriented and unsegmented JPEG of the whole photo, kept in memory for the crop editor only. */
export type CropSource = { main: Blob; width: number; height: number };
/**
 * BG2c clean-up input (plan rev4 §4). H0 is the accepted crop's ORIGINAL unmasked pixels drawn into the same BG2a frame
 * as H1, re-encoded by the app (decoded, oriented, cropped, framed, no metadata; never the raw file) and admitted by
 * `isPhotoInputJpeg`. `reference` is R, BG1's region on the 256 x 320 frame grid (0|1). Memory only: never stored,
 * uploaded, cached or exported.
 */
export type CleanupSource = {
  main: Blob; width: number; height: number; sha256: string; reference: Uint8Array;
  geometry: { edit: PhotoEdit; source: FramePlan['source']; dest: FramePlan['dest']; canvas: FramePlan['canvas'] };
};
/**
 * `framed` is false when the mask box was too small to trust and the unframed cut-out was kept. `cleanup` is null unless
 * it was asked for and the photo was framed and H0 passed every check; building it never fails the preparation.
 */
export type SegmentedPhoto = { photo: PreparedPhoto; crop: CropSource | null; coverage: number; framed: boolean; cleanup: CleanupSource | null };

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * H0 and R (BG2c plan rev4 §4.1). Fill the frame canvas, draw the unmasked working pixels source -> dest, encode within
 * the enhancement byte and side limits, strip metadata, check and hash, then admit with `isPhotoInputJpeg` and require
 * an exact 4:5 size after any encoder downscale. Every failure except an abort returns null, so H1 is kept and the
 * preparation still succeeds. At most two extra canvases are alive: the frame canvas and the encoder's own canvas.
 * Exported for its unit test only; the app reaches it through `prepareSegmentedSource(..., wantCleanup)`.
 */
export async function cleanupSource(working: HTMLCanvasElement, alpha: Float32Array, size: { width: number; height: number },
  frame: FramePlan, edit: PhotoEdit, signal?: AbortSignal): Promise<CleanupSource | null> {
  const h0Canvas = canvasOf(frame.canvas.width, frame.canvas.height);
  let encoded: EncodedImage | undefined;
  try {
    const context = fillBackground(h0Canvas);
    context.imageSmoothingQuality = 'high';
    const { source, dest } = frame;
    context.drawImage(working, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
    encoded = await encode(h0Canvas, h0Canvas.width, h0Canvas.height, JPEG_LIMITS.mainSide, ENHANCE_LIMITS.imageBytes, 800,
      signal, undefined, true);
    releaseCanvas(h0Canvas);
    const { width, height } = encoded.canvas;
    if (width * 5 !== height * 4 || Math.max(width, height) > ENHANCE_LIMITS.imageMaxSide) return null;
    const sha256 = await verifyAndHash(encoded, signal);
    const bytes = new Uint8Array(await abortable(encoded.blob.arrayBuffer(), signal));
    checkAbort(signal);
    if (bytes.length > ENHANCE_LIMITS.imageBytes || !isPhotoInputJpeg(bytes, width, height)) return null;
    const reference = referenceMask(alpha, size.width, size.height, frame);
    if (!reference) return null;
    return { main: encoded.blob, width, height, sha256, reference,
      geometry: { edit, source: { ...source }, dest: { ...dest }, canvas: { ...frame.canvas } } };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return null;
  } finally {
    releaseCanvas(h0Canvas);
    if (encoded) releaseCanvas(encoded.canvas);
  }
}

/**
 * Background removal (ADR24, blueprint 08 step 9): the model and runtime are verified and the worker is ready
 * before the large source is decoded; the decoded source is released as soon as the bounded crop is drawn. The
 * mask is applied to those pixels over the neutral background, and the result goes through the unchanged encode,
 * metadata strip, output check and hash. A removal failure throws `BackgroundRemovalError`; nothing partial is
 * returned.
 */
export async function prepareSegmentedSource(
  file: Blob, admit: () => Promise<AdmittedSource>, edit: PhotoEdit, signal: AbortSignal | undefined,
  segmenter: Segmenter, wantCrop: boolean, wantCleanup = false,
): Promise<SegmentedPhoto> {
  let decoded: DecodedImage | undefined;
  let job: SegmentJob | undefined;
  const canvases: HTMLCanvasElement[] = [];
  const temporary = (width: number, height: number) => { const canvas = canvasOf(width, height); canvases.push(canvas); return canvas; };
  let main: EncodedImage | undefined;
  let thumb: EncodedImage | undefined;
  let cropImage: EncodedImage | undefined;
  let stage: ImagePreparationStage = 'source';
  try {
    checkAbort(signal);
    if (file.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge');
    const header = await admit();
    checkAbort(signal);
    const geometry = cropGeometry(header.width, header.height, header.orientation, edit);
    if (typeof document === 'undefined' || !globalThis.crypto?.subtle) throw new ImagePreparationError('unavailable');
    job = await segmenter.open(signal);
    checkAbort(signal);
    stage = 'decode';
    decoded = await decode(header.blob, signal, true);
    checkAbort(signal);
    if (decoded.width !== header.width || decoded.height !== header.height) throw new ImagePreparationError('unsupported');
    stage = 'mainEncode';
    const size = fitDimensions(geometry.width, geometry.height, JPEG_LIMITS.mainSide);
    const working = temporary(size.width, size.height);
    draw(working, decoded.source, geometry);
    decoded.release();
    decoded = undefined;
    let crop: CropSource | null = null;
    if (wantCrop) {
      cropImage = await encode(working, size.width, size.height, JPEG_LIMITS.mainSide, JPEG_LIMITS.mainBytes, 800, signal, undefined, true);
      crop = { main: cropImage.blob, width: cropImage.canvas.width, height: cropImage.canvas.height };
      releaseCanvas(cropImage.canvas);
      cropImage = undefined;
    }
    const small = temporary(MASK_SIDE, MASK_SIDE);
    const smallContext = context2d(small);
    smallContext.imageSmoothingQuality = 'high';
    smallContext.drawImage(working, 0, 0, MASK_SIDE, MASK_SIDE);
    const alpha = await job.run(smallContext.getImageData(0, 0, MASK_SIDE, MASK_SIDE), signal);
    job.close();
    job = undefined;
    checkAbort(signal);
    let coverage = 0;
    for (const value of alpha) coverage += value;
    coverage /= alpha.length;
    const mask = temporary(MASK_SIDE, MASK_SIDE);
    context2d(mask).putImageData(new ImageData(maskPixels(alpha), MASK_SIDE, MASK_SIDE), 0, 0);
    releaseCanvas(small);
    // Packshot framing (BG2a): the garment's box, centred on a 4:5 canvas. A box too small to trust keeps the
    // unframed cut-out.
    const frame = framePlan(alpha, size.width, size.height);
    // BG2c H0, built while the unmasked working canvas still exists and before the cut-out canvas does.
    const cleanup = wantCleanup && frame ? await cleanupSource(working, alpha, size, frame, edit, signal) : null;
    checkAbort(signal);
    // The cut-out keeps the photo's pixels where the mask is set, then sits on the neutral background.
    const cut = temporary(size.width, size.height);
    const cutContext = context2d(cut);
    cutContext.drawImage(working, 0, 0);
    cutContext.globalCompositeOperation = 'destination-in';
    cutContext.imageSmoothingQuality = 'high';
    cutContext.drawImage(mask, 0, 0, size.width, size.height);
    releaseCanvas(working);
    releaseCanvas(mask);
    const composite = temporary(frame?.canvas.width ?? size.width, frame?.canvas.height ?? size.height);
    if (frame) {
      const { source, dest } = frame;
      const context = fillBackground(composite);
      context.imageSmoothingQuality = 'high';
      context.drawImage(cut, source.x, source.y, source.width, source.height, dest.x, dest.y, dest.width, dest.height);
    } else draw(composite, cut);
    releaseCanvas(cut);
    main = await encode(composite, composite.width, composite.height, JPEG_LIMITS.mainSide, JPEG_LIMITS.mainBytes, 800, signal, undefined, true);
    releaseCanvas(composite);
    stage = 'thumbEncode';
    thumb = await encode(main.canvas, main.canvas.width, main.canvas.height, JPEG_LIMITS.thumbSide, JPEG_LIMITS.thumbBytes, 160, signal, undefined, true);
    const mainSha256 = await verifyAndHash(main, signal);
    const thumbSha256 = await verifyAndHash(thumb, signal);
    checkAbort(signal);
    return {
      photo: { main: main.blob, thumb: thumb.blob, width: main.canvas.width, height: main.canvas.height, mainSha256, thumbSha256 },
      crop,
      coverage,
      framed: frame !== null,
      cleanup,
    };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof BackgroundRemovalError) throw error;
    throw new ImagePreparationError(
      error instanceof ImagePreparationError ? error.code : 'invalid',
      error instanceof ImagePreparationError ? error.stage ?? stage : stage,
    );
  } finally {
    job?.close();
    decoded?.release();
    for (const canvas of canvases) releaseCanvas(canvas);
    if (cropImage) releaseCanvas(cropImage.canvas);
    if (main) releaseCanvas(main.canvas);
    if (thumb) releaseCanvas(thumb.canvas);
  }
}
