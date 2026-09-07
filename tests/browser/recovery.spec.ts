import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockBackend, owners, recoveryHash, signIn } from './mock-backend';
import { translate, type Language } from '../../src/i18n';

const password = 'fictional recovery password only';
async function confirm(page: Page) {
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#recovery-password')).toBeVisible();
}
async function fillPasswords(page: Page) {
  await page.locator('#recovery-password').fill(password);
  await page.locator('#recovery-confirm-password').fill(password);
}
for (const language of ['en', 'fi', 'sv'] as const) {
  test(`recovery request is generic, bounded and localized: ${language}`, async ({ page }) => {
    const backend = await mockBackend(page);
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    await page.goto('/');
    await page.getByRole('button', { name: translate(language, `language.${language}`), exact: true }).click();
    await page.getByRole('button', { name: t('recovery.forgot') }).click();
    await page.locator('#recovery-email').fill('unapproved@example.test');
    await page.getByRole('button', { name: t('recovery.send'), exact: true }).click();
    await expect(page.getByText(t('recovery.acknowledgement'), { exact: true })).toBeVisible();
    await page.locator('#recovery-email').fill('user-a@example.test');
    await expect(page.getByRole('button', { name: t('recovery.send'), exact: true })).toBeDisabled();
    expect(backend.requests.filter(request => request.path === '/auth/v1/recover')).toHaveLength(1);
    expect(backend.requests.filter(request => request.path === '/auth/v1/token')).toHaveLength(0);
    await page.getByRole('button', { name: t('recovery.return') }).click();
    await expect(page.locator('#login-title')).toBeFocused();
  });
}
test('verified target, explicit confirmation, reset and normal Login without wardrobe or persistence', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash());
  await expect(page.getByText('The service verified this recovery target: user-a@example.test')).toBeVisible();
  expect(await page.evaluate(() => location.hash === '#/recovery' && location.search === '' && history.state === null)).toBe(true);
  await confirm(page);
  await expect(page.locator('#recovery-password')).toHaveAttribute('autocomplete', 'new-password');
  await fillPasswords(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.locator('#login-title')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Password changed.');
  expect(backend.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  expect(backend.requests.filter(request => request.path === '/auth/v1/logout')).toHaveLength(1);
  expect(backend.requests.every(request => ['/auth/v1/user', '/auth/v1/logout', '/rest/v1/profiles'].includes(request.path))).toBe(true);
  expect(await page.evaluate(() => !sessionStorage.getItem('stillroom.auth') && !localStorage.getItem('stillroom.auth'))).toBe(true);
});
for (const logoutStatus of [204, 403]) {
  test(`return notice survives StrictMode only for the initial signed-out episode: ${logoutStatus}`, async ({ page }) => {
    await mockBackend(page, { logoutStatus, initialLanguage: 'fi' });
    await page.goto('/' + recoveryHash());
    await confirm(page); await fillPasswords(page);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.locator('#login-title')).toBeVisible();
    const notice = translate('en', logoutStatus === 204 ? 'recovery.success' : 'recovery.revocationUncertain');
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByText(notice, { exact: true })).toBeVisible();
    for (const account of ['a', 'b'] as const) {
      await signIn(page, account);
      await expect(page.locator('#wardrobe-title')).toBeVisible();
      const language = account === 'a' ? 'fi' : 'sv';
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('.workspace-identity')).toContainText(account === 'a' ? 'Alex' : 'Robin');
      await page.getByRole('button', { name: translate(language, 'account.menu') }).click();
      await page.getByRole('button', { name: translate(language, 'auth.signOut'), exact: true }).click();
      await expect(page.locator('#login-title')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: translate('en', 'recovery.forgot') }).click();
    await page.getByRole('button', { name: translate('en', 'recovery.return') }).click();
    await page.evaluate(() => { location.hash = '#section'; });
    await expect(page.locator('#login-title')).toBeVisible();
    await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
  });
}
test('normal failed sign-in, new request and explicit cross-tab logout clear initial return notices', async ({ page }) => {
  await mockBackend(page);
  for (const activity of ['failed-sign-in', 'request', 'logout'] as const) {
    await page.goto('about:blank');
    await page.goto('/' + recoveryHash());
    await confirm(page); await fillPasswords(page);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    const notice = page.getByText(translate('en', 'recovery.success'), { exact: true });
    await expect(notice).toBeVisible();
    if (activity === 'failed-sign-in') {
      await page.locator('#email').fill('user-a@example.test');
      await page.locator('#password').fill('wrong fictional password');
      await page.locator('button[type="submit"]').click();
      await expect(page.getByRole('alert')).toBeVisible();
    } else if (activity === 'request') {
      await page.getByRole('button', { name: translate('en', 'recovery.forgot') }).click();
      await page.getByRole('button', { name: translate('en', 'recovery.return') }).click();
    } else {
      await page.evaluate(() => {
        const channel = new BroadcastChannel('stillroom.logout');
        channel.postMessage('sign-out'); channel.close();
      });
    }
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => { location.hash = '#section'; });
    await expect(page.locator('#login-title')).toBeVisible();
    await expect(notice).toHaveCount(0);
  }
});
for (const occupied of [false, true]) {
  test(`benign URL bootstrap and later navigation never enter recovery: occupied=${occupied}`, async ({ page }) => {
    const backend = await mockBackend(page, { initialLanguage: 'en' });
    if (occupied) {
      await page.goto('/'); await signIn(page);
      await expect(page.locator('#wardrobe-title')).toBeVisible();
    }
    for (const suffix of ['', '?utm_source=x', '#section', '#/wardrobe', '#/items/new', '#main']) {
      await page.goto('about:blank');
      await page.goto('/' + suffix);
      await expect(page.locator(occupied ? suffix === '#/items/new' ? '#capture-title' : '#wardrobe-title' : '#login-title')).toBeVisible();
      expect(await page.evaluate(() => location.search + location.hash)).toBe(suffix);
      await expect(page.locator('.recovery-card')).toHaveCount(0);
      for (const hash of ['#section', '#/wardrobe', '#/items/new']) {
        await page.evaluate(value => { location.hash = value; }, hash);
        await expect(page.locator(occupied ? hash === '#/items/new' ? '#capture-title' : '#wardrobe-title' : '#login-title')).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
      }
    }
    expect(backend.requests.some(request => request.method === 'PUT' || request.path === '/auth/v1/recover')).toBe(false);
  });
}
test('not-my-account cancellation makes no password update or server logout', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash());
  await page.getByRole('button', { name: 'Not my account — cancel' }).click();
  await expect(page.locator('#login-title')).toBeVisible();
  expect(backend.requests.every(request => request.method === 'GET')).toBe(true);
});
test('leaving the recovery route clears the capability without server writes', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash());
  await confirm(page); await fillPasswords(page);
  await page.evaluate(() => { location.hash = '#/wardrobe'; });
  await expect(page.locator('#login-title')).toBeFocused();
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.every(request => request.method === 'GET')).toBe(true);
});
test('competing recovery callbacks discard both capabilities', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash());
  await confirm(page);
  const before = backend.requests.length;
  await page.evaluate(hash => { location.hash = hash; }, recoveryHash(owners.b));
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests).toHaveLength(before);
});
test('lost own-profile admission on focus removes password entry', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash()); await confirm(page);
  await page.route('**/rest/v1/profiles?**', route => route.fulfill({ json: [] }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});
test('expiry margin cancels before password transmission without refresh', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.clock.install();
  await page.goto('/' + recoveryHash(owners.a, 600)); await confirm(page);
  await page.clock.fastForward(451_000);
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.every(request => request.method === 'GET')).toBe(true);
});
test('keyboard confirmation and password-manager paste remain available', async ({ page, context }) => {
  await mockBackend(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/' + recoveryHash());
  await page.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Continue', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#recovery-password')).toBeFocused();
  await page.evaluate(value => navigator.clipboard.writeText(value), password);
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('#recovery-password')).toHaveValue(password);
  await page.locator('#recovery-confirm-password').fill(password);
  await page.getByRole('button', { name: 'Show password', exact: true }).first().click();
  await expect(page.locator('#recovery-password')).toHaveAttribute('type', 'text');
});
test('confirmed password success removes fields while revocation is pending', async ({ page }) => {
  await mockBackend(page);
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/v1/logout?**', async route => { await wait; await route.fallback(); });
  await page.goto('/' + recoveryHash()); await confirm(page); await fillPasswords(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Checking session revocation');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to sign in' }).click();
  release?.();
  await expect(page.locator('#login-title')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Password changed, but session revocation could not be confirmed.');
});
for (const status of [429, 503]) {
  test(`request reports outage or throttle honestly without exposing server text: ${status}`, async ({ page }) => {
    await mockBackend(page);
    let calls = 0;
    await page.route('**/auth/v1/recover?**', route => {
      calls++;
      return route.fulfill({ status, headers: { 'retry-after': '120' }, json: { message: 'synthetic private server detail' } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: translate('en', 'recovery.forgot') }).click();
    await page.locator('#recovery-email').fill('user-a@example.test');
    await page.getByRole('button', { name: translate('en', 'recovery.send'), exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('synthetic private server detail')).toHaveCount(0);
    await expect(page.getByText(translate('en', 'recovery.acknowledgement'), { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: translate('en', 'recovery.send'), exact: true })).toBeDisabled();
    expect(calls).toBe(1);
  });
}
test('offline request never sends mail automatically after reconnecting', async ({ page, context }) => {
  const backend = await mockBackend(page);
  await page.goto('/');
  await page.getByRole('button', { name: translate('en', 'recovery.forgot') }).click();
  await page.locator('#recovery-email').fill('user-a@example.test');
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: translate('en', 'recovery.send'), exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: translate('en', 'recovery.send'), exact: true })).toBeEnabled();
  expect(backend.requests.filter(request => request.path === '/auth/v1/recover')).toHaveLength(0);
});
test('occupied bootstrap refuses before normal Auth initialization or target lookup', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.addInitScript(() => sessionStorage.setItem('stillroom.auth', 'nonempty-unparseable'));
  await page.goto('/' + recoveryHash());
  await expect(page.getByRole('alert')).toContainText('already holds or has started');
  expect(backend.requests).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem('stillroom.auth') === 'nonempty-unparseable')).toBe(true);
});
test('late callback refuses after normal initialization even with empty storage', async ({ page }) => {
  const backend = await mockBackend(page);
  await page.goto('/');
  await expect(page.locator('#login-title')).toBeVisible();
  for (const hash of [recoveryHash(), '#provider_token', '#/wardrobe?code_verifier', '#error_description', '#sb']) {
    await page.evaluate(value => { location.hash = value; }, hash);
    await expect(page.getByRole('alert')).toContainText('already holds or has started');
    expect(await page.evaluate(() => location.hash === '#/recovery')).toBe(true);
  }
  expect(backend.requests.filter(request => request.path === '/auth/v1/user')).toHaveLength(0);
  expect(await page.evaluate(() => location.hash === '#/recovery')).toBe(true);
});
test('late callback while normal sign-in is in flight never starts recovery', async ({ page }) => {
  const backend = await mockBackend(page);
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/v1/token?**', async route => { await wait; await route.fallback(); });
  await page.goto('/');
  await signIn(page);
  await page.evaluate(hash => { location.hash = hash; }, recoveryHash(owners.b));
  await expect(page.getByRole('alert')).toContainText('already holds or has started');
  release?.();
  expect(backend.requests.filter(request => request.path === '/auth/v1/user')).toHaveLength(0);
});
test('foreign server identity fails before password entry', async ({ page }) => {
  const backend = await mockBackend(page, { recoveryUser: owners.b });
  await page.goto('/' + recoveryHash());
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.filter(request => request.path === '/rest/v1/profiles')).toHaveLength(0);
});
test('malformed, non-recovery, expired, query and reload callbacks scrub and fail closed', async ({ page }) => {
  const backend = await mockBackend(page);
  for (const suffix of [
    '#code=unsupported', '#type=magiclink&access_token=private', '?access_token=private&type=recovery',
    '#%61ccess_token%3Dprivate', recoveryHash(owners.a, 149), recoveryHash() + '&type=recovery',
    '#provider_refresh_token', '?code_verifier', '#sb', '#/wardrobe?code=unsupported',
    '#/items/new?%70rovider_token=private', recoveryHash() + '&%74ype=recovery',
    '?utm_source=x' + recoveryHash(),
  ]) {
    await page.goto('/' + suffix);
    await expect(page.getByRole('alert')).toContainText('could not be verified');
    expect(await page.evaluate(() => location.hash === '#/recovery' && !location.search && history.state === null)).toBe(true);
  }
  expect(backend.requests).toHaveLength(0);
  await page.goto('/' + recoveryHash());
  await expect(page.getByRole('checkbox')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('could not be verified');
});
test('global explicit logout cancels isolated recovery, without recovery server logout', async ({ page, context }) => {
  const backend = await mockBackend(page);
  await page.goto('/' + recoveryHash());
  await confirm(page);
  const sender = await context.newPage();
  await mockBackend(sender);
  await sender.goto('/');
  await sender.evaluate(() => { const channel = new BroadcastChannel('stillroom.logout'); channel.postMessage('sign-out'); channel.close(); });
  await expect(page.getByRole('alert')).toContainText('could not be verified');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.filter(request => request.path === '/auth/v1/logout')).toHaveLength(0);
});
test('cancelled delayed verification cannot restore password fields', async ({ page }) => {
  const backend = await mockBackend(page);
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/v1/user', async route => { await wait; await route.fallback(); });
  await page.goto('/' + recoveryHash());
  await page.getByRole('button', { name: 'Return to sign in' }).click();
  release?.();
  await expect(page.locator('#login-title')).toBeVisible();
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  expect(backend.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
});
test('password rejection and unconfirmed revocation have distinct truthful outcomes', async ({ page }) => {
  await mockBackend(page, { updateStatus: 422 });
  await page.goto('/' + recoveryHash());
  await confirm(page); await fillPasswords(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('additional verification');
  await expect(page.locator('#recovery-password')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
  await mockBackend(page, { logoutStatus: 403 });
  await page.goto('about:blank');
  await page.goto('/' + recoveryHash());
  await confirm(page); await fillPasswords(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.locator('#login-title')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Password changed, but session revocation could not be confirmed.');
});
test('cancelling an in-flight update warns honestly and never retries', async ({ page }) => {
  const backend = await mockBackend(page);
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/auth/v1/user', async route => {
    if (route.request().method() === 'PUT') await wait;
    await route.fallback();
  });
  await page.goto('/' + recoveryHash()); await confirm(page); await fillPasswords(page);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Changing password');
  await page.getByRole('button', { name: 'Return to sign in' }).click();
  release?.();
  await expect(page.locator('#login-title')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('outcome is unconfirmed');
  expect(backend.requests.filter(request => request.method === 'PUT').length).toBeLessThanOrEqual(1);
  expect(backend.requests.filter(request => request.path === '/auth/v1/logout')).toHaveLength(0);
});
for (const language of ['en', 'fi', 'sv'] as Language[]) {
  test(`recovery accessibility, raw-password errors, 320px and 200% text: ${language}`, async ({ page }) => {
    await mockBackend(page);
    await page.goto('/' + recoveryHash());
    await expect(page.getByRole('checkbox')).toBeVisible();
    await page.getByRole('button', { name: translate(language, `language.${language}`), exact: true }).click();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: translate(language, 'recovery.continue'), exact: true }).click();
    await page.locator('#recovery-password').fill('ä'.repeat(37));
    await page.locator('#recovery-confirm-password').fill('ä'.repeat(37));
    await page.getByRole('button', { name: translate(language, 'recovery.update'), exact: true }).click();
    await expect(page.locator('#recovery-error')).toBeFocused();
    await expect(page.locator('#recovery-password')).toHaveAttribute('aria-invalid', 'true');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
