export class PromptError extends Error { problem: 'tooLong' | 'cancelled'; constructor(problem: 'tooLong' | 'cancelled'); }
export function readPipedInput(stream: AsyncIterable<Uint8Array | string>, limit: number): Promise<Buffer>;
import type { EventEmitter } from 'node:events';
export type TerminalInput = EventEmitter & { setRawMode(value: boolean): unknown; setEncoding(encoding: string): unknown; resume(): unknown; pause(): unknown };
export function readTerminalLine(options: {
  input: TerminalInput; output: { write(text: string): unknown }; prompt: string; hidden: boolean; limit: number; overflow?: 'error' | 'ignore';
}): Promise<string>;
