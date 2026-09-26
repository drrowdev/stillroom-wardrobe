import type { JpegCheck, PartSource } from '../src/domain/export-format.ts';
export type Listing = { count: number; exportId: string; paths: Map<number, { path: string; size: number; limit: number }> };
export function parseArguments(argv: string[]): { directory: string; decode: boolean };
export function restoreReadiness(): { check: JpegCheck; tally: { kept: number; encoded: number } };
export function decodedReadiness(listing: Listing, passphrase: string): Promise<unknown>;
export const checkJpeg: JpegCheck;
export function listParts(directory: string, limits?: Record<string, number>): Promise<Listing>;
export function partSource(listing: Listing): PartSource & { exportId: string };
