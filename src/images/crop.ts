import { ImagePreparationError, JPEG_LIMITS } from './jpeg';
import { FULL_CROP, ORIGINAL_EDIT, type Crop, type PhotoEdit } from './photo-edit';

export { FULL_CROP, ORIGINAL_EDIT, type Crop, type PhotoEdit };
export type Matrix = readonly [number, number, number, number, number, number];

export function validCrop(crop: Crop): boolean {
  return Object.values(crop).every(Number.isFinite) && crop.x >= 0 && crop.y >= 0
    && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1 + 1e-10 && crop.y + crop.height <= 1 + 1e-10;
}

export function cropValues(crop: Crop): Record<keyof Crop, string> {
  if (!validCrop(crop)) throw new ImagePreparationError('invalid');
  // Paired integer edges avoid sum-over-one rounding; one tick is below a source pixel.
  const scale = 1e12;
  const axis = (start: number, size: number) => {
    const length = Math.min(scale, Math.max(1, Math.round(size * scale)));
    const position = Math.min(scale - length, Math.round(start * scale));
    return [position, length].map((ticks) => (ticks / 1e10).toFixed(10).replace(/\.?0+$/, ''));
  };
  const [x, width] = axis(crop.x, crop.width), [y, height] = axis(crop.y, crop.height);
  return { x: x!, y: y!, width: width!, height: height! };
}

export function parseCropValues(values: Record<keyof Crop, string>): Crop {
  const parse = (value: string) => /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value.trim())
    ? Number(value.replace(',', '.')) / 100 : NaN;
  return { x: parse(values.x), y: parse(values.y), width: parse(values.width), height: parse(values.height) };
}

export function mapPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function inverse(m: Matrix): Matrix {
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (!determinant) throw new ImagePreparationError('invalid');
  return [m[3] / determinant, -m[1] / determinant, -m[2] / determinant, m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant, (m[1] * m[4] - m[0] * m[5]) / determinant];
}

export function orientationTransform(width: number, height: number, orientation = 1, turns = 0) {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
    || width * height > JPEG_LIMITS.sourcePixels || !Number.isInteger(orientation)
    || orientation < 1 || orientation > 8 || !Number.isInteger(turns)) {
    throw new ImagePreparationError('invalid');
  }
  const matrices: Matrix[] = [
    [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, width, 0], [-1, 0, 0, -1, width, height],
    [1, 0, 0, -1, 0, height], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, height, 0],
    [0, -1, -1, 0, height, width], [0, -1, 1, 0, 0, width],
  ];
  let matrix = matrices[orientation - 1]!;
  let w = orientation >= 5 ? height : width;
  let h = orientation >= 5 ? width : height;
  for (let index = 0; index < ((turns % 4) + 4) % 4; index++) {
    const [a, b, c, d, e, f] = matrix;
    matrix = [-b, a, -d, c, h - f, e];
    [w, h] = [h, w];
  }
  return { matrix, width: w, height: h };
}

export function cropGeometry(width: number, height: number, orientation = 1, edit = ORIGINAL_EDIT) {
  if (!validCrop(edit.crop)) throw new ImagePreparationError('invalid');
  const oriented = orientationTransform(width, height, orientation, edit.turns);
  const x = Math.min(oriented.width - 1, Math.floor(edit.crop.x * oriented.width));
  const y = Math.min(oriented.height - 1, Math.floor(edit.crop.y * oriented.height));
  const right = Math.min(oriented.width, Math.max(x + 1, Math.ceil((edit.crop.x + edit.crop.width) * oriented.width)));
  const bottom = Math.min(oriented.height, Math.max(y + 1, Math.ceil((edit.crop.y + edit.crop.height) * oriented.height)));
  return geometryOf(oriented, width, height, orientation, edit.turns, x, y, right, bottom);
}

/** The draw geometry of an exact oriented pixel rectangle (VTO-2 body photo), in the same shape as `cropGeometry`. */
export function rectGeometry(width: number, height: number, turns: number, rect: PixelRect) {
  const oriented = orientationTransform(width, height, 1, turns);
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) || rect.x < 0 || rect.y < 0
    || rect.width < 1 || rect.height < 1 || rect.x + rect.width > oriented.width || rect.y + rect.height > oriented.height) {
    throw new ImagePreparationError('invalid');
  }
  return geometryOf(oriented, width, height, 1, turns, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
}

function geometryOf(oriented: { matrix: Matrix }, width: number, height: number, orientation: number, turns: number,
  x: number, y: number, right: number, bottom: number) {
  const undo = inverse(oriented.matrix);
  const corners = [mapPoint(undo, x, y), mapPoint(undo, right, y), mapPoint(undo, x, bottom), mapPoint(undo, right, bottom)];
  const sx = Math.min(...corners.map(([px]) => px));
  const sy = Math.min(...corners.map(([, py]) => py));
  return {
    matrix: oriented.matrix, x, y, width: right - x, height: bottom - y,
    source: { x: sx, y: sy, width: Math.max(...corners.map(([px]) => px)) - sx, height: Math.max(...corners.map(([, py]) => py)) - sy },
    identity: orientation === 1 && turns % 4 === 0 && x === 0 && y === 0 && right === width && bottom === height,
  };
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export const MIN_DRAG = 0.05;
export const HANDLE_PX = 44;
export const FRAME_BORDER_PX = 3;
// Two handles fit inside the frame's inner box, so the outer frame needs both handles plus both borders.
export const HANDLE_FRAME_PX = 2 * HANDLE_PX + 2 * FRAME_BORDER_PX;
const HANDLE_MARGIN_PX = 2;

// Tolerance-admitted crops (validCrop allows 1e-10 overrun) are brought fully inside before any drag maths.
export function normalizeCrop(crop: Crop): Crop {
  const width = Math.min(1, crop.width), height = Math.min(1, crop.height);
  return { x: Math.max(0, Math.min(1 - width, crop.x)), y: Math.max(0, Math.min(1 - height, crop.y)), width, height };
}

export function moveCrop(crop: Crop, dx: number, dy: number): Crop {
  const start = normalizeCrop(crop);
  return {
    ...start,
    x: Math.max(0, Math.min(1 - start.width, start.x + dx)),
    y: Math.max(0, Math.min(1 - start.height, start.y + dy)),
  };
}

export function resizeCrop(crop: Crop, corner: Corner, dx: number, dy: number, minWidth: number, minHeight: number): Crop {
  const start = normalizeCrop(crop);
  const axis = (near: number, size: number, delta: number, minimum: number, west: boolean): [number, number] => {
    const least = Math.min(size, Math.max(minimum, Number.MIN_VALUE));
    const far = Math.min(1, near + size);
    if (west) {
      const edge = Math.max(0, Math.min(far - least, near + delta));
      return [edge, far - edge];
    }
    const edge = Math.max(near + least, Math.min(1, far + delta));
    return [near, edge - near];
  };
  const [x, width] = axis(start.x, start.width, dx, minWidth, corner === 'nw' || corner === 'sw');
  const [y, height] = axis(start.y, start.height, dy, minHeight, corner === 'nw' || corner === 'ne');
  return { x, y, width, height };
}

export function handleMinimum(stagePx: number): number {
  if (!(stagePx > 0)) return 1;
  return Math.min(1, Math.max(MIN_DRAG, Math.ceil((HANDLE_FRAME_PX + HANDLE_MARGIN_PX) / stagePx * 1e10) / 1e10));
}

export function sameEdit(a: PhotoEdit, b: PhotoEdit): boolean {
  const turns = (value: number) => ((value % 4) + 4) % 4;
  if (!validCrop(a.crop) || !validCrop(b.crop) || turns(a.turns) !== turns(b.turns)) return false;
  const left = cropValues(a.crop), right = cropValues(b.crop);
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

export function aspectCrop(width: number, height: number, ratio: number): Crop {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new ImagePreparationError('invalid');
  const w = Math.min(1, ratio * height / width);
  const h = Math.min(1, width / (ratio * height));
  return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
}

export type CropDone = { kind: 'accept'; unchanged: boolean } | { kind: 'apply' } | { kind: 'cancel' } | null;
/** What Done does in the crop editor (BG2c R1): nothing for an invalid crop; in review mode it always accepts; otherwise an unchanged edit cancels. */
export function cropDone(edit: PhotoEdit, accepted: PhotoEdit, valid: boolean, review: boolean): CropDone {
  if (!valid) return null;
  const unchanged = sameEdit(edit, accepted);
  if (review) return { kind: 'accept', unchanged };
  return unchanged ? { kind: 'cancel' } : { kind: 'apply' };
}

/**
 * VTO-2 fixed-ratio crops. `factor` is the crop-fraction height per unit of crop-fraction width that keeps the pixel
 * ratio: for a `rw`:`rh` crop of a `width` x `height` (oriented) image it is width * rh / (height * rw).
 */
export function aspectFactor(width: number, height: number, rw: number, rh: number): number {
  if (![width, height, rw, rh].every((value) => Number.isFinite(value) && value > 0)) throw new ImagePreparationError('invalid');
  return width * rh / (height * rw);
}

/** A corner drag with the ratio locked: the opposite corner stays put and the frame stays inside the image. */
export function resizeAspectCrop(crop: Crop, corner: Corner, dx: number, dy: number, minWidth: number, minHeight: number, factor: number): Crop {
  const start = normalizeCrop(crop);
  const west = corner === 'nw' || corner === 'sw', north = corner === 'nw' || corner === 'ne';
  const anchorX = west ? start.x + start.width : start.x, anchorY = north ? start.y + start.height : start.y;
  const byX = west ? start.width - dx : start.width + dx;
  const byY = (north ? start.height - dy : start.height + dy) / factor;
  // The axis moved further decides, so dragging along either edge both grows and shrinks the frame.
  let width = Math.abs(byX - start.width) >= Math.abs(byY - start.width) ? byX : byY;
  const most = Math.min(west ? anchorX : 1 - anchorX, (north ? anchorY : 1 - anchorY) / factor);
  const least = Math.min(most, Math.max(minWidth, minHeight / factor, Number.MIN_VALUE));
  width = Math.max(least, Math.min(most, width));
  const height = width * factor;
  return { x: Math.max(0, west ? anchorX - width : anchorX), y: Math.max(0, north ? anchorY - height : anchorY), width, height };
}

export type PixelRect = { x: number; y: number; width: number; height: number };
/**
 * The exact source-pixel rectangle of a fixed-ratio crop, shared by the crop preview and the encoder: x, y and width
 * are rounded from the fractions and the height is derived from the width. Null when the stated height is more than one
 * source pixel away from the derived one or the rectangle leaves the image.
 */
export function aspectPixelRect(width: number, height: number, crop: Crop, rw: number, rh: number): PixelRect | null {
  if (!validCrop(crop) || ![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const x = Math.round(crop.x * width), y = Math.round(crop.y * height), w = Math.round(crop.width * width);
  const h = Math.round(w * rh / rw);
  if (w < 1 || h < 1 || Math.abs(h - crop.height * height) > 1 || x + w > width || y + h > height) return null;
  return { x, y, width: w, height: h };
}

/**
 * Snaps a fixed-ratio crop to whole source pixels (width rounded, height derived, then moved back inside the image), so
 * the fractions the editor applies map to one exact `aspectPixelRect`. Null when not even one pixel fits.
 */
export function snapAspectCrop(width: number, height: number, crop: Crop, rw: number, rh: number): Crop | null {
  if (!validCrop(crop) || ![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const start = normalizeCrop(crop);
  let w = Math.max(1, Math.round(start.width * width));
  while (w > 1 && (w > width || Math.round(w * rh / rw) > height)) w -= 1;
  const h = Math.round(w * rh / rw);
  if (h < 1 || h > height || w > width) return null;
  const x = Math.min(width - w, Math.max(0, Math.round(start.x * width)));
  const y = Math.min(height - h, Math.max(0, Math.round(start.y * height)));
  return { x: x / width, y: y / height, width: w / width, height: h / height };
}

/** A fixed crop ratio, width to height. */
export type CropAspect = { rw: number; rh: number };
/** The largest centred crop of this ratio in the image after `turns` quarter turns, snapped to whole pixels. */
export function largestAspectCrop(width: number, height: number, turns: number, aspect: CropAspect): Crop {
  const [w, h] = (((turns % 4) + 4) % 4) % 2 ? [height, width] : [width, height];
  return snapAspectCrop(w, h, aspectCrop(w, h, aspect.rw / aspect.rh), aspect.rw, aspect.rh) ?? FULL_CROP;
}
