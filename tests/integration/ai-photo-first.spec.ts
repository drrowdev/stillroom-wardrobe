import { test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { assertLocalApi, validateSessionEnvironment } from '../../scripts/backend/local.mjs';
import type { Database } from '../../src/data/database.types';
import { isRecord, isUuid } from '../../src/domain/wardrobe';
import { parseProfile } from '../../src/data/profile';
import { parseAiStatus } from '../../src/domain/ai-controls';
import { isLanguage, messages } from '../../src/i18n';
import { assertSanitizedJpeg, readJpegHeader } from '../../src/images/jpeg';

function check(value: unknown): asserts value { if (!value) throw new Error('C ordinary-owner gate failed.'); }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type PhotoReceipt = { requestId: string; draftId: string; generation: number; imageSha256: string; byteCount: number; width: number; height: number };
type ProgressStage = 'ENTRY' | 'AUTH' | 'OWNER' | 'INITIALIZE' | 'CONSENT' | 'ANALYSIS' | 'SAVE'
  | 'VERIFY' | 'CLEANUP' | 'CLOSED' | 'RESTORE' | 'DONE' | 'COMPLETE';
function progress(stage: ProgressStage, owner: 0 | 1 | 2) {
  console.log(`I29_C_STAGE ${stage} ${owner}`);
}

test('C: two real owner UI journeys, prepared JPEG binding, explicit Save and exact cleanup', async ({ browser }) => {
  progress('ENTRY', 0);
  const env = process.env;
  validateSessionEnvironment(env);
  const base = assertLocalApi(env.SUPABASE_URL!), key = env.SUPABASE_PUBLISHABLE_KEY!;
  const origin = env.I29_C_ANALYSIS_ORIGIN ?? '';
  check(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(origin) && Number(new URL(origin).port) <= 65535);
  const clients = (['A', 'B'] as const).map(() => createClient<Database>(base, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => {
      const address = input instanceof Request ? input.url : String(input), url = new URL(address);
      check(url.origin === base && !url.username && !url.password && !url.hash && address.startsWith(`${base}/`)
        && new Headers(init?.headers).get('apikey') === key
        && (['/auth/v1/token', '/auth/v1/user'].includes(url.pathname)
          || url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/storage/v1/')));
      return fetch(input, { ...init, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000) });
    } },
  }));
  const receipts: Array<{ ownerId: string; requestId: string; draftId: string; generation: number;
    itemId: string; imageId: string; imageSha256: string; byteCount: number; width: number; height: number }> = [];
  const sessions: Array<{ ownerId: string; token: string }> = [];
  try {
    progress('AUTH', 0);
    for (const [index, label] of (['A', 'B'] as const).entries()) {
      const client = clients[index]!;
      const signed = await client.auth.signInWithPassword({ email: env[`TEST_${label}_EMAIL`]!, password: env[`TEST_${label}_PASSWORD`]! });
      check(!signed.error && signed.data.session);
      const verified = await client.auth.getUser();
      check(!verified.error && verified.data.user && verified.data.user.id === signed.data.session.user.id);
      sessions.push({ ownerId: verified.data.user.id, token: signed.data.session.access_token });
    }
    check(sessions.length === 2 && sessions[0]!.ownerId !== sessions[1]!.ownerId && sessions[0]!.token !== sessions[1]!.token);
    for (const [index, label] of (['A', 'B'] as const).entries()) {
      const ownerIndex = index === 0 ? 1 : 2;
      progress('OWNER', ownerIndex);
      const client = clients[index]!, peer = clients[1 - index]!, ownerId = sessions[index]!.ownerId;
      const prefix = index === 0 ? 'c329a000-' : 'c329b000-';
      const profileReply = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version').eq('owner_id', ownerId).single();
      check(!profileReply.error);
      const originalProfile = parseProfile(profileReply.data, ownerId);
      const initializationWrites = originalProfile.ui_language === null ? 1 : 0;
      const expectedConsentProfile = { ...originalProfile, ui_language: originalProfile.ui_language ?? 'en',
        version: originalProfile.version + initializationWrites + 2 };
      const entryStatus = await client.rpc('ai_status');
      const entry = parseAiStatus(entryStatus.data);
      check(!entryStatus.error && entry?.consent.enabled);
      const itemsBefore = await client.from('items').select('id').eq('owner_id', ownerId).order('id');
      const imagesBefore = await client.from('item_images').select('id').eq('owner_id', ownerId).order('id');
      check(!itemsBefore.error && !imagesBefore.error);
      // en-US makes the existing first-login initialization deterministic; saved languages still win.
      const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
      let consentedAt: string | null = null;
      try {
        await context.addInitScript((namespace) => {
          const native = crypto.randomUUID.bind(crypto);
          crypto.randomUUID = () => {
            const id = native();
            return `${namespace.slice(0, 8)}-${id.slice(9, 13)}-${id.slice(14, 18)}-${id.slice(19, 23)}-${id.slice(24)}`;
          };
        }, prefix);
        const page = await context.newPage();
        let posts = 0;
        const captured: { value: PhotoReceipt | null } = { value: null };
        const mutations: string[] = [];
        page.on('request', (request) => {
          const path = new URL(request.url()).pathname;
          if (request.method() === 'POST' && (/\/storage\/v1\/object\//.test(path) || /reserve_.*item_save|finalize-analyzed-item|finalize_item_save|commit_image/.test(path)))
            mutations.push(path);
        });
        await page.route(`${base}/functions/v1/analyze-clothing`, async (route) => {
          const request = route.request(), body = request.postDataBuffer();
          if (request.method() === 'OPTIONS') { await route.continue(); return; }
          check(request.method() === 'POST' && body && body.length > 0 && body.length <= 512000);
          check(request.headers()['content-type'] === 'image/jpeg');
          const requestId = request.headers()['x-stillroom-request-id']!, draftId = request.headers()['x-stillroom-draft-id']!;
          const generation = Number(request.headers()['x-stillroom-generation']);
          check(isUuid(requestId) && isUuid(draftId) && requestId.startsWith(prefix) && draftId.startsWith(prefix) && generation === 1);
          const dimensions = readJpegHeader(body);
          assertSanitizedJpeg(body, dimensions.width, dimensions.height);
          check(++posts === 1);
          captured.value = { requestId, draftId, generation, imageSha256: sha(body), byteCount: body.length, width: dimensions.width, height: dimensions.height };
          const response = await route.fetch({ url: `${origin}/analyze-clothing`, method: request.method(),
            headers: request.headers(), postData: body, timeout: 25000, maxRedirects: 0, maxRetries: 0 });
          await route.fulfill({ response });
        });
        progress('INITIALIZE', ownerIndex);
        await page.goto('http://127.0.0.1:5173/');
        await page.locator('#email').fill(env[`TEST_${label}_EMAIL`]!);
        await page.locator('#password').fill(env[`TEST_${label}_PASSWORD`]!);
        await page.locator('button[type=submit]').click();
        await page.locator('#wardrobe-title').waitFor();
        const initialized = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version')
          .eq('owner_id', ownerId).single();
        check(!initialized.error);
        const profile = parseProfile(initialized.data, ownerId), language = profile.ui_language;
        check(isLanguage(language));
        check(JSON.stringify(profile) === JSON.stringify({ ...originalProfile,
          ui_language: originalProfile.ui_language ?? 'en', version: originalProfile.version + initializationWrites }));
        progress('CONSENT', ownerIndex);
        await page.getByRole('button', { name: messages['account.menu'][language] }).click();
        await page.getByRole('link', { name: messages['nav.settings'][language], exact: true }).click();
        await page.getByRole('button', { name: messages['aiC.disable'][language], exact: true }).click();
        await page.getByText(messages['aiC.disabled'][language], { exact: true }).waitFor();
        await page.getByRole('checkbox', { name: messages['aiC.agree'][language] }).check();
        await page.getByRole('button', { name: messages['aiC.enable'][language], exact: true }).click();
        await page.getByText(messages['aiC.enabled'][language], { exact: true }).waitFor();
        const afterConsent = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version').eq('owner_id', ownerId).single();
        check(!afterConsent.error);
        check(JSON.stringify(parseProfile(afterConsent.data, ownerId)) === JSON.stringify({ ...profile, version: profile.version + 2 }));
        const consentReply = await client.rpc('ai_status'), consent = parseAiStatus(consentReply.data);
        check(!consentReply.error && consent?.consent.enabled && consent.consent.noticeRevision === 1
          && consent.consent.profileVersion === String(profile.version + 2) && consent.consent.consentedAt !== null);
        consentedAt = consent.consent.consentedAt;
        progress('ANALYSIS', ownerIndex);
        await page.getByRole('button', { name: messages['common.back'][language], exact: true }).click();
        await page.getByRole('button', { name: messages['wardrobe.add'][language], exact: true }).first().click();
        // Bytes are generated inside the browser and never attached or printed.
        const pixels = await page.evaluate(async (ownerIndex) => {
          const canvas = document.createElement('canvas'); canvas.width = 160 + ownerIndex * 16; canvas.height = 120;
          const drawing = canvas.getContext('2d');
          if (!drawing) throw new Error('Synthetic canvas unavailable.');
          drawing.fillStyle = ownerIndex === 0 ? '#286448' : '#485a90'; drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = '#f5e8d0'; drawing.fillRect(20, 20, 45, 75);
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Synthetic encoding failed.')), 'image/png'));
          canvas.width = 1; canvas.height = 1;
          return [...new Uint8Array(await blob.arrayBuffer())];
        }, index);
        await page.locator('input[type=file]').first().setInputFiles({ name: 'fictional.png', mimeType: 'image/png', buffer: Buffer.from(pixels) });
        await page.getByText(messages['aiC.ready'][language], { exact: true }).waitFor();
        const actual = captured.value;
        check(actual && posts === 1 && mutations.slice().length === 0);
        check(JSON.stringify((await client.from('items').select('id').eq('owner_id', ownerId).order('id')).data) === JSON.stringify(itemsBefore.data));
        check(JSON.stringify((await client.from('item_images').select('id').eq('owner_id', ownerId).order('id')).data) === JSON.stringify(imagesBefore.data));
        const localTitle = await page.locator('#item-title').inputValue();
        check(localTitle.length > 0 && await page.locator('#item-category').inputValue() === 'top');
        const analyzedProfile = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version')
          .eq('owner_id', ownerId).single();
        check(!analyzedProfile.error && JSON.stringify(parseProfile(analyzedProfile.data, ownerId)) === JSON.stringify(expectedConsentProfile));
        await page.locator('#item-title').fill(`Fictional C garment ${label}`);
        progress('SAVE', ownerIndex);
        await page.getByRole('button', { name: messages['capture.save'][language], exact: true }).click();
        await page.locator('#wardrobe-title').waitFor();
        check(mutations.length === 4 && mutations.filter((path) => path.endsWith('/reserve_analyzed_item_save')).length === 1
          && mutations.filter((path) => path.endsWith('/finalize-analyzed-item')).length === 1
          && mutations.filter((path) => path.startsWith('/storage/v1/object/')).length === 2);
        progress('VERIFY', ownerIndex);
        const own = await client.from('items').select('*').eq('owner_id', ownerId);
        check(!own.error && own.data);
        const item = own.data.find((row) => row.id.startsWith(prefix));
        check(item && own.data.filter((row) => row.id.startsWith(prefix)).length === 1 && item.title === `Fictional C garment ${label}`);
        check(isRecord(item.field_provenance) && isRecord(item.field_provenance.title) && item.field_provenance.title.kind === 'user'
          && isRecord(item.field_provenance.category) && item.field_provenance.category.kind === 'ai_observed');
        const imageReply = await client.from('item_images').select('*').eq('owner_id', ownerId).eq('item_id', item.id).single();
        check(!imageReply.error && imageReply.data);
        const image = imageReply.data;
        check(image.id.startsWith(prefix) && image.state === 'ready' && image.main_sha256 === actual.imageSha256
          && image.main_bytes === actual.byteCount && image.width === actual.width && image.height === actual.height);
        for (const variant of ['main', 'thumb'] as const) {
          const path = image[`${variant}_path`];
          check(path);
          const ownBytes = await client.storage.from('wardrobe').download(path);
          check(!ownBytes.error && ownBytes.data);
          const bytes = new Uint8Array(await ownBytes.data.arrayBuffer());
          check(sha(bytes) === image[`${variant}_sha256`] && bytes.length === image[`${variant}_bytes`]);
          const denied = await peer.storage.from('wardrobe').download(path); check(denied.error !== null);
        }
        const history = await client.rpc('item_attribution_history', { p_item_id: item.id });
        check(!history.error && Array.isArray(history.data) && history.data.length === 1);
        const foreign = await peer.from('items').select('id').eq('id', item.id);
        const foreignHistory = await peer.rpc('item_attribution_history', { p_item_id: item.id });
        check(!foreign.error && foreign.data.length === 0 && foreignHistory.error?.code === '42501');
        await page.reload();
        await page.locator(`a[href="#/items/${item.id}"]`).click();
        await page.locator('#detail-title').waitFor();
        check(await page.locator('#detail-title').inputValue() === item.title && posts === 1);
        const finalProfile = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version').eq('owner_id', ownerId).single();
        check(!finalProfile.error && JSON.stringify(parseProfile(finalProfile.data, ownerId)) === JSON.stringify({ ...profile, version: profile.version + 2 }));
        receipts.push({ ownerId, ...actual, itemId: item.id, imageId: image.id });
        progress('CLEANUP', ownerIndex);
        check(image.main_path && image.thumb_path);
        check(!(await client.storage.from('wardrobe').remove([image.main_path, image.thumb_path])).error);
        check(!(await client.from('items').delete().eq('owner_id', ownerId).eq('id', item.id)).error);
        check(JSON.stringify((await client.from('items').select('id').eq('owner_id', ownerId).order('id')).data) === JSON.stringify(itemsBefore.data));
        check(JSON.stringify((await client.from('item_images').select('id').eq('owner_id', ownerId).order('id')).data) === JSON.stringify(imagesBefore.data));
      } finally { await context.close(); }
      progress('CLOSED', ownerIndex);
      const freshReply = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version')
        .eq('owner_id', ownerId).single();
      check(!freshReply.error);
      const fresh = parseProfile(freshReply.data, ownerId);
      check(JSON.stringify(fresh) === JSON.stringify(expectedConsentProfile));
      progress('RESTORE', ownerIndex);
      if (originalProfile.ui_language === null) {
        const restored = await client.from('profiles').update({ ui_language: null })
          .eq('owner_id', ownerId).eq('version', fresh.version).eq('ui_language', 'en')
          .select('owner_id,display_name,ui_language,timezone,currency,version').single();
        check(!restored.error && JSON.stringify(parseProfile(restored.data, ownerId))
          === JSON.stringify({ ...originalProfile, version: fresh.version + 1 }));
      }
      const restoredReply = await client.from('profiles').select('owner_id,display_name,ui_language,timezone,currency,version')
        .eq('owner_id', ownerId).single();
      const expectedVersion = originalProfile.version + 2 + initializationWrites * 2;
      check(!restoredReply.error && JSON.stringify(parseProfile(restoredReply.data, ownerId))
        === JSON.stringify({ ...originalProfile, version: expectedVersion }));
      const finalStatusReply = await client.rpc('ai_status'), finalStatus = parseAiStatus(finalStatusReply.data);
      check(!finalStatusReply.error && finalStatus?.consent.enabled && finalStatus.consent.noticeRevision === 1
        && finalStatus.consent.consentedAt === consentedAt && consentedAt !== null
        && finalStatus.consent.profileVersion === String(expectedVersion));
      progress('DONE', ownerIndex);
    }
    check(receipts.length === 2 && receipts[0]!.imageSha256 !== receipts[1]!.imageSha256);
    progress('COMPLETE', 2);
    console.log(`I29_C_RECEIPT ${JSON.stringify(receipts)}`);
  } catch { throw new Error('C journey failed; private output withheld; no failure-path restoration.'); }
  finally { for (const client of clients) await client.auth.stopAutoRefresh(); }
});
