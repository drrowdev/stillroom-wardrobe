// Child process for scripts/restore-image-client.mjs: builds the restore image page, starts the locked Playwright
// Chromium and runs one photo step per request. It talks only over the IPC channel (stdout is not used), receives no
// credentials, and starts with a minimal environment and its own temporary folder.
import { buildImageBundle, ImagePageError, launchImageBrowser, openImagePage } from './restore-image-page.mjs';

export const MAX_BASE64 = Math.ceil(512_000 / 3) * 4;
const STEPS = new Set(['decodedSize', 'reencode', 'thumbnail']);
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const side = value => Number.isSafeInteger(value) && value >= 1 && value <= 1600;

/** A request from the parent: `{ type: 'call', id, step, args }` with bounded base64 and sizes. */
export function validRequest(message) {
  if (typeof message !== 'object' || message === null || message.type !== 'call' || !Number.isSafeInteger(message.id) || message.id < 1
    || !STEPS.has(message.step) || !Array.isArray(message.args)) return false;
  const [main, width, height, ...rest] = message.args;
  if (typeof main !== 'string' || main.length > MAX_BASE64 || main.length % 4 !== 0 || !base64.test(main)) return false;
  return message.step === 'thumbnail' ? side(width) && side(height) && rest.length === 0 : message.args.length === 1;
}

async function main() {
  let browser;
  const close = async () => { await browser?.close().catch(() => {}); process.exit(0); };
  process.on('disconnect', close);
  try {
    const code = await buildImageBundle();
    browser = await launchImageBrowser({ env: process.env });
    const { call } = await openImagePage(browser, code);
    let queue = Promise.resolve();
    process.on('message', message => {
      queue = queue.then(async () => {
        if (!validRequest(message)) { process.send({ type: 'result', id: message?.id ?? null, outcome: { ok: false, code: 'invalid' } }); return; }
        let outcome;
        try { outcome = await call(message.step, ...message.args); } catch { outcome = { ok: false, code: 'unavailable' }; }
        process.send({ type: 'result', id: message.id, outcome });
      });
    });
    process.send({ type: 'ready' });
  } catch (error) {
    process.send?.({ type: 'failed', code: error instanceof ImagePageError ? error.code : 'page' });
    await browser?.close().catch(() => {});
    process.exit(1);
  }
}

if (process.send && process.argv[2] === '--serve') main();
