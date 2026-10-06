import { test, type Page } from '@playwright/test';
import { CLEANUP_NOTICE_REVISION } from '../../src/domain/enhancement';
import type { Language } from '../../src/i18n/all';
import type { BackgroundTestHook } from '../../src/images/background/test-hook';
import { aiFixture } from './ai-photo-first-support';
import { owners, type EnhanceReply, type EnhanceReplyValue, type EnhanceSetup } from './mock-backend';

// Shared by enhancement.spec and bulk-upload.spec: the background-removal hook, synthetic photos and a stand-in provider.
export async function hook(page: Page, value: BackgroundTestHook) {
  await page.addInitScript((initial) => { window.__stillroomBackground = { log: [], ...initial }; }, { enabled: true, ...value });
  // Playwright's WebKit route interception reports an empty body for Blob uploads, so on that engine the mocked
  // provider would see no photo. Only the enhance-photo request is re-sent with the same bytes as an ArrayBuffer.
  if (test.info().project.name === 'webkit-photo') {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/functions/v1/enhance-photo') && init?.body instanceof Blob) {
          return original(input, { ...init, body: await init.body.arrayBuffer() });
        }
        return original(input, init);
      };
    });
  }
}
export const removals = (page: Page) => page.evaluate(() => (window.__stillroomBackground?.log ?? []).length);
export async function syntheticPhoto(page: Page, shade = '#1f3a93'): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async (fill) => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 800 });
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d9d9d9'; context.fillRect(0, 0, 640, 800);
    context.fillStyle = fill; context.fillRect(60, 160, 220, 480);
    context.fillStyle = '#d12c2c'; context.fillRect(380, 300, 180, 200);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, shade));
}
// A stand-in for the provider: the sent photo (H0) redrawn at exactly 1024 x 1280 by the page's own JPEG encoder, with
// everything but the dark, not-red garment painted #F6F3ED. So it passes the shared admission profile and the clean-up
// check like a faithful clean-up would: a plain background, the grey backdrop and the red neighbour removed.
export async function redraw(page: Page, bytes: Buffer, width = 1024, height = 1280): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async ([data, w, h]) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const context = canvas.getContext('2d')!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const image = context.getImageData(0, 0, w, h), px = image.data;
    for (let at = 0; at < px.length; at += 4) {
      const [r, g, b] = [px[at]!, px[at + 1]!, px[at + 2]!];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < 150 && r <= Math.max(g, b)) continue;
      px[at] = 0xf6; px[at + 1] = 0xf3; px[at + 2] = 0xed;
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('encode')), 'image/jpeg', 0.9));
    // The app's own encoder clean-up (served by the dev server), as a provider result that passes admission unchanged.
    const jpeg = '/src/images/jpeg.ts';
    const { stripEncoderMetadata } = await import(/* @vite-ignore */ jpeg) as { stripEncoderMetadata: (value: Uint8Array) => Uint8Array };
    return [...stripEncoderMetadata(new Uint8Array(await blob.arrayBuffer()))];
  }, [[...bytes], width, height] as const));
}
export const enhanced = (page: Page, over: Partial<EnhanceReplyValue> = {}): EnhanceReply => async (bytes) => ({ status: 200, image: await redraw(page, bytes), ...over });
export const held = (reply: EnhanceReply) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wrapped: EnhanceReply = async (bytes, owner, requestId) => {
    const value = typeof reply === 'function' ? await reply(bytes, owner, requestId) : reply;
    return { ...value, hold: gate };
  };
  return { reply: wrapped, release: () => release() };
};

export type Start = { language?: Language; setup?: Partial<EnhanceSetup>; consent?: boolean; background?: BackgroundTestHook; lost?: 'reservation' };
export async function start(page: Page, options: Start = {}) {
  await hook(page, options.background ?? { mask: 'left' });
  const api = await aiFixture(page, options.language ?? 'en', true, options.lost);
  api.enhanceControl.setup[owners.a] = { activated: true, ...options.setup };
  api.enhanceControl.consent[owners.a] = options.consent === false ? null : CLEANUP_NOTICE_REVISION;
  return api;
}
