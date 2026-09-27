import type { InventoryFile } from './check-static-assets.mjs';
export type DeployedAsset = { path: string; status: number; bytes: number; sha256: string; problems: string[] };
export function checkDeployedAssets(origin: string, inventory: readonly InventoryFile[],
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>): Promise<DeployedAsset[]>;
