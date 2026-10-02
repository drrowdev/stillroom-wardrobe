import type { Plugin } from 'vite';

export type CatalogueLanguage = 'en' | 'fi' | 'sv';
export type CatalogueEntry = { fileName: string; source: string; sha256: string };
export type Catalogues = { keyCount: number; catalogues: Record<CatalogueLanguage, CatalogueEntry> };
export const catalogueLanguages: CatalogueLanguage[];
export const catalogueSources: string[];
export const virtualId: string;
export function buildCatalogues(sources: ReadonlyArray<Record<string, Record<string, string>>>): Catalogues;
export function readCatalogues(root?: string): Catalogues;
export function descriptorSource(catalogues: Catalogues): string;
export function cataloguePlugin(options?: { emit?: boolean }): Plugin;
