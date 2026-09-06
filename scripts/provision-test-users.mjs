import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, CACHE_PATH, PROJECT_ID, TEST_EMAILS, LocalBackendError, assertLocalApi, assertProjectConfig,
  requireDocker, localStatus, privilegedLocalSql, readCredentialCache, fail, reportError,
} from './backend/local.mjs';

async function writePublicConfig(url, key) {
  const target = path.join(ROOT, '.env.local');
  const contents = `# Disposable local Supabase public configuration; no test passwords or admin keys.\nVITE_SUPABASE_URL=${url}\nVITE_SUPABASE_PUBLISHABLE_KEY=${key}\nVITE_APP_VERSION=0.1.0\n`;
  try {
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Preserve all existing user configuration, including comments and unrelated values.
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) {
    console.log('NOTICE: existing .env.local was preserved; review public local configuration manually.');
    return;
  }
  const current = await readFile(target, 'utf8');
  const value = (name) => current.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  let matches = false;
  try { matches = assertLocalApi(value('VITE_SUPABASE_URL')) === url && value('VITE_SUPABASE_PUBLISHABLE_KEY') === key; } catch { /* Never replace an existing remote or custom configuration. */ }
  if (!matches) console.log('NOTICE: existing .env.local was preserved; set its public URL/key to this local stack before browser testing.');
}

async function main() {
  if (process.argv.length !== 2) fail('REFUSED: fixture provisioning accepts no arguments or remote target.');
  await assertProjectConfig();
  await requireDocker();
  const status = await localStatus();
  const slots = JSON.parse(await privilegedLocalSql(await readFile(path.join(ROOT, 'scripts', 'reserve-accounts.sql'), 'utf8')));
  if (slots.length !== 2 || slots[0].slot !== 1 || slots[1].slot !== 2) fail('REFUSED: local fictional account reservations are invalid.');
  let credentials;
  try { credentials = await readCredentialCache(); }
  catch (error) {
    if (!(error instanceof LocalBackendError)) throw error;
    let absent = false;
    try { await lstat(CACHE_PATH); } catch (fileError) { absent = fileError.code === 'ENOENT'; }
    if (!absent) throw error;
    if (slots.some((slot) => slot.created)) fail('REFUSED: existing local identities have no saved fixture credentials; reset the disposable stack instead of changing passwords.');
    credentials = {
      TEST_A_EMAIL: TEST_EMAILS[0], TEST_A_PASSWORD: randomBytes(32).toString('base64url'),
      TEST_B_EMAIL: TEST_EMAILS[1], TEST_B_PASSWORD: randomBytes(32).toString('base64url'),
    };
    await mkdir(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    const record = {
      version: 1, projectId: PROJECT_ID, url: status.url, publishableKey: status.key,
      users: [
        { email: credentials.TEST_A_EMAIL, password: credentials.TEST_A_PASSWORD },
        { email: credentials.TEST_B_EMAIL, password: credentials.TEST_B_PASSWORD },
      ],
    };
    await writeFile(CACHE_PATH, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (credentials.SUPABASE_PUBLISHABLE_KEY && (credentials.SUPABASE_PUBLISHABLE_KEY !== status.key || credentials.SUPABASE_URL !== status.url)) {
    fail('REFUSED: cached fixture configuration differs from this stack; review the local cache rather than silently overwriting it.');
  }
  try { await chmod(CACHE_PATH, 0o600); await chmod(path.dirname(CACHE_PATH), 0o700); } catch { /* Windows ACLs must also restrict this directory to its owner. */ }
  const { createClient } = await import('@supabase/supabase-js');
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) }) },
  };
  const admin = createClient(status.url, status.serviceKey, options);
  for (const [index, label] of ['A', 'B'].entries()) {
    const email = credentials[`TEST_${label}_EMAIL`], password = credentials[`TEST_${label}_PASSWORD`];
    if (!slots[index].created) {
      const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) fail('FAIL: local Auth fixture creation failed; credentials remain private for an explicit retry.', 1);
    }
    const user = createClient(status.url, status.key, options);
    const { data, error } = await user.auth.signInWithPassword({ email, password });
    if (error || !data.user) fail('FAIL: a provisioned local identity could not sign in; no password was changed.', 1);
    const { data: profile, error: profileError } = await user.from('profiles').select('owner_id').eq('owner_id', data.user.id).single();
    if (profileError || !profile) fail('FAIL: local admission did not create an accessible owner profile.', 1);
    await user.auth.signOut();
  }
  await writePublicConfig(status.url, status.key);
  console.log('PASS: two independent fictional local accounts are provisioned. Credentials are only in ignored .supabase/test-users.json.');
}

main().catch(reportError);
