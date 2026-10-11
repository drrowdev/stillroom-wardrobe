// Synthetic JPEG variants for the saved-photo admission tests (TRYON-PHOTO1). The negatives start from the flat fixture and
// edit one table, descriptor or reference at a time; the positives are other layouts the app's encoders write. Used by the
// CI-only privileged-SQL probe (and by a local scratch check of the same SQL); no pixels of any person.
import { appleLayoutJpeg, flatJpeg } from './restore-jpeg-fixtures.ts';
import { joinBytes, jpegSegment } from './jpeg-helpers.ts';

type Located = { marker: number; at: number; length: number };

function located(bytes: Uint8Array): Located[] {
  const out: Located[] = [];
  let at = 2;
  for (;;) {
    const marker = bytes[at + 1]!, length = bytes[at + 2]! * 256 + bytes[at + 3]!;
    out.push({ marker, at, length });
    if (marker === 0xda) return out;
    at += 2 + length;
  }
}

const payload = (bytes: Uint8Array, entry: Located) => bytes.subarray(entry.at + 4, entry.at + 2 + entry.length);

export function photoLayoutPositives(width: number, height: number): [string, Uint8Array][] {
  const flat = flatJpeg({ width, height });
  const parts = located(flat);
  const pick = (marker: number, nth = 0) => parts.filter(entry => entry.marker === marker)[nth]!;
  const dc = payload(flat, pick(0xc4, 0)), ac = payload(flat, pick(0xc4, 1));
  const as = (source: Uint8Array, id: number) => { const copy = source.slice(); copy[0] = (copy[0]! & 0xf0) | id; return copy; };
  const quant = (value: number) => [...new Array<number>(64).fill(value)];
  const frame = payload(flat, pick(0xc0)).slice();
  frame[8] = 0;
  frame[11] = 1;
  frame[14] = 1;
  const scan = payload(flat, pick(0xda)).slice();
  scan[2] = 0x00;
  scan[4] = 0x11;
  scan[6] = 0x11;
  const tail = flat.subarray(pick(0xda).at + 2 + pick(0xda).length);
  const tables = joinBytes(flat.subarray(0, 2), jpegSegment(0xe0, payload(flat, pick(0xe0))),
    jpegSegment(0xdb, new Uint8Array([0x00, ...quant(8), 0x01, ...quant(9)])), jpegSegment(0xc0, frame),
    jpegSegment(0xc4, joinBytes(dc, ac, as(dc, 1), as(ac, 1))), jpegSegment(0xda, scan), tail);
  return [
    ['flat', flat],
    ['apple layout with restarts', appleLayoutJpeg({ width, height, restartInterval: 4 })],
    ['two quantisation tables and four Huffman tables in single segments', tables],
  ];
}

/** Each variant must be refused: missing, malformed or mismatched tables and references. */
export function photoTableNegatives(width: number, height: number): [string, Uint8Array][] {
  const good = flatJpeg({ width, height });
  const parts = located(good);
  const at = (marker: number, nth = 0) => parts.filter(entry => entry.marker === marker)[nth]!;
  const dqt = at(0xdb), dc = at(0xc4, 0), ac = at(0xc4, 1), frame = at(0xc0), scan = at(0xda);
  const edit = (change: (copy: Uint8Array) => void) => { const copy = good.slice(); change(copy); return copy; };
  const without = (marker: number) => joinBytes(good.subarray(0, 2), ...parts.filter(entry => entry.marker !== marker && entry.marker !== 0xda)
    .map(entry => good.subarray(entry.at, entry.at + 2 + entry.length)), good.subarray(scan.at));
  const q = dqt.at + 4, d = dc.at + 4, a = ac.at + 4, f = frame.at + 4, s = scan.at + 4;
  return [
    ['no quantisation table', without(0xdb)],
    ['no Huffman table', without(0xc4)],
    ['frame and scan only', joinBytes(good.subarray(0, 2), good.subarray(frame.at, frame.at + 2 + frame.length),
      good.subarray(scan.at, scan.at + 2 + scan.length), new Uint8Array([0x01, 0xff, 0xd9]))],
    ['quantisation descriptor 255', edit(copy => { copy[q] = 255; })],
    ['16-bit quantisation precision', flatJpeg({ width, height, dqt16: true })],
    ['quantisation table id 4', edit(copy => { copy[q] = 4; })],
    ['zero quantiser', edit(copy => { copy[q + 1] = 0; })],
    ['quantisation length one byte long', edit(copy => { copy[dqt.at + 3] = copy[dqt.at + 3]! + 1; })],
    ['Huffman descriptor 255', edit(copy => { copy[d] = 255; })],
    ['Huffman table id 2', edit(copy => { copy[d] = 0x02; })],
    ['Huffman class 2', edit(copy => { copy[d] = 0x20; })],
    ['Huffman counts all zero', edit(copy => { copy.fill(0, d + 1, d + 17); })],
    ['Huffman code space overflow', edit(copy => { copy.fill(0, d + 1, d + 17); copy[d + 1] = 255; })],
    ['DC symbol out of range', edit(copy => { copy[d + 17 + 11] = 12; })],
    ['AC symbol with a size above 10', edit(copy => { copy[a + 17] = 0x0b; })],
    ['duplicate component id', edit(copy => { copy[f + 6 + 3] = copy[f + 6]!; })],
    ['quantiser reference to a missing table', edit(copy => { copy[f + 6 + 2] = 3; })],
    ['quantiser reference above 3', edit(copy => { copy[f + 6 + 2] = 4; })],
    ['zero sampling', edit(copy => { copy[f + 6 + 1] = 0; })],
    ['oversized sampling', edit(copy => { copy[f + 6 + 1] = 0x44; copy[f + 6 + 4] = 0x44; })],
    ['scan component id not in the frame', edit(copy => { copy[s + 1] = 99; })],
    ['scan components out of order', edit(copy => { const first = copy[s + 1]!; copy[s + 1] = copy[s + 3]!; copy[s + 3] = first; })],
    ['scan selects a missing Huffman table', edit(copy => { copy[s + 2] = 0x22; })],
    ['scan selector above 3', edit(copy => { copy[s + 2] = 0x40; })],
    ['scan spectral start', edit(copy => { copy[s + 7] = 1; })],
    ['scan spectral end', edit(copy => { copy[s + 8] = 62; })],
    ['scan successive approximation', edit(copy => { copy[s + 9] = 1; })],
    ['scan component count', edit(copy => { copy[s] = 1; })],
  ];
}
