import inventory from './model-assets.json' with { type: 'json' };

// The exact public files background removal may fetch (ADR24). The build, the deploy check and the loader all
// read this one inventory; a changed, missing or extra binary fails the build.
export type ModelAsset = { role: 'model' | 'runtime'; path: string; source: string; bytes: number; sha256: string };

export const modelAssets = inventory.files as readonly ModelAsset[];
export const modelAsset = (role: ModelAsset['role']): ModelAsset => modelAssets.find((file) => file.role === role)!;
export const modelAssetBytes = modelAssets.reduce((sum, file) => sum + file.bytes, 0);
export const modelCacheName = 'stillroom-model-v1';
