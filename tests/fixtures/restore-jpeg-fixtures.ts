// Synthetic, decodable flat-colour JPEGs for restore tests (Q6). Every block has one DC value and no AC detail, with all
// quantizers 8, so each component's DC coefficient is simply `value - 128`. Baseline, restart-marker, extended and
// progressive variants share one bit writer; hostile variants are built by editing these bytes in the tests.
import { joinBytes, jpegSegment } from './jpeg-helpers';

export type FlatJpegOptions = {
  width: number;
  height: number;
  /** One value per component: [Y] for grey, [Y, Cb, Cr] for colour. */
  colour?: readonly number[];
  sampling?: readonly (readonly [number, number])[];
  mode?: 'baseline' | 'restart' | 'extended' | 'progressive';
  restartInterval?: number;
  jfif?: boolean;
  /** Segments placed after JFIF, before the tables. */
  segments?: readonly Uint8Array[];
  dqt16?: boolean;
  /** Huffman table IDs used for the DC and AC tables (baseline allows 0-1). */
  tableId?: number;
};

const JFIF = new Uint8Array([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

class BitWriter {
  private bytes: number[] = [];
  private buffer = 0;
  private count = 0;
  write(value: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit--) {
      this.buffer = (this.buffer << 1) | ((value >> bit) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }
  private flushByte(): void {
    this.bytes.push(this.buffer);
    if (this.buffer === 0xff) this.bytes.push(0);
    this.buffer = 0;
    this.count = 0;
  }
  pad(): void { while (this.count) this.write(1, 1); }
  marker(value: number): void { this.pad(); this.bytes.push(0xff, value); }
  result(): Uint8Array<ArrayBuffer> { this.pad(); return new Uint8Array(this.bytes); }
}

function category(value: number): number {
  let size = 0;
  for (let magnitude = Math.abs(value); magnitude; magnitude >>= 1) size++;
  return size;
}

function writeDc(writer: BitWriter, diff: number): void {
  const size = category(diff);
  // DC table: symbols 0..11, each coded as its own 4-bit number.
  writer.write(size, 4);
  if (size) writer.write(diff >= 0 ? diff : diff + (1 << size) - 1, size);
}
// AC table: 0x00 (EOB) = 00, 0xF0 (ZRL) = 01.
const writeEob = (writer: BitWriter) => writer.write(0, 2);

function dht(tc: number, th: number, counts: number[], values: number[]): Uint8Array<ArrayBuffer> {
  return jpegSegment(0xc4, new Uint8Array([(tc << 4) | th, ...counts, ...values]));
}
const dcTable = (th: number) => dht(0, th, [0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const acTable = (th: number) => dht(1, th, [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0x00, 0xf0]);
const u16 = (value: number) => [value >> 8, value & 0xff];

export function flatJpeg(options: FlatJpegOptions): Uint8Array<ArrayBuffer> {
  const { width, height, mode = 'baseline', jfif = true, tableId = 0 } = options;
  const colour = options.colour ?? [180, 110, 150];
  const count = colour.length;
  const sampling = options.sampling ?? (count === 1 ? [[1, 1]] : [[2, 2], [1, 1], [1, 1]]);
  const hmax = Math.max(...sampling.map(([h]) => h)), vmax = Math.max(...sampling.map(([, v]) => v));
  const dc = colour.map(value => Math.round(value) - 128);
  const restart = mode === 'restart' ? options.restartInterval ?? 1 : 0;
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (jfif) parts.push(jpegSegment(0xe0, JFIF));
  parts.push(...options.segments ?? []);
  parts.push(options.dqt16
    ? jpegSegment(0xdb, new Uint8Array([0x10, ...Array.from({ length: 64 }, () => [0, 8]).flat()]))
    : jpegSegment(0xdb, new Uint8Array([0x00, ...new Array<number>(64).fill(8)])));
  const frameMarker = mode === 'progressive' ? 0xc2 : mode === 'extended' ? 0xc1 : 0xc0;
  parts.push(jpegSegment(frameMarker, new Uint8Array([8, ...u16(height), ...u16(width), count,
    ...sampling.flatMap(([h, v], index) => [index + 1, (h << 4) | v, 0])])));
  parts.push(dcTable(tableId), acTable(tableId));
  if (restart) parts.push(jpegSegment(0xdd, new Uint8Array(u16(restart))));
  const sos = (components: number[], ss: number, se: number) => jpegSegment(0xda, new Uint8Array([components.length,
    ...components.flatMap(index => [index + 1, (tableId << 4) | tableId]), ss, se, 0]));
  const mcus = Math.ceil(width / (8 * hmax)) * Math.ceil(height / (8 * vmax));
  const all = colour.map((_, index) => index);
  if (mode !== 'progressive') {
    parts.push(sos(all, 0, 63));
    const writer = new BitWriter();
    let predictors = new Array<number>(count).fill(0), marker = 0;
    for (let mcu = 0; mcu < mcus; mcu++) {
      if (restart && mcu && mcu % restart === 0) {
        writer.marker(0xd0 + (marker++ % 8));
        predictors = new Array<number>(count).fill(0);
      }
      for (const index of all) {
        for (let block = 0; block < sampling[index]![0] * sampling[index]![1]; block++) {
          writeDc(writer, dc[index]! - predictors[index]!);
          predictors[index] = dc[index]!;
          writeEob(writer);
        }
      }
    }
    parts.push(writer.result());
  } else {
    parts.push(sos(all, 0, 0));
    const first = new BitWriter();
    const predictors = new Array<number>(count).fill(0);
    for (let mcu = 0; mcu < mcus; mcu++) {
      for (const index of all) {
        for (let block = 0; block < sampling[index]![0] * sampling[index]![1]; block++) {
          writeDc(first, dc[index]! - predictors[index]!);
          predictors[index] = dc[index]!;
        }
      }
    }
    parts.push(first.result());
    for (const index of all) {
      parts.push(sos([index], 1, 63));
      const writer = new BitWriter();
      const [h, v] = sampling[index]!;
      const blocks = Math.ceil(Math.ceil(width * h / hmax) / 8) * Math.ceil(Math.ceil(height * v / vmax) / 8);
      // EOB0 (an end-of-band run of one) for every block.
      for (let block = 0; block < blocks; block++) writeEob(writer);
      parts.push(writer.result());
    }
  }
  parts.push(new Uint8Array([0xff, 0xd9]));
  return joinBytes(...parts);
}

/** Byte offset of the first marker `marker` outside entropy data, or -1. */
export function findMarker(bytes: Uint8Array, marker: number): number {
  return findMarkers(bytes, marker)[0] ?? -1;
}

/** Byte offsets of every marker `marker` outside entropy data. */
export function findMarkers(bytes: Uint8Array, marker: number): number[] {
  const found: number[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return found;
    const current = bytes[offset + 1]!;
    if (current === marker) found.push(offset);
    if (current === 0xd9) return found;
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    if (current === 0xda) {
      let position = offset + 2 + length;
      while (position + 1 < bytes.length && !(bytes[position] === 0xff && bytes[position + 1] !== 0 && (bytes[position + 1]! < 0xd0 || bytes[position + 1]! > 0xd7))) position++;
      offset = position;
      continue;
    }
    offset += 2 + length;
  }
  return found;
}
