// Restore (Q6): decides, without decoding pixels, whether a backup photo can be stored with its bytes unchanged.
// Only the app's own encoder profile is kept as it is: one baseline frame and one complete scan, JFIF as the only
// APP segment and every table validated. Anything else that parses safely is re-encoded; anything malformed, over a
// budget or changing the dimensions is refused before a decoder starts. This checks structure only: it is not a proof
// of where a photo came from, and says nothing about what its pixels contain.
import { ImagePreparationError, JPEG_LIMITS, readJpegHeader, type ImagePreparationErrorCode } from './jpeg.ts';

export type RestoreJpegVerdict = { kind: 'preserve' } | { kind: 'reencode'; reason: 'metadata' | 'encoding' };
export const RESTORE_JPEG_BUDGET = Object.freeze({ segments: 512, scans: 32, fill: 1024 });

type Component = { id: number; h: number; v: number; tq: number };
type Frame = { marker: number; width: number; height: number; components: Component[]; hmax: number; vmax: number };
type Huffman = { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; values: Uint8Array };
type ScanComponent = { component: Component; dc: Huffman; ac: Huffman };

function fail(code: ImagePreparationErrorCode = 'invalid'): never {
  throw new ImagePreparationError(code);
}

// JPEG F.2.2.3 decoding tables; the code space is checked the way libjpeg checks it (no all-ones code).
function huffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
  let code = 0, index = 0;
  for (let length = 1; length <= 16; length++) {
    const count = counts[length - 1]!;
    if (count) {
      valptr[length] = index;
      mincode[length] = code;
      code += count;
      index += count;
      maxcode[length] = code - 1;
    }
    if (code >= 1 << length) fail();
    code <<= 1;
  }
  return { maxcode, valptr, mincode, values };
}

class BitReader {
  private buffer = 0;
  private count = 0;
  private readonly bytes: Uint8Array;
  position: number;
  constructor(bytes: Uint8Array, position: number) { this.bytes = bytes; this.position = position; }
  private byte(): number {
    const bytes = this.bytes, position = this.position;
    if (position >= bytes.length) fail();
    const value = bytes[position]!;
    if (value === 0xff) {
      // Inside the counted blocks only a stuffed 0xFF 0x00 may appear; any marker there is extra or missing data.
      if (position + 1 >= bytes.length || bytes[position + 1] !== 0x00) fail();
      this.position = position + 2;
    } else this.position = position + 1;
    return value;
  }
  bit(): number {
    if (this.count === 0) { this.buffer = this.byte(); this.count = 8; }
    this.count--;
    return (this.buffer >> this.count) & 1;
  }
  skip(bits: number): void { for (let index = 0; index < bits; index++) this.bit(); }
  decode(table: Huffman): number {
    let code = this.bit(), length = 1;
    while (code > table.maxcode[length]!) {
      if (++length > 16) fail();
      code = (code << 1) | this.bit();
    }
    return table.values[table.valptr[length]! + code - table.mincode[length]!]!;
  }
  // After the last block only 1-bit padding may remain in the current byte.
  padded(): boolean { return (this.buffer & ((1 << this.count) - 1)) === (1 << this.count) - 1; }
}

// Walks every Huffman code of a baseline sequential scan (no IDCT): exactly the frame's blocks, then padding and a marker.
// The caller decides whether that marker may follow: only EOI, straight after, keeps the bytes.
function walkBaseline(bytes: Uint8Array, start: number, frame: Frame, scan: readonly ScanComponent[]): number {
  const reader = new BitReader(bytes, start);
  const block = (entry: ScanComponent) => {
    const size = reader.decode(entry.dc);
    if (size > 11) fail();
    reader.skip(size);
    for (let k = 1; k < 64;) {
      const symbol = reader.decode(entry.ac), run = symbol >> 4, size = symbol & 15;
      if (size === 0) {
        if (run === 0) break;
        if (run !== 15) fail();
        k += 16;
        if (k > 64) fail();
        continue;
      }
      if (size > 10) fail();
      k += run;
      if (k > 63) fail();
      reader.skip(size);
      k++;
    }
  };
  if (scan.length === 1) {
    const { component } = scan[0]!;
    const columns = Math.ceil(Math.ceil(frame.width * component.h / frame.hmax) / 8);
    const rows = Math.ceil(Math.ceil(frame.height * component.v / frame.vmax) / 8);
    for (let index = 0; index < columns * rows; index++) block(scan[0]!);
  } else {
    const units = Math.ceil(frame.width / (8 * frame.hmax)) * Math.ceil(frame.height / (8 * frame.vmax));
    for (let unit = 0; unit < units; unit++) {
      for (const entry of scan) for (let index = 0; index < entry.component.h * entry.component.v; index++) block(entry);
    }
  }
  if (!reader.padded()) fail();
  const end = reader.position;
  if (end + 1 >= bytes.length || bytes[end] !== 0xff || bytes[end + 1] === 0x00) fail();
  return end;
}

// Legal fill: any number of 0xFF bytes before a marker, within one budget for the whole file. Returns the offset of the
// 0xFF that starts the marker itself.
function skipFill(bytes: Uint8Array, position: number, budget: { fill: number }): number {
  while (position + 1 < bytes.length && bytes[position + 1] === 0xff) {
    if (++budget.fill > RESTORE_JPEG_BUDGET.fill) fail('tooLarge');
    position++;
  }
  if (position + 1 >= bytes.length) fail();
  return position;
}

// Entropy data outside the preserved profile: stuffed bytes, and restart markers only with a restart interval.
function skipScan(bytes: Uint8Array, start: number, restarts: boolean, budget: { fill: number }): number {
  let position = start;
  while (position < bytes.length) {
    if (bytes[position] !== 0xff) { position++; continue; }
    if (position + 1 >= bytes.length) fail();
    if (bytes[position + 1] === 0x00) { position += 2; continue; }
    const marker = skipFill(bytes, position, budget), next = bytes[marker + 1]!;
    if (next >= 0xd0 && next <= 0xd7) { if (!restarts) fail(); position = marker + 2; continue; }
    return marker;
  }
  return fail();
}

const isJfif = (bytes: Uint8Array, start: number, end: number) => end - start === 14
  && [0x4a, 0x46, 0x49, 0x46, 0].every((value, index) => bytes[start + index] === value)
  && bytes[end - 2] === 0 && bytes[end - 1] === 0;

/**
 * Reads the whole file once with increasing offsets and a bounds check before every read. Throws for input that is
 * malformed, over a limit, or not exactly `width` x `height` in its frame header.
 */
export function inspectRestoreJpeg(bytes: Uint8Array, width: number, height: number,
  limits: { bytes: number; side: number } = { bytes: JPEG_LIMITS.mainBytes, side: JPEG_LIMITS.mainSide }): RestoreJpegVerdict {
  if (bytes.length > limits.bytes) fail('tooLarge');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
  let offset = 2, segments = 0, scans = 0;
  let frame: Frame | undefined;
  let metadata = false, encoding = false, app0 = 0, restart = 0, walked = false;
  const budget = { fill: 0 };
  const quant = new Set<number>(), dc = new Map<number, Huffman>(), ac = new Map<number, Huffman>();
  const scanned = new Set<number>();
  for (;;) {
    if (++segments > RESTORE_JPEG_BUDGET.segments) fail('tooLarge');
    if (offset + 2 > bytes.length || bytes[offset] !== 0xff) fail();
    const filled = skipFill(bytes, offset, budget);
    // Fill bytes are legal but never part of the app's own output.
    if (filled !== offset) { encoding = true; offset = filled; }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) {
      if (offset !== bytes.length || !frame || scans === 0) fail();
      break;
    }
    // Stray restart/TEM markers, a second SOI and reserved or hierarchical markers are refused.
    if (marker === 0xff || marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)
      || marker < 0xc0 || (marker >= 0xf0 && marker <= 0xfd) || [0xc8, 0xcc, 0xdc, 0xde, 0xdf].includes(marker)) fail('unsupported');
    if (offset + 2 > bytes.length) fail();
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.length) fail();
    const start = offset + 2, end = offset + length;
    offset = end;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (scans) fail();
      if (marker === 0xe0 && ++app0 === 1 && segments === 1 && isJfif(bytes, start, end)) continue;
      metadata = true;
      continue;
    }
    if (marker === 0xdb) {
      if (scans || start === end) fail();
      for (let position = start; position < end;) {
        const precision = bytes[position]! >> 4, table = bytes[position]! & 15;
        if (precision > 1 || table > 3) fail();
        const size = precision ? 128 : 64;
        if (position + 1 + size > end) fail();
        for (let index = 0; index < 64; index++) {
          const at = position + 1 + index * (precision ? 2 : 1);
          if ((precision ? bytes[at]! * 256 + bytes[at + 1]! : bytes[at]!) === 0) fail();
        }
        if (precision) encoding = true;
        quant.add(table);
        position += 1 + size;
      }
      continue;
    }
    if (marker === 0xc4) {
      if (start === end) fail();
      for (let position = start; position < end;) {
        const kind = bytes[position]! >> 4, table = bytes[position]! & 15;
        if (kind > 1 || table > 3 || position + 17 > end) fail();
        const counts = bytes.subarray(position + 1, position + 17);
        const total = counts.reduce((sum, count) => sum + count, 0);
        if (!total || total > 256 || position + 17 + total > end) fail();
        const values = bytes.subarray(position + 17, position + 17 + total);
        for (const value of values) if (kind === 0 ? value > 11 : (value & 15) > 10) fail();
        (kind ? ac : dc).set(table, huffman(counts, values));
        if (table > 1) encoding = true;
        position += 17 + total;
      }
      continue;
    }
    if (marker === 0xdd) {
      if (scans || length !== 4) fail();
      restart = bytes[start]! * 256 + bytes[start + 1]!;
      encoding = true;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf) {
      // Only baseline, extended sequential and progressive Huffman frames are read; exactly one of them.
      if (marker > 0xc2) fail('unsupported');
      if (frame || scans || end - start < 6) fail();
      if (bytes[start] !== 8) fail('unsupported');
      const frameHeight = bytes[start + 1]! * 256 + bytes[start + 2]!, frameWidth = bytes[start + 3]! * 256 + bytes[start + 4]!;
      if (!frameWidth || !frameHeight) fail();
      if (frameWidth > limits.side || frameHeight > limits.side) fail('tooLarge');
      if (frameWidth !== width || frameHeight !== height) fail();
      const count = bytes[start + 5]!;
      if (![1, 3, 4].includes(count)) fail('unsupported');
      if (end - start !== 6 + 3 * count) fail();
      const components: Component[] = [];
      for (let index = 0; index < count; index++) {
        const at = start + 6 + index * 3, sampling = bytes[at + 1]!;
        const component = { id: bytes[at]!, h: sampling >> 4, v: sampling & 15, tq: bytes[at + 2]! };
        if (components.some(entry => entry.id === component.id) || component.h < 1 || component.h > 4
          || component.v < 1 || component.v > 4 || component.tq > 3) fail();
        components.push(component);
      }
      if (count > 1 && components.reduce((sum, entry) => sum + entry.h * entry.v, 0) > 10) fail();
      // Four components (CMYK) decode, but the app never writes them.
      if (marker !== 0xc0 || count === 4) encoding = true;
      frame = { marker, width: frameWidth, height: frameHeight, components,
        hmax: Math.max(...components.map(entry => entry.h)), vmax: Math.max(...components.map(entry => entry.v)) };
      continue;
    }
    if (marker === 0xda) {
      if (!frame) fail();
      if (++scans > RESTORE_JPEG_BUDGET.scans) fail('tooLarge');
      const count = bytes[start]!;
      if (count < 1 || count > frame.components.length || end - start !== 4 + 2 * count) fail();
      const selected: { component: Component; dc: number; ac: number }[] = [];
      let previous = -1;
      for (let index = 0; index < count; index++) {
        const id = bytes[start + 1 + index * 2]!, tables = bytes[start + 2 + index * 2]!;
        const position = frame.components.findIndex(entry => entry.id === id);
        if (position <= previous || (tables >> 4) > 3 || (tables & 15) > 3) fail();
        previous = position;
        selected.push({ component: frame.components[position]!, dc: tables >> 4, ac: tables & 15 });
      }
      for (const entry of selected) if (!quant.has(entry.component.tq)) fail();
      if (count > 1 && selected.reduce((sum, entry) => sum + entry.component.h * entry.component.v, 0) > 10) fail();
      const spectralStart = bytes[end - 3]!, spectralEnd = bytes[end - 2]!;
      const high = bytes[end - 1]! >> 4, low = bytes[end - 1]! & 15;
      if (frame.marker !== 0xc2) {
        if (spectralStart !== 0 || spectralEnd !== 63 || high || low) fail();
        for (const entry of selected) {
          if (scanned.has(entry.component.id) || !dc.has(entry.dc) || !ac.has(entry.ac)) fail();
          scanned.add(entry.component.id);
        }
      } else {
        if (spectralStart > spectralEnd || spectralEnd > 63 || (spectralStart === 0) !== (spectralEnd === 0)
          || (spectralStart > 0 && count !== 1) || high > 13 || low > 13 || (high && low !== high - 1)) fail();
        for (const entry of selected) {
          if ((spectralStart === 0 ? !high && !dc.has(entry.dc) : !ac.has(entry.ac))) fail();
          if (spectralStart === 0 && !high) scanned.add(entry.component.id);
        }
      }
      if (frame.marker === 0xc0 && scans === 1 && !restart && count === frame.components.length) {
        offset = walkBaseline(bytes, end, frame, selected.map(entry => ({ component: entry.component,
          dc: dc.get(entry.dc)!, ac: ac.get(entry.ac)! })));
        walked = true;
        // Only EOI may follow the counted scan in a kept photo: no tables, fill bytes or anything else before it.
        if (bytes[offset + 1] !== 0xd9) encoding = true;
      } else {
        offset = skipScan(bytes, end, restart > 0, budget);
        encoding = true;
      }
      continue;
    }
    fail('unsupported');
  }
  if (scanned.size !== frame!.components.length) fail();
  if (metadata) return { kind: 'reencode', reason: 'metadata' };
  if (encoding || !walked || scans !== 1) return { kind: 'reencode', reason: 'encoding' };
  return { kind: 'preserve' };
}

/**
 * The checks a restore makes on each backup file while reading it, before any decoder starts (shared with
 * scripts/verify-backup.mjs). A main photo gets the full structural check above and returns its verdict. A thumbnail is
 * never stored from a backup (a new one is made from the main photo), so it only has to be a JPEG within the thumbnail
 * side and byte limits; its hash and length are checked by the backup reader. Throws ImagePreparationError otherwise.
 */
export function checkRestoreJpeg(bytes: Uint8Array, variant: 'main' | 'thumb', width: number, height: number): RestoreJpegVerdict | null {
  if (variant === 'main') return inspectRestoreJpeg(bytes, width, height);
  const header = readJpegHeader(bytes);
  if (header.width > JPEG_LIMITS.thumbSide || header.height > JPEG_LIMITS.thumbSide || bytes.length > JPEG_LIMITS.thumbBytes) fail('tooLarge');
  return null;
}