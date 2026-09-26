import type { Browser, BrowserContext, Page } from '@playwright/test';
export const PAGE_ORIGIN: string;
export const PAGE_URL: string;
export const SCRIPT_URL: string;
export const PAGE_CSP: string;
export const ENTRY: string;
export class ImagePageError extends Error { code: string; constructor(code: string); }
export function buildImageBundle(): Promise<string>;
export function chromiumPath(): Promise<string>;
export function launchImageBrowser(options?: { timeout?: number; env?: Record<string, string | undefined> }): Promise<Browser>;
export function openImagePage(browser: Browser, code: string, options?: { onRequest?: (request: { url: string; method: string }) => void }):
  Promise<{ page: Page; context: BrowserContext; call: (name: string, ...args: unknown[]) => Promise<unknown> }>;