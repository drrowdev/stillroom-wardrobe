// Pure pixel/tensor steps for u2netp (ADR24), shared by the worker and the unit tests. Every degenerate input or
// output throws, so the caller keeps the photo's original background instead of publishing a broken cut-out.
export const MASK_SIDE = 320;
const PLANE = MASK_SIDE * MASK_SIDE;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export type BackgroundFailure = 'unsupported' | 'offline' | 'download' | 'integrity' | 'init' | 'run' | 'timeout' | 'degenerate';

export class BackgroundRemovalError extends Error {
  readonly code: BackgroundFailure;
  constructor(code: BackgroundFailure) {
    super(code);
    this.name = 'BackgroundRemovalError';
    this.code = code;
  }
}

/** RGBA 320×320 → NCHW float32, scaled by the largest channel value then ImageNet mean/std, as rembg does. */
export function toInputTensor(rgba: Uint8ClampedArray | Uint8Array): Float32Array {
  if (rgba.length !== PLANE * 4) throw new BackgroundRemovalError('degenerate');
  let max = 0;
  for (let index = 0; index < rgba.length; index += 1) {
    if ((index & 3) !== 3 && rgba[index]! > max) max = rgba[index]!;
  }
  if (max === 0) throw new BackgroundRemovalError('degenerate');
  const tensor = new Float32Array(PLANE * 3);
  for (let pixel = 0; pixel < PLANE; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      tensor[channel * PLANE + pixel] = (rgba[pixel * 4 + channel]! / max - MEAN[channel]!) / STD[channel]!;
    }
  }
  return tensor;
}

/** Validates the first model output and returns a 0..1 alpha plane with haze and near-solid values snapped. */
export function alphaFromOutput(type: unknown, dims: readonly unknown[], data: unknown): Float32Array {
  if (type !== 'float32' || !(data instanceof Float32Array) || data.length !== PLANE
    || dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1 || dims[2] !== MASK_SIDE || dims[3] !== MASK_SIDE) {
    throw new BackgroundRemovalError('degenerate');
  }
  let min = Infinity, max = -Infinity;
  for (const value of data) {
    if (!Number.isFinite(value)) throw new BackgroundRemovalError('degenerate');
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max - min < 1e-6) throw new BackgroundRemovalError('degenerate');
  const alpha = new Float32Array(PLANE);
  let sum = 0;
  for (let index = 0; index < PLANE; index += 1) {
    const value = (data[index]! - min) / (max - min);
    alpha[index] = value < 0.05 ? 0 : value > 0.95 ? 1 : value;
    sum += alpha[index]!;
  }
  const mean = sum / PLANE;
  // Nearly nothing or nearly everything kept: the item was not found.
  if (mean < 0.02 || mean > 0.98) throw new BackgroundRemovalError('degenerate');
  return alpha;
}

/** 8-bit RGBA mask image (white, alpha = mask) for canvas compositing. */
export function maskPixels(alpha: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  if (alpha.length !== PLANE) throw new BackgroundRemovalError('degenerate');
  const pixels = new Uint8ClampedArray(PLANE * 4);
  for (let index = 0; index < PLANE; index += 1) {
    pixels[index * 4] = 255; pixels[index * 4 + 1] = 255; pixels[index * 4 + 2] = 255;
    pixels[index * 4 + 3] = Math.round(alpha[index]! * 255);
  }
  return pixels;
}
