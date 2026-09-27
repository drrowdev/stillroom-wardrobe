import { describe, expect, it } from 'vitest';
import { alphaFromOutput, BackgroundRemovalError, MASK_SIDE, maskPixels, toInputTensor } from '../../src/images/background/mask';

const plane = MASK_SIDE * MASK_SIDE;
const rgba = (value: (pixel: number) => [number, number, number]) => {
  const pixels = new Uint8ClampedArray(plane * 4);
  for (let pixel = 0; pixel < plane; pixel += 1) {
    const [r, g, b] = value(pixel);
    pixels.set([r, g, b, 255], pixel * 4);
  }
  return pixels;
};
const dims = [1, 1, MASK_SIDE, MASK_SIDE];
// A garment-like block in the centre: high inside, low outside, with a soft edge band.
const output = (inside = 4, outside = -4) => {
  const data = new Float32Array(plane);
  for (let index = 0; index < plane; index += 1) {
    const x = index % MASK_SIDE, y = Math.floor(index / MASK_SIDE);
    data[index] = x > 80 && x < 240 && y > 60 && y < 260 ? inside : x > 76 && x < 244 && y > 56 && y < 264 ? 0 : outside;
  }
  return data;
};
const degenerate = (run: () => unknown) => {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(BackgroundRemovalError);
    expect((error as BackgroundRemovalError).code).toBe('degenerate');
    return;
  }
  throw new Error('expected a degenerate failure');
};

describe('u2netp input tensor', () => {
  it('scales by the brightest channel and applies ImageNet mean/std in planar order', () => {
    const tensor = toInputTensor(rgba((pixel) => pixel === 0 ? [200, 100, 0] : [0, 0, 0]));
    expect(tensor).toHaveLength(plane * 3);
    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(tensor[plane]).toBeCloseTo((0.5 - 0.456) / 0.224, 5);
    expect(tensor[2 * plane]).toBeCloseTo((0 - 0.406) / 0.225, 5);
    expect(tensor[1]).toBeCloseTo(-0.485 / 0.229, 5);
  });

  it('refuses an all-black frame (zero channel maximum) and a wrong-sized frame', () => {
    degenerate(() => toInputTensor(rgba(() => [0, 0, 0])));
    degenerate(() => toInputTensor(new Uint8ClampedArray(plane * 4 - 4)));
  });
});

describe('u2netp output validation', () => {
  it('normalises a plausible mask, snaps haze and solid values and keeps the soft edge', () => {
    const alpha = alphaFromOutput('float32', dims, output());
    expect(alpha[0]).toBe(0);
    expect(alpha[160 * MASK_SIDE + 160]).toBe(1);
    expect(alpha[58 * MASK_SIDE + 160]).toBeCloseTo(0.5, 5);
    const coverage = alpha.reduce((sum, value) => sum + value, 0) / plane;
    expect(coverage).toBeGreaterThan(0.2);
    expect(coverage).toBeLessThan(0.4);
  });

  it.each([
    ['a constant output', () => alphaFromOutput('float32', dims, new Float32Array(plane).fill(0.7))],
    ['NaN', () => { const data = output(); data[5] = Number.NaN; return alphaFromOutput('float32', dims, data); }],
    ['Infinity', () => { const data = output(); data[5] = Infinity; return alphaFromOutput('float32', dims, data); }],
    ['a wrong shape', () => alphaFromOutput('float32', [1, 3, MASK_SIDE, MASK_SIDE], output())],
    ['a wrong length', () => alphaFromOutput('float32', dims, new Float32Array(plane - 1))],
    ['a wrong element type', () => alphaFromOutput('float16', dims, output())],
    ['a non-float buffer', () => alphaFromOutput('float32', dims, new Uint8Array(plane))],
    ['almost nothing kept', () => { const data = new Float32Array(plane).fill(-4); data[0] = 4; return alphaFromOutput('float32', dims, data); }],
    ['almost everything kept', () => { const data = new Float32Array(plane).fill(4); data[0] = -4; return alphaFromOutput('float32', dims, data); }],
  ])('refuses %s', (_name, run) => degenerate(run));

  it('turns alpha into an 8-bit white mask image', () => {
    const alpha = new Float32Array(plane);
    alpha[1] = 1; alpha[2] = 0.5;
    const pixels = maskPixels(alpha);
    expect([...pixels.slice(0, 12)]).toEqual([255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 128]);
    degenerate(() => maskPixels(new Float32Array(3)));
  });
});
