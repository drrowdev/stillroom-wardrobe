// BG2b-2: browser pieces of the enhancement stage, loaded lazily with the stage so the heuristic and the provider
// profile stay out of the initial chunk. Decodes are closed by the stage right after downsampling.
import { assertSanitizedJpeg } from '../../images/jpeg';
import { admitProviderJpeg } from '../../images/provider-jpeg';
import { compareEnhancement, FIDELITY } from '../../images/fidelity';
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
export { admitProviderJpeg, compareEnhancement };
