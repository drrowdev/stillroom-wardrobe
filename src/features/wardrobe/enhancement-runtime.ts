// BG2b-2: browser pieces of the enhancement stage, loaded lazily with the stage so the heuristic and the provider
// profile stay out of the initial chunk. Decodes are closed by the stage right after downsampling.
import { assertSanitizedJpeg } from '../../images/jpeg';
import { admitProviderJpeg } from '../../images/provider-jpeg';
import { FIDELITY, type CleanupVerdict } from '../../images/fidelity';
import type { CleanupWorkerReply, CleanupWorkerRequest } from '../../images/cleanup-worker';
import { thumbnailFromMain } from '../../images/process-jpeg';
import type { DecodedFrame, StageImaging } from './enhancement-stage';

type Frame = DecodedFrame & { bitmap: ImageBitmap };
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, '0')).join('');

export const browserStageImaging: StageImaging<Frame> = {
  sha256: async (bytes) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
  validate: (bytes, width, height) => assertSanitizedJpeg(bytes, width, height),
  decode: async (blob, signal) => {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', colorSpaceConversion: 'default', premultiplyAlpha: 'none' });
    if (signal.aborted) { bitmap.close(); throw new DOMException('Aborted', 'AbortError'); }
    return { bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  },
  downsample: (frame) => {
    const canvas = document.createElement('canvas');
    canvas.width = FIDELITY.width;
    canvas.height = FIDELITY.height;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('unavailable');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(frame.bitmap, 0, 0, FIDELITY.width, FIDELITY.height);
      return context.getImageData(0, 0, FIDELITY.width, FIDELITY.height).data;
    } finally { canvas.width = 0; canvas.height = 0; }
  },
  thumbnail: async (main, width, height, signal) => {
    const thumb = await thumbnailFromMain(main, width, height, signal);
    return { blob: thumb.blob, sha256: thumb.sha256 };
  },
};
// BG2c-3 (plan rev8b §2): the clean-up check runs in a module worker, one per check. H0 and H2 are the stage's own
// downsamples and are transferred (the caller must not use them afterwards); R belongs to the source and is copied.
// Skip, the stage timeout and every other abort terminate the worker and reject with the signal's reason.
const owned = (view: Uint8Array | Uint8ClampedArray): ArrayBuffer =>
  view.byteOffset === 0 && view.byteLength === view.buffer.byteLength && view.buffer instanceof ArrayBuffer
    ? view.buffer : view.slice().buffer as ArrayBuffer;
const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError');

export function cleanupCheck(h0: Uint8ClampedArray, reference: Uint8Array, h2: Uint8ClampedArray,
  options: { signal: AbortSignal }): Promise<CleanupVerdict> {
  const { signal } = options;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<CleanupVerdict>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../../images/cleanup-worker.ts', import.meta.url), { type: 'module', name: 'cleanup' });
    } catch {
      reject(new Error('unavailable'));
      return;
    }
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { finish(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<CleanupWorkerReply>) => {
      finish();
      if (data.type === 'verdict') resolve(data.verdict); else reject(new Error('failed'));
    };
    worker.onerror = () => { finish(); reject(new Error('failed')); };
    worker.onmessageerror = () => { finish(); reject(new Error('failed')); };
    const request: CleanupWorkerRequest = { h0: owned(h0), reference: reference.slice().buffer, h2: owned(h2) };
    try {
      worker.postMessage(request, request.h0 === request.h2 ? [request.h0, request.reference] : [request.h0, request.h2, request.reference]);
    } catch {
      finish();
      reject(new Error('failed'));
    }
  });
}

export { admitProviderJpeg };
