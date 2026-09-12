import { expect, test, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { messages, type Language } from '../../src/i18n';
import { inspectJpegSegments } from '../fixtures/jpeg-helpers';
import { mockBackend, owners, signIn, wireStages, type WireBackend, type WireStage } from './mock-backend';
import { manualEntry } from './ai-photo-first-support';

function reserveWireImage(backend: Awaited<ReturnType<typeof mockBackend>>, owner = owners.a) {
  const item = randomUUID(), image = randomUUID();
  const prefix = `${owner}/${item}/${image}`;
  backend.items.push({ id: item, owner_id: owner });
  backend.images.push({ id: image, item_id: item, owner_id: owner, main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg` });
  return `${prefix}/main.jpg`;
}

function assertWireBytes(actual: Buffer, expected: Buffer) {
  expect(actual.length).toBeGreaterThan(0);
  expect(actual.length).toBe(expected.length);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
}

test('actual upload wire preserves binary bytes and the oracle detects corruption', async ({ page }, testInfo) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  const path = reserveWireImage(backend);
  const sent = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256));
  const observed = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith(path));
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(path));
  const result = await page.evaluate(async ({ path, bytes }) => {
    const modulePath = '/src/data/client.ts';
    const { makeClient } = await import(modulePath) as typeof import('../../src/data/client');
    const client = makeClient({ url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_browser_fixture_only', version: 'browser-fixture' });
    const result = await client.storage.from('wardrobe').upload(path, new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }),
      { contentType: 'image/jpeg', upsert: false, cacheControl: '0' });
    return { ok: !result.error, data: result.data };
  }, { path, bytes: [...sent] });
  expect(result).toEqual({ ok: true, data: { path, id: 'fixture', fullPath: `wardrobe/${path}` } });
  const actual = backend.files.get(path)!;
  assertWireBytes(actual, sent);
  expect(backend.uploadWire.posts).toBe(1);
  expect(backend.uploadWire.payloadBytes).toBe(4096);
  expect(backend.uploadWire.receivedBytes).toBeGreaterThan(4096);
  const headers = (await responsePromise).headers();
  expect(headers['access-control-allow-origin']).toBe(new URL(page.url()).origin);
  expect(headers['access-control-allow-methods']).toBe('POST, OPTIONS');
  expect(headers['access-control-allow-headers']).toBe('authorization, apikey, content-type, x-upsert, x-client-info');
  expect(headers['access-control-allow-credentials']).toBeUndefined();
  const perturbed = Buffer.from(sent);
  perturbed[100] = perturbed[100]! ^ 1;
  expect(() => assertWireBytes(actual, perturbed)).toThrow();
  expect(() => assertWireBytes(actual, sent.subarray(1))).toThrow();
  // Inspector data is only a comparison, never the receiver's input or an upload oracle.
  const request = await observed;
  const inspector = request.postDataBuffer();
  let inspectedFileBytes: number | null = null;
  if (inspector) {
    try {
      const form = await new Response(new Uint8Array(inspector), { headers: { 'content-type': request.headers()['content-type']! } }).formData();
      const file = form.get('');
      if (file instanceof Blob) inspectedFileBytes = file.size;
    } catch { /* Some engines expose an incomplete multipart representation. */ }
  }
  testInfo.annotations.push({ type: 'synthetic-wire', description: JSON.stringify({
    payloadBytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex'),
    inspectedFileBytes, receiverPreflights: backend.uploadWire.preflights,
    interceptedPreflights: backend.requests.filter((request) => request.method === 'OPTIONS').length,
  }) });
  await page.close();
  await expect.poll(() => ({ listening: backend.uploadWire.listening, connections: backend.uploadWire.connections }))
    .toEqual({ listening: false, connections: 0 });
});

type WireForm = 'valid' | 'missing' | 'empty' | 'ambiguous' | 'multiple' | 'wrong-name' | 'wrong-type' |
  'duplicate-cache' | 'metadata-file' | 'malformed' | 'truncated' | 'oversized' | 'wrong-key' | 'wrong-bearer' | 'upsert';
type WireResult = {
  status: number | null; ok: boolean;
  diagnostic?: { backend: WireBackend | 'none'; stage: WireStage; parse: 'ok' | 'unrecognized' | 'unavailable' | 'no-response' };
};
async function sendWireForm(page: Page, path: string, formKind: WireForm, bytes = [0, 128, 255, 13, 10],
  diagnostic = false): Promise<WireResult> {
  return page.evaluate(async ({ path, formKind, bytes, diagnostic, stages }): Promise<WireResult> => {
    const modulePath = '/src/data/client.ts';
    const { makeClient } = await import(modulePath) as typeof import('../../src/data/client');
    const client = makeClient({ url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_browser_fixture_only', version: 'browser-fixture' });
    const { data } = await client.auth.getSession();
    const headers: Record<string, string> = {
      authorization: 'Bearer ' + (formKind === 'wrong-bearer' ? 'not-an-issued-fixture' : data.session!.access_token),
      apikey: formKind === 'wrong-key' ? 'sb_publishable_wrong_fixture' : 'sb_publishable_browser_fixture_only',
      'x-upsert': formKind === 'upsert' ? 'true' : 'false',
      'x-client-info': 'synthetic-wire-test',
    };
    const form = new FormData();
    form.append('cacheControl', '0');
    if (formKind === 'duplicate-cache') form.append('cacheControl', '0');
    if (formKind !== 'missing') {
      const payload = formKind === 'empty' ? new Uint8Array() :
        formKind === 'oversized' ? new Uint8Array(1024 * 1024) : new Uint8Array(bytes);
      const file = new Blob([payload], { type: formKind === 'wrong-type' ? 'text/plain' : 'image/jpeg' });
      form.append(formKind === 'wrong-name' ? 'file' : '', file);
      if (formKind === 'ambiguous') form.append('', file);
      if (formKind === 'multiple') form.append('other', file);
      if (formKind === 'metadata-file') form.append('metadata', file);
    }
    if (formKind === 'valid') form.append('metadata', '{"fixture":true}');
    let body: FormData | string = form;
    if (formKind === 'malformed' || formKind === 'truncated') {
      headers['content-type'] = 'multipart/form-data; boundary=fixture-boundary';
      body = formKind === 'malformed' ? '--fixture-boundary\r\nnot-a-header\r\n\r\nbytes\r\n--fixture-boundary--\r\n' :
        '--fixture-boundary\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n0';
    }
    try {
      const response = await fetch('http://127.0.0.1:54321/storage/v1/object/wardrobe/' + path,
        { method: 'POST', headers, body, credentials: 'omit' });
      const result = { status: response.status, ok: response.ok };
      if (!diagnostic) return result;
      try {
        const value: unknown = await response.json();
        const backend = typeof value === 'object' && value !== null && 'wireBackend' in value &&
          (value.wireBackend === 'first' || value.wireBackend === 'second') ? value.wireBackend : 'none';
        const stage = typeof value === 'object' && value !== null && 'wireStage' in value ?
          stages.find((stage) => stage === value.wireStage) : undefined;
        return { ...result, diagnostic: { backend, stage: stage ?? 'none', parse: backend !== 'none' && stage ? 'ok' : 'unrecognized' } };
      } catch { return { ...result, diagnostic: { backend: 'none', stage: 'none', parse: 'unavailable' } }; }
    } catch {
      return { status: null, ok: false, ...(diagnostic ? { diagnostic: { backend: 'none', stage: 'none', parse: 'no-response' } as const } : {}) };
    }
  }, { path, formKind, bytes, diagnostic, stages: diagnostic ? wireStages : [] });
}

for (const formKind of ['missing', 'empty', 'ambiguous', 'multiple', 'wrong-name', 'wrong-type',
  'duplicate-cache', 'metadata-file', 'malformed', 'truncated', 'oversized'] satisfies WireForm[]) {
  test(`actual upload wire rejects ${formKind} multipart without storing a file`, async ({ page }) => {
    const backend = await mockBackend(page, { initialLanguage: 'en' });
    await page.goto('/');
    await signIn(page);
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const path = reserveWireImage(backend);
    const result = await sendWireForm(page, path, formKind);
    expect(result.ok).toBe(false);
    if (formKind !== 'oversized') expect(result.status).toBe(400);
    expect(backend.uploadWire.posts).toBe(1);
    expect(backend.uploadWire.rejected).toBeGreaterThan(0);
    expect(backend.uploadWire.peakBufferedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(backend.files.size).toBe(0);
    expect(backend.uploadWire.payloadBytes).toBe(0);
    await expect.poll(() => ({ closed: backend.uploadWire.closed, listening: backend.uploadWire.listening, connections: backend.uploadWire.connections }))
      .toEqual({ closed: true, listening: false, connections: 0 });
  });
}

test('actual upload wire enforces the receiver byte cap for a direct Node actor', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en', wireDiagnostic: 'first' });
  try {
    await page.goto('/');
    await signIn(page);
    await expect(page.locator('#wardrobe-title')).toBeVisible();
    const path = reserveWireImage(backend);
    const target = new URL(backend.uploadWireUrl);
    const origin = new URL(page.url()).origin;
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash ||
      origin !== `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5181}`) {
      throw new Error('Fixture HTTP target refused.');
    }
    target.pathname = '/storage/v1/object/wardrobe/' + path;
    const limit = 1024 * 1024;
    const boundary = 'fixture-node-cap';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cacheControl"\r\n\r\n0\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name=""; filename="blob"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(limit),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    type ClientOutcome = 'response' | 'reset' | 'unexpected-error' | 'timeout' | 'incomplete';
    const outcome = await new Promise<ClientOutcome>((resolve) => {
      let result: ClientOutcome = 'incomplete';
      const request = httpRequest(target, { method: 'POST', agent: false, headers: {
        origin, authorization: backend.issuedWireAuthorization('a'),
        apikey: 'sb_publishable_browser_fixture_only', 'x-upsert': 'false',
        'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length,
      } });
      const fail = (error: NodeJS.ErrnoException) => {
        if (result !== 'timeout' && result !== 'unexpected-error') {
          result = ['EPIPE', 'ECONNRESET'].includes(error.code ?? '') ? 'reset' : 'unexpected-error';
        }
        request.destroy();
      };
      const timer = setTimeout(() => { result = 'timeout'; request.destroy(); }, 5000);
      let offset = 0;
      const write = () => {
        try {
          while (offset < body.length && !request.destroyed) {
            const end = Math.min(offset + 16 * 1024, body.length);
            const ready = request.write(body.subarray(offset, end));
            offset = end;
            if (!ready) return;
          }
          if (!request.destroyed) request.end();
        } catch { result = 'unexpected-error'; request.destroy(); }
      };
      request.on('error', fail);
      request.on('drain', write);
      request.on('response', (response) => {
        response.on('error', fail);
        response.once('end', () => {
          if (result === 'incomplete') result = 'response';
          request.destroy();
        });
        response.resume();
      });
      request.once('close', () => {
        clearTimeout(timer);
        request.off('drain', write);
        resolve(result);
      });
      write();
    });
    expect(backend.wireDiagnostic).toMatchObject({
      backend: 'first', routePosts: 0, routeRejected: 0, receiverPosts: 1, receiverRejected: 1, success: 0,
      receiverStage: 'receiver-body-limit',
      rejections: { 'receiver-body-limit': 1, 'receiver-timeout': 0, 'receiver-client-error': 0 },
    });
    expect(['response', 'reset']).toContain(outcome);
    expect(backend.uploadWire.posts).toBe(1);
    expect(backend.uploadWire.rejected).toBe(1);
    expect(backend.uploadWire.receivedBytes).toBeGreaterThan(limit);
    expect(backend.uploadWire.peakBufferedBytes).toBeLessThanOrEqual(limit);
    expect(backend.files.size).toBe(0);
    expect(backend.uploadWire.payloadBytes).toBe(0);
    await expect.poll(() => ({ closed: backend.uploadWire.closed, listening: backend.uploadWire.listening, connections: backend.uploadWire.connections }))
      .toEqual({ closed: true, listening: false, connections: 0 });
  } finally {
    await page.close();
    await expect.poll(() => ({ closed: backend.uploadWire.closed, listening: backend.uploadWire.listening, connections: backend.uploadWire.connections }))
      .toEqual({ closed: true, listening: false, connections: 0 });
  }
});

test('actual upload wire restricts reservations and synthetic credentials without forwarding other requests', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  const own = reserveWireImage(backend), foreign = reserveWireImage(backend, owners.b);
  for (const path of [foreign, own.replace('/main.jpg', '/other.jpg'), own + '?unexpected=1',
    `${owners.a}/${randomUUID()}/${randomUUID()}/main.jpg`]) {
    expect(await sendWireForm(page, path, 'valid')).toEqual({ ok: false, status: 403 });
  }
  for (const kind of ['wrong-key', 'wrong-bearer', 'upsert'] satisfies WireForm[]) {
    expect(await sendWireForm(page, own, kind)).toEqual({ ok: false, status: kind === 'wrong-bearer' ? 401 : 403 });
  }
  expect(backend.uploadWire.posts).toBe(0);
  expect(backend.files.size).toBe(0);
  let scriptedFailure = true;
  await page.route('**/storage/v1/object/wardrobe/' + own, async (route) => {
    if (scriptedFailure && route.request().method() === 'POST') {
      scriptedFailure = false;
      await route.fulfill({ status: 503, json: { message: 'Unavailable' } });
    } else await route.fallback();
  });
  expect(await sendWireForm(page, own, 'valid')).toEqual({ ok: false, status: 503 });
  expect(backend.uploadWire.posts).toBe(0);
  expect(await sendWireForm(page, own, 'valid')).toEqual({ ok: true, status: 200 });
  assertWireBytes(backend.files.get(own)!, Buffer.from([0, 128, 255, 13, 10]));
  expect(await sendWireForm(page, own, 'valid')).toEqual({ ok: false, status: 409 });
  expect(backend.uploadWire.posts).toBe(1);
});

for (const diagnostic of [false, true]) {
  test(`actual upload wire isolates parallel pages and closes accepted keepalive connections (diagnostics ${diagnostic ? 'ON' : 'OFF'})`, async ({ page, browser }, testInfo) => {
    const second = await browser.newPage();
    let firstBackend: Awaited<ReturnType<typeof mockBackend>> | undefined;
    let secondBackend: Awaited<ReturnType<typeof mockBackend>> | undefined;
    const observed: { unreserved: WireResult | null; first: WireResult | null; second: WireResult | null; afterFirstClose: WireResult | null } =
      { unreserved: null, first: null, second: null, afterFirstClose: null };
    try {
      firstBackend = await mockBackend(page, { initialLanguage: 'en', ...(diagnostic ? { wireDiagnostic: 'first' as const } : {}) });
      secondBackend = await mockBackend(second, { initialLanguage: 'en', ...(diagnostic ? { wireDiagnostic: 'second' as const } : {}) });
      for (const tab of [page, second]) {
        await tab.goto('/');
        await signIn(tab);
        await expect(tab.locator('#wardrobe-title')).toBeVisible();
      }
      const path = reserveWireImage(firstBackend);
      observed.unreserved = await sendWireForm(second, path, 'valid', undefined, diagnostic ? true : undefined);
      expect(observed.unreserved).toEqual({ ok: false, status: 403,
        ...(diagnostic ? { diagnostic: { backend: 'second', stage: 'route-reservation-credentials', parse: 'ok' } } : {}) });
      secondBackend.items.push({ ...firstBackend.items[0] });
      secondBackend.images.push({ ...firstBackend.images[0] });
      [observed.first, observed.second] = await Promise.all([
        sendWireForm(page, path, 'valid', [0, 255], diagnostic ? true : undefined),
        sendWireForm(second, path, 'valid', [128, 1], diagnostic ? true : undefined),
      ]);
      expect([observed.first, observed.second]).toEqual([
        { ok: true, status: 200, ...(diagnostic ? { diagnostic: { backend: 'first', stage: 'none', parse: 'ok' } } : {}) },
        { ok: true, status: 200, ...(diagnostic ? { diagnostic: { backend: 'second', stage: 'none', parse: 'ok' } } : {}) },
      ]);
      assertWireBytes(firstBackend.files.get(path)!, Buffer.from([0, 255]));
      assertWireBytes(secondBackend.files.get(path)!, Buffer.from([128, 1]));
      if (diagnostic) {
        expect(firstBackend.wireDiagnostic).toMatchObject({ backend: 'first', routePosts: 1, receiverPosts: 1, success: 1,
          routeRejected: 0, receiverRejected: 0, routeStage: 'none', receiverStage: 'none' });
        expect(secondBackend.wireDiagnostic).toMatchObject({ backend: 'second', routePosts: 2, receiverPosts: 1, success: 1,
          routeRejected: 1, receiverRejected: 0, routeStage: 'none', receiverStage: 'none',
          rejections: { 'route-reservation-credentials': 1 } });
      }
      expect(firstBackend.uploadWire.connections).toBeGreaterThan(0);
      expect(secondBackend.uploadWire.connections).toBeGreaterThan(0);
      await page.close();
      await expect.poll(() => ({ closed: firstBackend!.uploadWire.closed, listening: firstBackend!.uploadWire.listening, connections: firstBackend!.uploadWire.connections }))
        .toEqual({ closed: true, listening: false, connections: 0 });
      expect(secondBackend.uploadWire.listening).toBe(true);
      const next = reserveWireImage(secondBackend);
      observed.afterFirstClose = await sendWireForm(second, next, 'valid', undefined, diagnostic ? true : undefined);
      expect(observed.afterFirstClose).toEqual({ ok: true, status: 200,
        ...(diagnostic ? { diagnostic: { backend: 'second', stage: 'none', parse: 'ok' } } : {}) });
      if (diagnostic) {
        expect(secondBackend.wireDiagnostic).toMatchObject({ routePosts: 3, receiverPosts: 2, success: 2, routeRejected: 1, receiverRejected: 0 });
      }
      await second.close();
      await expect.poll(() => ({ closed: secondBackend!.uploadWire.closed, listening: secondBackend!.uploadWire.listening, connections: secondBackend!.uploadWire.connections }))
        .toEqual({ closed: true, listening: false, connections: 0 });
    } finally {
      for (const expectedBackend of ['first', 'second'] as const) {
        const evidence: {
          mode: 'ON' | 'OFF'; repeat: number; expectedBackend: WireBackend; client: Record<string, WireResult | null>;
          server: object | null; captureError: boolean;
        } = { mode: diagnostic ? 'ON' : 'OFF', repeat: testInfo.repeatEachIndex, expectedBackend, client: {}, server: null, captureError: false };
        try {
          const backend = expectedBackend === 'first' ? firstBackend : secondBackend;
          evidence.client = expectedBackend === 'first' ? { parallel: observed.first } :
            { unreserved: observed.unreserved, parallel: observed.second, afterFirstClose: observed.afterFirstClose };
          if (backend?.wireDiagnostic) evidence.server = {
            ...backend.wireDiagnostic, rejections: { ...backend.wireDiagnostic.rejections },
            receiverFacts: backend.wireDiagnostic.receiverFacts ? { ...backend.wireDiagnostic.receiverFacts } : null,
            counterScope: 'cumulative', receiverFactsScope: 'last-completed-or-rejected-receiver-request',
            receivedBytes: backend.uploadWire.receivedBytes, payloadBytes: backend.uploadWire.payloadBytes,
          };
        } catch { evidence.captureError = true; }
        try { testInfo.annotations.push({ type: 'synthetic-wire-localization', description: JSON.stringify(evidence) }); }
        catch { evidence.captureError = true; }
        try { console.log('synthetic-wire-localization', JSON.stringify(evidence)); }
        catch { /* Evidence must not replace the test outcome or prevent cleanup. */ }
      }
      await second.close();
    }
  });
}

test('actual upload wire leaves no listener when fixture setup loses its page', async ({ page, context }) => {
  const listeners = () => process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length;
  const before = listeners();
  await page.close();
  await expect(mockBackend(page)).rejects.toThrow('Fixture receiver unavailable.');
  const second = await context.newPage();
  const setup = mockBackend(second);
  const outcome = setup.then(() => 'ready', () => 'closed');
  await second.close();
  await outcome;
  await expect.poll(listeners).toBe(before);
});

for (const language of ['en', 'fi', 'sv'] satisfies Language[]) {
  test(`photo, editable draft and explicit save in ${language}`, async ({ page }) => {
    const backend = await mockBackend(page);
    await page.goto('/');
    await page.getByRole('button', { name: messages[`language.${language}`][language], exact: true }).click();
    await signIn(page);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await expect(page.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'][language]);
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
    await expect(page.locator('.capture-photo img')).toBeVisible();
    await manualEntry(page);
    expect(backend.items).toHaveLength(0);
    expect(backend.files.size).toBe(0);
    await page.locator('#item-title').fill('My edited olive shirt');
    await page.locator('#item-category').selectOption('top');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('An olive shirt, front view');
    await page.getByRole('button', { name: messages['capture.save'][language] }).click();
    await expect(page.locator('.item-caption h2')).toHaveText('My edited olive shirt');
    await expect(page.locator('.item-photo img')).toHaveAttribute('alt', 'An olive shirt, front view');
    expect(backend.items).toHaveLength(1);
    expect(backend.images[0]?.state).toBe('ready');
    expect(backend.files.size).toBe(2);
    expect(backend.profiles[owners.a]?.ui_language).toBe(language);
    expect(backend.profiles[owners.b]?.ui_language).toBe('sv');
    for (const bytes of backend.files.values()) {
      expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
      expect(bytes.length).toBeLessThanOrEqual(512000);
    }
  });
}

for (const language of ['en', 'fi', 'sv'] satisfies Language[]) {
  test(`accessibility of private preparation details, cancel and same-file reselection in ${language}`, async ({ page }) => {
    const backend = await mockBackend(page, { initialLanguage: language });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await signIn(page);
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await page.locator('#item-title').fill('Manual synthetic title');
    await page.locator('#item-category').selectOption('top');
    await page.locator('details.optional-details summary').click();
    await page.locator('#item-alt').fill('Manual synthetic description');
    await page.locator('#item-alt').fill('');
    const input = page.locator('input[type="file"]').first();
    const show = page.getByRole('button', { name: messages['photo.showDetails'][language] });
    await expect(show).toHaveCount(0);
    const before = backend.requests.length;
    const invalid = { name: 'PRIVATE_FILENAME_FIXTURE.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) };
    await input.setInputFiles(invalid);
    await expect(page.getByRole('alert')).toHaveText(messages['photo.invalid'][language]);
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#preparation-details')).toBeHidden();
    await show.focus();
    await page.keyboard.press('Enter');
    const details = page.getByRole('region', { name: messages['photo.details'][language] });
    await expect(details).toBeVisible();
    await expect(details).toHaveText(messages['photo.stageSource'][language] + messages['photo.reasonInvalid'][language]);
    await expect(details).not.toHaveAttribute('aria-live');
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('button', { name: messages['photo.hideDetails'][language] })).toBeFocused();
    await expect(page.locator('body')).not.toContainText('PRIVATE_FILENAME_FIXTURE');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await input.setInputFiles([]);
    await expect(details).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(messages['photo.invalid'][language]);
    await input.setInputFiles(invalid);
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toBeHidden();
    // A mislabeled synthetic JPEG proves byte admission, not native HEIC picker conversion.
    await input.setInputFiles({ name: 'synthetic.heic', mimeType: 'application/octet-stream', buffer: backend.fixture });
    await expect(page.locator('.capture-photo img')).toBeVisible();
    await expect(show).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const preview = await page.locator('.capture-photo img').getAttribute('src');
    await input.setInputFiles([]);
    await expect(page.locator('.capture-photo img')).toHaveAttribute('src', preview!);
    await expect(page.locator('#item-title')).toHaveValue('Manual synthetic title');
    await expect(page.locator('#item-category')).toHaveValue('top');
    await expect(page.locator('#item-alt')).toHaveValue('');
    expect(backend.requests.slice(before).every((request) => request.path === '/rest/v1/rpc/ai_status')).toBe(true);
    expect(backend.items).toHaveLength(0);
    expect(backend.files.size).toBe(0);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    await page.getByRole('button', { name: messages['common.cancel'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['common.discard'][language], exact: true }).click();
    await page.getByRole('button', { name: messages['wardrobe.firstItem'][language] }).click();
    await expect(show).toHaveCount(0);
    await expect(page.locator('#item-title')).toHaveValue('');
    await expect(page.locator('.capture-photo img')).toHaveCount(0);
  });
}

type PhotoReadProbe = Window & { photoReadStarted?: boolean; releasePhotoRead?: () => void };
async function holdNextPhotoRead(page: Page) {
  await page.evaluate(() => {
    const probe = window as PhotoReadProbe;
    probe.photoReadStarted = false;
    const native = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      Blob.prototype.arrayBuffer = native;
      probe.photoReadStarted = true;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        probe.releasePhotoRead = () => {
          delete probe.releasePhotoRead;
          void native.call(this).then(resolve, reject);
        };
      });
    };
  });
}

test('late selection cannot overwrite a replacement or manual edits and clears no-file cancellation correctly', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const before = backend.requests.length;
  await holdNextPhotoRead(page);
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: 'old.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await expect.poll(() => page.evaluate(() => (window as PhotoReadProbe).photoReadStarted)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save to my wardrobe' })).toBeDisabled();
  await page.locator('#item-title').fill('Edited while preparing');
  await page.locator('#item-category').selectOption('bottom');
  const replacement = { name: 'same.jpg', mimeType: 'image/jpeg', buffer: backend.fixture };
  await input.setInputFiles(replacement);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  const preview = await page.locator('.capture-photo img').getAttribute('src');
  await page.evaluate(() => (window as PhotoReadProbe).releasePhotoRead?.());
  await expect(page.locator('.capture-photo img')).toHaveAttribute('src', preview!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#item-title')).toHaveValue('Edited while preparing');
  await expect(page.locator('#item-category')).toHaveValue('bottom');
  await input.setInputFiles(replacement);
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await expect(page.locator('.capture-photo img')).not.toHaveAttribute('src', preview!);
  expect(backend.requests.slice(before)).toEqual([]);
});

test('discard and owner logout clear preparation details and ignore late photo reads', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await page.getByRole('button', { name: 'Show preparation details' }).click();
  await page.locator('#item-title').fill('Unsaved synthetic');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: backend.fixture.subarray(0, -2) });
  await page.getByRole('button', { name: 'Show preparation details' }).click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await signIn(page, 'b');
  await expect(page.locator('#capture-title')).toHaveText(messages['capture.title'].sv);
  await expect(page.locator('#item-title')).toHaveValue('');
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await holdNextPhotoRead(page);
  await input.setInputFiles({ name: 'late.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect.poll(() => page.evaluate(() => (window as PhotoReadProbe).photoReadStarted)).toBe(true);
  await page.getByRole('button', { name: messages['account.menu'].sv }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].sv, exact: true }).click();
  await expect(page.locator('#email')).toBeVisible();
  await page.evaluate(() => (window as PhotoReadProbe).releasePhotoRead?.());
  await expect(page.locator('.capture-photo img')).toHaveCount(0);
  await expect(page.locator('#preparation-details')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(backend.items).toHaveLength(0);
  expect(backend.files.size).toBe(0);
});

test('discarding a prepared draft creates no library records', async ({ page }) => {
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  const before = backend.requests.length;
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'synthetic.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await page.locator('#item-title').fill('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Continue editing' }).click();
  await expect(page.locator('#item-title')).toHaveValue('Unsaved');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect(backend.items).toHaveLength(0);
  expect(backend.files.size).toBe(0);
  expect(backend.requests.slice(before)).toEqual([]);
});

test('retrying a failed commit reuses the same records and image bytes', async ({ page }, testInfo) => {
  const backend = await mockBackend(page, { initialLanguage: 'en', failCommitOnce: true });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'shirt.jpg', mimeType: 'image/jpeg', buffer: backend.fixture });
  await expect(page.locator('.capture-photo img')).toBeVisible();
  await manualEntry(page);
  await page.locator('#item-title').fill('A retryable shirt');
  await page.locator('#item-category').selectOption('top');
  await page.getByRole('button', { name: 'Save to my wardrobe' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const image = { ...backend.images[0] };
  const item = { ...backend.items[0] };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(item.id).toMatch(uuid);
  expect(image.id).toMatch(uuid);
  expect(image.item_id).toBe(item.id);
  expect(backend.uploadWire.posts).toBe(2);
  const files = new Map([...backend.files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  for (const variant of ['main', 'thumb']) {
    const bytes = files.get(`${owners.a}/${item.id}/${image.id}/${variant}.jpg`)!;
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBe(image[`${variant}_bytes`]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(image[`${variant}_sha256`]);
  }
  await expect(page.locator('#item-title')).toHaveAttribute('readonly');
  await expect(page.locator('#item-category')).toBeDisabled();
  await expect(page.locator('input[type="file"]').first()).toBeDisabled();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.item-caption h2')).toHaveText('A retryable shirt');
  expect(backend.items).toHaveLength(1);
  expect(backend.images).toHaveLength(1);
  expect(backend.files.size).toBe(2);
  expect(backend.items[0]).toEqual(item);
  expect(backend.images[0]).toEqual({ ...image, state: 'ready' });
  expect(backend.files).toEqual(files);
  expect(backend.uploadWire.posts).toBe(2);
  for (const variant of ['main', 'thumb']) {
    const path = `${owners.a}/${item.id}/${image.id}/${variant}.jpg`;
    const bytes = backend.files.get(path)!;
    expect(bytes).toEqual(files.get(path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(image[`${variant}_sha256`]);
    expect(bytes.length).toBe(image[`${variant}_bytes`]);
    expect(inspectJpegSegments(bytes).some((segment) => segment.marker === 0xfe ||
      (segment.marker >= 0xe1 && segment.marker <= 0xef))).toBe(false);
  }
  testInfo.annotations.push({ type: 'synthetic-prepared-wire', description: JSON.stringify({
    mainBytes: image.main_bytes, thumbBytes: image.thumb_bytes, mainSha256: image.main_sha256, thumbSha256: image.thumb_sha256,
  }) });
});

test('logout clears private state before another owner signs in', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'fi' });
  await page.goto('/');
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fi');
  await page.getByRole('button', { name: messages['account.menu'].fi }).click();
  await page.getByRole('button', { name: messages['auth.signOut'].fi }).click();
  await expect(page.locator('#email')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByText('Alex', { exact: true })).toHaveCount(0);
  await signIn(page, 'b');
  await expect(page.locator('html')).toHaveAttribute('lang', 'sv');
  await expect(page.locator('.account-button')).toContainText('Robin');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('stillroom')))).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});

test('offline save is disabled without losing draft text', async ({ page, context }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await page.locator('#item-title').fill('Still here');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: 'Save to my wardrobe' })).toBeDisabled();
  await expect(page.locator('#item-title')).toHaveValue('Still here');
});

test('a failed language save stays visible without pretending to persist', async ({ page }) => {
  const backend = await mockBackend(page, { failLanguageSave: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Suomi', exact: true }).click();
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(page.locator('.language-warning')).toContainText(messages['account.languageRetry'].fi);
  expect(backend.profiles[owners.a]?.ui_language).toBeNull();
});

test('sign-out is broadcast across tabs without sending account data', async ({ page, context }) => {
  const second = await context.newPage();
  await mockBackend(page, { initialLanguage: 'en' });
  await mockBackend(second, { initialLanguage: 'en' });
  await page.goto('/');
  await second.goto('/');
  await signIn(page);
  // A session belongs to the tab that signed in; the SDK's cross-tab broadcast must not adopt it.
  await expect(second.locator('#email')).toBeVisible();
  await signIn(second);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  await expect(second.locator('#wardrobe-title')).toBeVisible();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(second.locator('#email')).toBeVisible();
  await expect(second.getByText('Alex', { exact: true })).toHaveCount(0);
  await second.close();
});

type AuthMarkers = Window & { authEvents?: Array<{ event: string; owner: string | null }> };
type ProfileSignal = { sequence: number; present: boolean; aborted: boolean; reason: 'AbortError' | 'TimeoutError' | 'other' };
type ProfileProbe = Window & typeof globalThis & { profileProbe: { armed: boolean; count: number; snapshot: () => ProfileSignal[] } };
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function observeSdkEvents(page: Page) {
  await page.evaluate(async () => {
    const modulePath = '/src/data/client.ts';
    const { makeClient } = await import(modulePath) as typeof import('../../src/data/client');
    const client = makeClient({
      url: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_browser_fixture_only', version: 'browser-fixture',
    });
    const markers = window as AuthMarkers;
    markers.authEvents = [];
    client.auth.onAuthStateChange((event, session) => {
      const owner = session?.user.id ?? null;
      // Run after the controller's queued callback, without retaining a session/token.
      setTimeout(() => markers.authEvents?.push({ event, owner }), 0);
    });
  });
}

for (const firstOwner of ['a', 'b'] as const) {
  test(`different-account tabs retain their owner when ${firstOwner} signs in first, and logout clears both`, async ({ page, context }, testInfo) => {
    const second = await context.newPage();
    const tabs = { a: page, b: second };
    const backends = {
      a: await mockBackend(page, { initialLanguage: 'fi' }),
      b: await mockBackend(second, { initialLanguage: 'fi' }),
    };
    const content = {
      a: { name: 'Alex', language: 'fi', title: 'Fictional moss overshirt', alt: 'Moss overshirt front view' },
      b: { name: 'Robin', language: 'sv', title: 'Fictional ochre trousers', alt: 'Ochre trousers front view' },
    } as const;
    const other = (owner: 'a' | 'b') => owner === 'a' ? 'b' : 'a';
    for (const owner of ['a', 'b'] as const) {
      await tabs[owner].addInitScript(({ ownerId }) => {
        const nativeFetch = globalThis.fetch;
        const signals: Array<AbortSignal | null> = [];
        const probe = {
          armed: false, count: 0,
          snapshot: (): ProfileSignal[] => signals.map((signal, index) => {
            const name = signal?.aborted && signal.reason instanceof DOMException ? signal.reason.name : null;
            return { sequence: index + 1, present: signal !== null, aborted: signal?.aborted ?? false,
              reason: name === 'AbortError' || name === 'TimeoutError' ? name : 'other' };
          }),
        };
        (window as ProfileProbe).profileProbe = probe;
        globalThis.fetch = function (this: typeof globalThis | undefined, ...args: Parameters<typeof fetch>) {
          if (probe.armed) {
            const [input, init] = args;
            const address = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
            const url = typeof address === 'string' ? URL.parse(address, location.origin) : null;
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
            if (method === 'GET' && url?.origin === 'http://127.0.0.1:54321'
              && url.pathname === '/rest/v1/profiles' && url.searchParams.get('owner_id') === `eq.${ownerId}`) {
              probe.count++;
              if (signals.length < 2) signals.push(init?.signal ?? (input instanceof Request ? input.signal : null));
            }
          }
          return Reflect.apply(nativeFetch, this ?? globalThis, args);
        };
      }, { ownerId: owners[owner] });
    }
    for (const backend of Object.values(backends)) {
      for (const owner of ['a', 'b'] as const) {
        const itemId = `20000000-0000-4000-8000-${owner === 'a' ? '000000000001' : '000000000002'}`;
        const imageId = `30000000-0000-4000-8000-${owner === 'a' ? '000000000001' : '000000000002'}`;
        const prefix = `${owners[owner]}/${itemId}/${imageId}`;
        backend.items.push({ id: itemId, owner_id: owners[owner], title: content[owner].title, category: owner === 'a' ? 'top' : 'bottom', created_at: '2026-09-06T00:00:00Z', deleted_at: null });
        backend.images.push({ id: imageId, owner_id: owners[owner], item_id: itemId, state: 'ready', main_path: `${prefix}/main.jpg`, thumb_path: `${prefix}/thumb.jpg`, alt_text: content[owner].alt });
        backend.files.set(`${prefix}/thumb.jpg`, backend.fixture);
      }
    }
    const assertOwn = async (owner: 'a' | 'b') => {
      const tab = tabs[owner], own = content[owner], foreign = content[other(owner)];
      await expect(tab.locator('html')).toHaveAttribute('lang', own.language);
      await expect(tab.locator('.account-button')).toContainText(own.name);
      await expect(tab.locator('.workspace-identity')).toContainText(own.name);
      await expect(tab.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'][own.language]);
      await expect(tab.locator('.item-caption h2')).toHaveText(own.title);
      await expect(tab.locator('.item-photo img')).toHaveAttribute('alt', own.alt);
      await expect(tab.locator('.item-photo img')).toHaveJSProperty('complete', true);
      await expect(tab.locator('.item-photo img')).toHaveJSProperty('naturalWidth', 2);
      await expect(tab.getByText(foreign.name, { exact: true })).toHaveCount(0);
      await expect(tab.getByText(foreign.title, { exact: true })).toHaveCount(0);
      await expect(tab.getByAltText(foreign.alt)).toHaveCount(0);
      const requests = backends[owner].requests.filter((request) => request.method === 'GET' && /^\/(rest|storage)\//.test(request.path));
      expect(requests.some((request) => request.path === '/rest/v1/items')).toBe(true);
      expect(requests.some((request) => request.path.startsWith('/storage/'))).toBe(true);
      expect(requests.every((request) => request.owner === owners[owner])).toBe(true);
      expect(requests.filter((request) => request.path.startsWith('/rest/')).every((request) => request.ownerFilter === `eq.${owners[owner]}`)).toBe(true);
    };
    for (const tab of Object.values(tabs)) {
      await tab.goto('/');
      await expect(tab.locator('#email')).toBeVisible();
      expect(await tab.evaluate(async () => {
        const ordinaryFetch = fetch;
        return (await ordinaryFetch('/')).ok;
      })).toBe(true);
      await observeSdkEvents(tab);
    }
    await signIn(tabs[firstOwner], firstOwner);
    await assertOwn(firstOwner);
    const secondOwner = other(firstOwner);
    await signIn(tabs[secondOwner], secondOwner);
    await expect.poll(() => tabs[firstOwner].evaluate(() => (window as AuthMarkers).authEvents))
      .toContainEqual({ event: 'SIGNED_IN', owner: owners[secondOwner] });
    await assertOwn(firstOwner);
    await assertOwn(secondOwner);
    // Recovery broadcasts a real SDK SIGNED_IN back to the already signed-in second owner.
    await tabs[secondOwner].evaluate(() => { (window as AuthMarkers).authEvents = []; });
    await tabs[firstOwner].reload();
    await expect.poll(() => tabs[secondOwner].evaluate(() => (window as AuthMarkers).authEvents))
      .toContainEqual({ event: 'SIGNED_IN', owner: owners[firstOwner] });
    await assertOwn(firstOwner);
    await assertOwn(secondOwner);
    await tabs[secondOwner].reload();
    for (const owner of ['a', 'b'] as const) {
      const tab = tabs[owner];
      const response = tab.waitForResponse((result) => new URL(result.url()).pathname === '/rest/v1/profiles');
      await tab.bringToFront();
      await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
      const result = await response;
      expect(result.status()).toBe(200);
      await result.finished();
      await assertOwn(owner);
    }

    // Hold actual owner-profile replies across logout; cancellation must prevent restoration.
    type Settlement = 'fulfilled' | 'known-aborted' | 'page-closed' | 'error' | 'unsettled';
    const deadlineMs = 5_000;
    const bounded = async <T,>(promise: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise.then(value => ({ kind: 'done' as const, value }), error => ({ kind: 'error' as const, error: error as unknown })),
          new Promise<{ kind: 'unsettled' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'unsettled' }), deadlineMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const held: Array<{ owner: 'a' | 'b'; release: ReturnType<typeof latch>; finished: ReturnType<typeof latch>;
      count: number; outcome: Settlement; observed?: { count: number; signals: ProfileSignal[] } }> = [];
    const failures = new Map<Request, { owner: 'A' | 'B'; reported: boolean }>();
    const listeners = new Map<Page, (request: Request) => void>();
    for (const owner of ['a', 'b'] as const) {
      const listener = (request: Request) => {
        const record = failures.get(request);
        if (record) record.reported = true;
      };
      listeners.set(tabs[owner], listener);
      tabs[owner].on('requestfailed', listener);
    }
    const settle = async () => {
      for (const pending of held) {
        pending.release.resolve();
        if (pending.count === 0) pending.finished.resolve();
      }
      const result = await bounded(Promise.all(held.map(pending => pending.finished.promise)));
      return result.kind === 'done' && held.every(pending => pending.outcome === 'fulfilled' || pending.outcome === 'known-aborted');
    };
    let cleanupFailed: boolean;
    try {
      for (const owner of ['a', 'b'] as const) {
        const tab = tabs[owner], started = latch();
        const pending: typeof held[number] = { owner, release: latch(), finished: latch(), count: 0, outcome: 'unsettled' };
        held.push(pending);
        await tab.route('**/rest/v1/profiles?**', async (route) => {
          const request = route.request(), url = new URL(request.url());
          if (pending.count !== 0 || request.method() !== 'GET' || url.origin !== 'http://127.0.0.1:54321'
            || url.pathname !== '/rest/v1/profiles' || url.searchParams.get('owner_id') !== `eq.${owners[owner]}`) {
            await route.fallback(); return;
          }
          pending.count++;
          failures.set(request, { owner: owner === 'a' ? 'A' : 'B', reported: false });
          started.resolve();
          try {
            await pending.release.promise;
            const result = await bounded(route.fulfill({ json: backends[owner].profiles[owners[owner]] }));
            pending.outcome = result.kind === 'done' ? 'fulfilled' : result.kind === 'unsettled' ? 'unsettled' :
              result.error instanceof Error && result.error.name === 'AbortError' ? 'known-aborted' :
                tab.isClosed() && result.error instanceof Error && result.error.name === 'TargetClosedError' ? 'page-closed' : 'error';
          } finally { pending.finished.resolve(); }
        });
        await tab.evaluate(() => {
          (window as ProfileProbe).profileProbe.armed = true;
          window.dispatchEvent(new Event('focus'));
        });
        expect((await bounded(started.promise)).kind, 'PROFILE_START_UNSETTLED').toBe('done');
        expect(await tab.evaluate(() => (window as ProfileProbe).profileProbe.snapshot()))
          .toEqual([{ sequence: 1, present: true, aborted: false, reason: 'other' }]);
      }
      const logoutTab = tabs[firstOwner], language = content[firstOwner].language;
      await logoutTab.getByRole('button', { name: messages['account.menu'][language] }).click();
      await logoutTab.getByRole('button', { name: messages['auth.signOut'][language], exact: true }).click();
      for (const tab of Object.values(tabs)) await expect(tab.locator('#email')).toBeVisible();
      for (const pending of held) {
        pending.observed = await tabs[pending.owner].evaluate(() => {
          const probe = (window as ProfileProbe).profileProbe;
          probe.armed = false;
          return { count: probe.count, signals: probe.snapshot() };
        });
        expect(pending.count).toBe(1);
        expect(pending.observed).toEqual({ count: pending.count,
          signals: [{ sequence: 1, present: true, aborted: true, reason: 'AbortError' }] });
      }
      expect(await settle(), 'PROFILE_SETTLEMENT_FAILED').toBe(true);
      for (const tab of Object.values(tabs)) {
        await expect(tab.locator('.workspace')).toHaveCount(0);
        await expect(tab.locator('html')).toHaveAttribute('lang', 'en');
        expect(await tab.evaluate(() => [sessionStorage, localStorage].flatMap((store) => Object.keys(store).filter((key) => key.startsWith('stillroom'))))).toEqual([]);
        expect(await tab.evaluate(() => caches.keys())).toEqual([]);
        expect(await tab.evaluate(() => indexedDB.databases())).toEqual([]);
        await tab.reload();
        await expect(tab.locator('#email')).toBeVisible();
        await expect(tab.locator('.item-photo img')).toHaveCount(0);
        for (const value of Object.values(content)) {
          await expect(tab.getByText(value.name, { exact: true })).toHaveCount(0);
          await expect(tab.getByText(value.title, { exact: true })).toHaveCount(0);
        }
      }
      for (const backend of Object.values(backends)) {
        expect(backend.uploadWire.posts).toBe(0);
        expect(backend.uploadWire.payloadBytes).toBe(0);
      }
    } finally {
      const settled = await settle();
      const disarmed = await bounded(Promise.all(Object.values(tabs).map(tab => tab.evaluate(() => {
        (window as ProfileProbe).profileProbe.armed = false;
      }))));
      for (const [tab, listener] of listeners) tab.off('requestfailed', listener);
      testInfo.annotations.push({ type: 'synthetic-profile-timing', description: JSON.stringify({
        requests: held.map(pending => ({ owner: pending.owner === 'a' ? 'A' : 'B', held: pending.count,
          observed: pending.observed ?? null, outcome: pending.outcome })),
        protocolFailures: [...failures.values()], settled, disarmed: disarmed.kind,
        uploads: Object.values(backends).map(backend => ({ posts: backend.uploadWire.posts, payloadBytes: backend.uploadWire.payloadBytes })),
      }) });
      cleanupFailed = !settled || disarmed.kind !== 'done';
    }
    if (cleanupFailed) throw new Error('PROFILE_CLEANUP_FAILED');
  });
}

test('accessibility while wardrobe items are loading', async ({ page }, testInfo) => {
  const errorNames = { Error: 0, TypeError: 0, ReferenceError: 0, SyntaxError: 0, RangeError: 0, AbortError: 0, TimeoutError: 0, other: 0 };
  const requests = { document: 0, script: 0, stylesheet: 0, image: 0, font: 0, fetch: 0, xhr: 0, other: 0, finished: 0, failed: 0 };
  const onError = (error: Error) => {
    const name = Object.hasOwn(errorNames, error.name) ? error.name as keyof typeof errorNames : 'other';
    errorNames[name]++;
  };
  const onRequest = (request: Request) => {
    const type = request.resourceType();
    const category = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr'].includes(type) ? type as keyof typeof requests : 'other';
    requests[category]++;
  };
  const onFinished = () => { requests.finished++; };
  const onFailed = () => { requests.failed++; };
  page.on('pageerror', onError);
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  let navigationCompleted = false;
  let statusBucket = 'none';
  const backend = await mockBackend(page, { initialLanguage: 'en' });
  const started = latch(), release = latch();
  await page.route('**/rest/v1/items?**', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    started.resolve();
    await release.promise;
    await route.fallback();
  });
  const loading = page.locator('.item-grid[aria-busy="true"]');
  try {
    const response = await page.goto('/');
    navigationCompleted = true;
    const status = response?.status() ?? 0;
    statusBucket = status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'none';
    await signIn(page);
    await started.promise;
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-label', messages['common.loading'].en);
    await expect(loading.locator('.loading-card')).toHaveCount(4);
    const results = await new AxeBuilder({ page }).analyze();
    await expect(loading).toBeVisible();
    expect(results.violations).toEqual([]);
    await expect(page.getByRole('region', { name: messages['common.loading'].en, exact: true })).toHaveAttribute('aria-busy', 'true');
    release.resolve();
    await expect(loading).toHaveCount(0);
    await expect(page.locator('#wardrobe-title')).toHaveText(messages['wardrobe.title'].en);
    await expect(page.getByRole('button', { name: messages['wardrobe.firstItem'].en })).toBeVisible();
    expect(backend.requests).toContainEqual({ method: 'GET', path: '/rest/v1/items', owner: owners.a, ownerFilter: `eq.${owners.a}` });
  } finally {
    release.resolve();
    let boot: object;
    try {
      boot = await page.evaluate(() => {
        const email = document.querySelector('#email'), rect = email?.getBoundingClientRect();
        const style = email ? getComputedStyle(email) : null;
        const lang = document.documentElement.lang;
        return { readyState: document.readyState, emailPresent: email !== null,
          emailVisible: Boolean(rect?.width && rect.height && style?.visibility !== 'hidden' && style?.display !== 'none'),
          login: Boolean(document.querySelector('#login-title')),
          loading: Boolean(document.querySelector('.item-grid[aria-busy="true"]')),
          workspace: Boolean(document.querySelector('.workspace')),
          fatal: Boolean(document.querySelector('.fatal-error')),
          lang: ['en', 'fi', 'sv'].includes(lang) ? lang : 'other' };
      });
    } catch { boot = { state: page.isClosed() ? 'page-closed' : 'unavailable' }; }
    page.off('pageerror', onError);
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    testInfo.annotations.push({ type: 'synthetic-loading-boot', description: JSON.stringify({
      owner: 'A', navigationCompleted, statusBucket, boot, errorNames, requests,
    }) });
  }
});

test('accessibility and 320px layout across login, empty wardrobe and draft', async ({ page }) => {
  await mockBackend(page, { initialLanguage: 'en' });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.locator('#email')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await signIn(page);
  await expect(page.locator('#wardrobe-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Add your first piece' }).click();
  await expect(page.locator('#capture-title')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
