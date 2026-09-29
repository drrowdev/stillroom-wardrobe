// Packshot framing (BG2a, #84): the cut-out garment is cropped to its mask's box and centred on a 4:5 canvas with
// the same relative padding on every item. Pure and deterministic, so the same mask always gives the same frame.
import { MASK_SIDE } from './mask';

/** Padding on every side, as a share of the canvas. */
export const FRAME_PADDING = 0.08;
/** Longest canvas side, the same cap as the main photo. */
export const FRAME_MAX_SIDE = 1600;
/** A row or column counts only with at least this many kept mask pixels, so isolated specks don't widen the box. */
const MIN_RUN = 3;
/** A box under this share of the mask is not trusted for framing; the unframed cut-out is kept instead. */
const MIN_BOX_SHARE = 0.02;

export type Rect = { x: number; y: number; width: number; height: number };
export type FramePlan = { source: Rect; canvas: { width: number; height: number }; dest: Rect };

/** The kept box in mask pixels (inclusive start, exclusive end), or null when too little of the mask is kept. */
export function maskBox(alpha: Float32Array): { x0: number; y0: number; x1: number; y1: number } | null {
  if (alpha.length !== MASK_SIDE * MASK_SIDE) return null;
  const rows = new Uint16Array(MASK_SIDE), columns = new Uint16Array(MASK_SIDE);
  for (let y = 0; y < MASK_SIDE; y += 1) {
    for (let x = 0; x < MASK_SIDE; x += 1) {
      if (alpha[y * MASK_SIDE + x]! >= 0.5) { rows[y]! += 1; columns[x]! += 1; }
    }
  }
  const first = (counts: Uint16Array) => counts.findIndex((count) => count >= MIN_RUN);
  const last = (counts: Uint16Array) => {
    for (let index = counts.length - 1; index >= 0; index -= 1) if (counts[index]! >= MIN_RUN) return index;
    return -1;
  };
  const x0 = first(columns), y0 = first(rows);
  if (x0 < 0 || y0 < 0) return null;
  const box = { x0, y0, x1: last(columns) + 1, y1: last(rows) + 1 };
  if ((box.x1 - box.x0) * (box.y1 - box.y0) < MIN_BOX_SHARE * MASK_SIDE * MASK_SIDE) return null;
  return box;
}

/**
 * Where to cut from the working canvas and where to draw it on the 4:5 canvas. Returns null when the mask's box is
 * empty or under 2 % of the mask; the caller then keeps the unframed cut-out. The garment is never upscaled.
 */
export function framePlan(alpha: Float32Array, workingWidth: number, workingHeight: number): FramePlan | null {
  if (![workingWidth, workingHeight].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const box = maskBox(alpha);
  if (!box) return null;
  const scaleX = workingWidth / MASK_SIDE, scaleY = workingHeight / MASK_SIDE;
  // One mask pixel of margin covers the blur from upsampling the mask.
  const left = Math.max(0, Math.floor((box.x0 - 1) * scaleX));
  const top = Math.max(0, Math.floor((box.y0 - 1) * scaleY));
  const right = Math.min(workingWidth, Math.ceil((box.x1 + 1) * scaleX));
  const bottom = Math.min(workingHeight, Math.ceil((box.y1 + 1) * scaleY));
  const source = { x: left, y: top, width: right - left, height: bottom - top };
  const inner = 1 - 2 * FRAME_PADDING;
  // The smallest 4k × 5k canvas whose inner box (84 %) holds the garment at scale 1, capped at 1280 × 1600.
  const unit = Math.min(FRAME_MAX_SIDE / 5,
    Math.max(1, Math.ceil(Math.max(source.width / (4 * inner), source.height / (5 * inner)) - 1e-9)));
  const canvas = { width: 4 * unit, height: 5 * unit };
  const scale = Math.min(1, canvas.width * inner / source.width, canvas.height * inner / source.height);
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  const dest = { x: Math.floor((canvas.width - width) / 2), y: Math.floor((canvas.height - height) / 2), width, height };
  return { source, canvas, dest };
}

/** BG2c: the clean-up reference grid (the same as the fidelity grid). */
export const REFERENCE_WIDTH = 256;
export const REFERENCE_HEIGHT = 320;
/** BG2c ambiguity rule: a second separate region at least this share of the largest one's area. */
export const AMBIGUOUS_SECOND_SHARE = 0.25;
/** BG2c: labelling gives up (fails closed) above this many components. */
export const MAX_COMPONENTS = 4096;
const REFERENCE_SAMPLES = 4;

/**
 * R (BG2c plan rev4 §4.2): BG1's kept region mapped onto the 256 × 320 grid of the framed 4:5 canvas. Each cell is box
 * sampled (4 × 4 points) through the plan's dest -> source mapping and the working -> mask scale; a cell is set when the
 * mean alpha is at least 0.5. Everything outside `dest` is 0. R is BG1's region, not the intended garment: it can
 * include hangers and neighbours, so the clean-up check only uses it as an upper bound and a loose floor.
 */
export function referenceMask(alpha: Float32Array, workingWidth: number, workingHeight: number, plan: FramePlan): Uint8Array | null {
  if (alpha.length !== MASK_SIDE * MASK_SIDE
    || ![workingWidth, workingHeight].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const { source, dest, canvas } = plan;
  if (![source.width, source.height, dest.width, dest.height, canvas.width, canvas.height].every((value) => value > 0)) return null;
  const out = new Uint8Array(REFERENCE_WIDTH * REFERENCE_HEIGHT);
  const cellW = canvas.width / REFERENCE_WIDTH, cellH = canvas.height / REFERENCE_HEIGHT;
  const toMaskX = MASK_SIDE / workingWidth, toMaskY = MASK_SIDE / workingHeight;
  for (let gy = 0; gy < REFERENCE_HEIGHT; gy += 1) {
    for (let gx = 0; gx < REFERENCE_WIDTH; gx += 1) {
      let sum = 0;
      for (let sy = 0; sy < REFERENCE_SAMPLES; sy += 1) {
        const fy = (gy + (sy + 0.5) / REFERENCE_SAMPLES) * cellH;
        if (fy < dest.y || fy >= dest.y + dest.height) continue;
        const wy = source.y + (fy - dest.y) * source.height / dest.height;
        const my = Math.min(MASK_SIDE - 1, Math.max(0, Math.floor(wy * toMaskY)));
        for (let sx = 0; sx < REFERENCE_SAMPLES; sx += 1) {
          const fx = (gx + (sx + 0.5) / REFERENCE_SAMPLES) * cellW;
          if (fx < dest.x || fx >= dest.x + dest.width) continue;
          const wx = source.x + (fx - dest.x) * source.width / dest.width;
          const mx = Math.min(MASK_SIDE - 1, Math.max(0, Math.floor(wx * toMaskX)));
          sum += alpha[my * MASK_SIDE + mx]!;
        }
      }
      out[gy * REFERENCE_WIDTH + gx] = sum / (REFERENCE_SAMPLES * REFERENCE_SAMPLES) >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

export type Components = { count: number; areas: number[]; boxes: { x0: number; y0: number; x1: number; y1: number }[]; overflow: boolean };

/**
 * 4-connected labelling with an iterative queue (no recursion). `labels` and `queue` are caller-owned buffers of the
 * mask's length, so repeated checks allocate nothing here. Labels start at 1; 0 is unlabelled. Stops with
 * `overflow: true` above MAX_COMPONENTS.
 */
export function labelComponents(mask: Uint8Array, width: number, height: number, labels: Int32Array, queue: Int32Array): Components {
  const size = width * height;
  if (mask.length !== size || labels.length < size || queue.length < size) throw new RangeError('component buffers');
  labels.fill(0, 0, size);
  const areas: number[] = [], boxes: Components['boxes'] = [];
  for (let start = 0; start < size; start += 1) {
    if (!mask[start] || labels[start]) continue;
    if (areas.length >= MAX_COMPONENTS) return { count: areas.length, areas, boxes, overflow: true };
    const label = areas.length + 1;
    let head = 0, tail = 0, area = 0;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    labels[start] = label; queue[tail++] = start;
    while (head < tail) {
      const at = queue[head++]!;
      const x = at % width, y = (at - x) / width;
      area += 1;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[at - 1] && !labels[at - 1]) { labels[at - 1] = label; queue[tail++] = at - 1; }
      if (x < width - 1 && mask[at + 1] && !labels[at + 1]) { labels[at + 1] = label; queue[tail++] = at + 1; }
      if (y > 0 && mask[at - width] && !labels[at - width]) { labels[at - width] = label; queue[tail++] = at - width; }
      if (y < height - 1 && mask[at + width] && !labels[at + width]) { labels[at + width] = label; queue[tail++] = at + width; }
    }
    areas.push(area);
    boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return { count: areas.length, areas, boxes, overflow: false };
}

/**
 * The on-device ambiguity rule (§4.3): R is ambiguous when its second-largest separate region is at least 25 % of the
 * largest's area, for example two garments side by side. Touching or overlapping neighbours merge into one region and
 * are NOT detected here. An empty R, or one with too many regions, is also treated as ambiguous (not available).
 */
export function ambiguousReference(reference: Uint8Array): boolean {
  const size = REFERENCE_WIDTH * REFERENCE_HEIGHT;
  if (reference.length !== size) return true;
  const found = labelComponents(reference, REFERENCE_WIDTH, REFERENCE_HEIGHT, new Int32Array(size), new Int32Array(size));
  if (found.overflow || found.count === 0) return true;
  const sorted = [...found.areas].sort((a, b) => b - a);
  return sorted.length > 1 && sorted[1]! >= AMBIGUOUS_SECOND_SHARE * sorted[0]!;
}
