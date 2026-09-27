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
