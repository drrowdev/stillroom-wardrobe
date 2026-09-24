import { ImagePreparationError, JPEG_LIMITS } from './jpeg';

export type Crop = { x: number; y: number; width: number; height: number };
export type PhotoEdit = { turns: number; crop: Crop };
export type Matrix = readonly [number, number, number, number, number, number];
export const FULL_CROP: Crop = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
export const ORIGINAL_EDIT: PhotoEdit = Object.freeze({ turns: 0, crop: FULL_CROP });

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
  const undo = inverse(oriented.matrix);
  const corners = [mapPoint(undo, x, y), mapPoint(undo, right, y), mapPoint(undo, x, bottom), mapPoint(undo, right, bottom)];
  const sx = Math.min(...corners.map(([px]) => px));
  const sy = Math.min(...corners.map(([, py]) => py));
  return {
    matrix: oriented.matrix, x, y, width: right - x, height: bottom - y,
    source: { x: sx, y: sy, width: Math.max(...corners.map(([px]) => px)) - sx, height: Math.max(...corners.map(([, py]) => py)) - sy },
    identity: orientation === 1 && edit.turns % 4 === 0 && x === 0 && y === 0 && right === width && bottom === height,
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
