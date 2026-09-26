// The only code the Node restore CLI (scripts/restore-own.mjs) runs in Chromium: the browser's own restore image steps,
// taking and returning base64 so no file, credential or network access is needed. It does not start the app and imports
// nothing about accounts, storage or the network. scripts/restore-image-page.mjs builds it in memory and serves it to an
// isolated page.
import { decodedSize, thumbnailFromMain } from './process-jpeg';
import { prepareImage } from './process-image';
import { ORIGINAL_EDIT } from './crop';
import { ImagePreparationError } from './jpeg';

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

function toBlob(base64: string): Blob {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return new Blob([bytes], { type: 'image/jpeg' });
}
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}
async function run<T>(action: () => Promise<T>): Promise<Outcome<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, code: error instanceof ImagePreparationError ? error.code : 'invalid' }; }
}

const api = Object.freeze({
  decodedSize: (main: string) => run(() => decodedSize(toBlob(main))),
  reencode: (main: string) => run(async () => {
    const photo = await prepareImage(toBlob(main), undefined, ORIGINAL_EDIT);
    return { main: await toBase64(photo.main), thumb: await toBase64(photo.thumb), width: photo.width, height: photo.height,
      mainSha256: photo.mainSha256, thumbSha256: photo.thumbSha256 };
  }),
  thumbnail: (main: string, width: number, height: number) => run(async () => {
    const thumb = await thumbnailFromMain(toBlob(main), width, height);
    return { blob: await toBase64(thumb.blob), sha256: thumb.sha256, width: thumb.width, height: thumb.height };
  }),
});
Object.defineProperty(globalThis, 'stillroomRestoreImages', { value: api, writable: false, configurable: false });
