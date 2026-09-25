export type BundleRow = { file: string; raw: number; gzip: number; kind: 'initial' | 'lazy' | 'css' };
export type BundleResult = { report: BundleRow[]; initial: string[]; initialJsGzip: number; styles: string[]; violations: string[] };
export type BundleBudgets = { initialJsGzipBytes: number; chunkRawBytes: number; lazyChunkGzipBytes: number };
export const bundleBudgets: Readonly<BundleBudgets>;
export function entryAssets(indexHtml: string): { entry: string; preloads: string[]; styles: string[] };
export function staticImports(code: string): string[];
export function evaluateBundle(indexHtml: string, files: Map<string, Buffer>, budgets?: BundleBudgets): BundleResult;
export function checkDist(dist: string): Promise<BundleResult>;