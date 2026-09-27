export type InventoryFile = { role: 'model' | 'runtime'; path: string; source: string; bytes: number; sha256: string };
export const pagesLimits: Readonly<{ files: number; fileBytes: number }>;
export const inventoryPath: string;
export function parseInventory(value: unknown): InventoryFile[];
export function readInventory(file?: string): Promise<InventoryFile[]>;
export function listTree(root: string, prefix?: string): Promise<string[]>;
export function sha256(bytes: Uint8Array | string): string;
export function checkStaticTree(dist: string, inventory: readonly InventoryFile[]): Promise<string[]>;
