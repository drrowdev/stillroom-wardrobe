import type { StylistInput, StylistRequest } from '../../src/domain/stylist.ts';
import type { AzureUsage } from '../../supabase/functions/analyze-clothing/azure-openai.ts';
import type { StylistOutcome } from '../../supabase/functions/stylist-chat/azure.ts';

export type Slot = 'min' | 'max';
export const SLOTS: readonly Slot[];
export const SOURCE_PATHS: readonly string[];
export const PROBE: Readonly<{
  id: string; manifestId: string; valuationMicro: number; minAllocationMicro: number; maxAllocationMicro: number;
  maxMessagesBytesFloor: number; calibrationInputTokens: number; shortCoInputRate: number; shortCoOutputRate: number; keyVariable: string;
}>;
export class ProbeError extends Error { code: string; cleanupCode: string | null; constructor(code: string, cleanupCode?: string | null); }
export function digest(value: string | Uint8Array): string;
export function utcMonth(ms: number): string;
export const CI_VARIABLES: readonly string[];
export function assertRuntime(options?: { versions?: Record<string, string | undefined>; execArgv?: string[]; env?: Record<string, string | undefined> }): void;
export type Fixture = { input: StylistInput; built: StylistRequest; ingressBytes: number; conversationBytes: number };
export function fixture(slot: Slot): Fixture;
export function bodyDigest(slot: Slot): string;
export function settingsDigest(): string;
export function controlsDigest(): string;
export type Receipt = {
  kind: 'stylist-probe-allocation-v1'; ownerRef: string; allocationMicro: string;
  reply: { code: 'OK'; previousTotalMicro: string; newTotalMicro: string };
  readBack: { monthlyAllowanceMicro: string; stylistMonthlyAllowanceMicro: string };
  allocatedAt: string; approvalRef: string;
};
export function validateReceipt(value: unknown): Receipt;
export function allocationId(receipt: Receipt): string;
export function operatorRoot(): string;
export function gitSource(repo?: string): string;
export type Observation = {
  state: 'OK' | 'FAILED' | 'HALTED' | 'NOT_SENT'; reason: string; httpStatus: number | null; code: StylistOutcome['code'] | null;
  usage: AzureUsage | null; reply: { bytes: number; sha256: string; valid: boolean; outfits: number; dropped: number } | null;
  messagesBytes: number; included: number; omitted: number; startedAt: string | null; finishedAt: string | null;
  elapsedMs: number | null; estimateMicro: string | null;
};
type Options = { root: string; now?: () => number; source?: () => string };
type SlotRecord = { intent: Record<string, unknown> | null; result: Observation | null; reconciled: boolean; recovered: boolean } | null;
export type ProbeRecord = { directory: string; init: Record<string, unknown> & { receipt: Record<string, unknown>; bodies: Record<Slot, string> }; slots: Record<Slot, SlotRecord>; cumulative: number;
  persistence: { pending: boolean; locked: boolean } };
export function initialize(options: Options & { receipt: unknown }): Promise<string>;
export function readRecord(options: { root: string; id: string; source?: () => string;
  readLedger?: (filename: string, limit: number) => Promise<Buffer> }): Promise<ProbeRecord>;
export function verdict(record: ProbeRecord): 'PASS' | 'REVISE_ENVELOPE' | 'INCOMPLETE' | 'UNRESOLVED' | 'HALTED';
export function summary(record: ProbeRecord): Record<string, unknown> & { verdict: string; notes: Record<string, string>; slots: Record<Slot, Record<string, unknown> & { state: string }> };
export function observe(options: { outcome: StylistOutcome | null; httpStatus: number | null; built: StylistRequest;
  startedAt: string; finishedAt: string; elapsedMs: number }): Observation;
type FileSystem = { open: (...args: never[]) => Promise<unknown>; unlink?: (filename: string) => Promise<void> };
export function executeSlot(options: Options & { id: string; slot: string; key: unknown; fetchImpl?: typeof fetch;
  requestMs?: number; fs?: FileSystem }): Promise<Observation>;
export function reconcile(options: Options & { id: string; slot: string }): Promise<void>;
export function recover(options: Options & { id: string; slot: string; fs?: FileSystem }): Promise<void>;
export function parseArguments(args: string[]): { command: string; first: string; second?: string };
export function main(args: string[], options?: { env?: Record<string, string | undefined>; log?: (line: string) => void;
  runtime?: { versions?: { node?: string }; execArgv?: string[] }; root?: string; fetchImpl?: typeof fetch }): Promise<void>;
