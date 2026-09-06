import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { checkSource, parseCatalog, validateCatalogs } from '../../scripts/check-translations.mjs';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { excludedPath, scanProject, scanText } from '../../scripts/scan-secrets.mjs';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { buildInventory, isReviewedSpdx, releaseEvidence, renderNotices, summarizeAudit } from '../../scripts/check-dependencies.mjs';

const roots: string[] = [];
const catalog = {
  hello: { en: 'Hello {name}', fi: 'Hei {name}', sv: 'Hej {name}' },
  count_one: { en: '{count} item', fi: '{count} vaate', sv: '{count} plagg' },
  count_other: { en: '{count} items', fi: '{count} vaatetta', sv: '{count} plagg' },
};
const script = (name: string) => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url));
async function fixture() {
  const root = path.join(process.cwd(), 'scripts', 'quality', `.test-fixture-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}
async function put(root: string, name: string, text: string) {
  const filename = path.join(root, ...name.split('/'));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, text, 'utf8');
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('translation quality gate', () => {
  it('accepts complete Nordic translations and rejects malformed/empty catalogs', () => {
    expect(validateCatalogs([catalog]).errors).toEqual([]);
    expect(validateCatalogs([null]).errors).toContain('catalog-0: INVALID_CATALOG');
    expect(validateCatalogs([{ hello: { en: 'Hello', fi: '  ', sv: 'Hej' } }]).errors).toContain('hello/fi: MISSING_TRANSLATION');
    expect(validateCatalogs([{ hello: 'Hello' }]).errors).toContain('hello: INVALID_ENTRY');
  });
  it('rejects parameter mismatches, malformed parameters, and plural pairs', () => {
    expect(validateCatalogs([{ ...catalog, hello: { en: '{name}', fi: '{nimi}', sv: '{name}' } }]).errors).toContain('hello: PARAMETER_MISMATCH');
    expect(validateCatalogs([{ hello: { en: '{bad-name}', fi: '{bad-name}', sv: '{bad-name}' } }]).errors).toContain('hello/en: INVALID_PARAMETER');
    expect(validateCatalogs([{ count_one: catalog.count_one }]).errors).toContain('count: MISSING_PLURAL_PAIR');
    expect(validateCatalogs([{ ...catalog, count_other: { en: '{total}', fi: '{total}', sv: '{total}' } }]).errors).toContain('count: PLURAL_PARAMETER_MISMATCH');
    expect(validateCatalogs([{ ...catalog, count_few: catalog.count_one }]).errors).toContain('count_few: UNSUPPORTED_PLURAL');
  });
  it('rejects duplicate overrides and duplicate JSON properties before merging', () => {
    expect(validateCatalogs([catalog, { hello: catalog.hello }]).errors).toContain('hello: DUPLICATE_KEY');
    expect(parseCatalog('{"hello":{"en":"a","en":"b","fi":"c","sv":"d"}}').errors).toContain('catalog.json: DUPLICATE_JSON_PROPERTY');
    expect(parseCatalog('{"hello":{},"hello":{}}').errors).toContain('catalog.json: DUPLICATE_JSON_PROPERTY');
    expect(parseCatalog('{broken}').errors).toContain('catalog.json: INVALID_JSON');
  });
  const sourceErrors = (text: string) => checkSource(ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), catalog);
  it('finds unknown literal keys without confusing ordinary object method arguments', () => {
    expect(sourceErrors("t('missing');\ntranslate(language, 'missing');\nt(flag ? 'hello' : 'bad');"))
      .toHaveLength(3);
    expect(sourceErrors("t('hello', {name: 'A'}); translate(language, 'hello'); client.from('items');")).toEqual([]);
  });
  it('finds raw JSX text, interpolated/conditional strings and accessible labels', () => {
    for (const text of [
      '<button>Sign in</button>', '<input placeholder="Name" />', '<img alt="Coat" />',
      '<button aria-label={"Close"} />', '<div title={visible ? "Open" : "Closed"} />',
      '<button>{busy ? "Working" : "Save"}</button>', '<div>{`Hello ${name}`}</div>',
      '<div>{"Hello " + name}</div>',
      '<input type="submit" value="Submit" />', '<Dialog title="Leave?" />',
      '<span aria-hidden="true">Untranslated prose</span>', '<code>Please sign in</code>',
    ]) expect(sourceErrors(text).some((error: string) => error.includes('RAW_UI_TEXT'))).toBe(true);
  });
  it('allows product names, syntax-only code, decoration, identifiers and personal data', () => {
    expect(sourceErrors(`<><span>Stillroom</span><span>WARDROBE</span><span>Stillroom Wardrobe</span>
      <code>npm run db:start</code><code>.env.local</code><span aria-hidden="true">01</span>
      <input type="email" name="email" autoComplete="username" /><img alt={item.altText} />
      <h1>{item.title}</h1><button>{t('hello')}</button></>`)).toEqual([]);
    expect(sourceErrors('<span>01</span>')).toHaveLength(1);
  });
  it('checks typed dynamic keys rather than rejecting safe templates', () => {
    const filename = 'typed-fixture.tsx';
    const text = `type Key = 'hello' | 'count_one' | 'count_other';
      declare const t: (key: Key) => string;
      declare const plural: 'one' | 'other';
      declare const untyped: string;
      t(\`count_\${plural}\`); t(untyped);
      const raw = 'Untranslated label'; const element = <input title={raw} />;`;
    const options = { noLib: true, strict: true, jsx: ts.JsxEmit.Preserve };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => name === filename ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) : undefined;
    const program = ts.createProgram([filename], options, host);
    expect(checkSource(program.getSourceFile(filename), catalog, program.getTypeChecker()))
      .toEqual([`${filename}:5: UNSAFE_MESSAGE_KEY_TYPE`, `${filename}:6: RAW_UI_TEXT`]);
  });
  it('returns a real nonzero CLI exit for missing translations and parameter mismatches', async () => {
    const root = await fixture();
    await put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, jsx: 'preserve' }, include: ['src'] }));
    await put(root, 'src/example.tsx', 'export const element = <span>Stillroom</span>;');
    await put(root, 'src/i18n/phase-zero.json', '{}');
    for (const invalid of [
      { hello: { en: 'Hello', fi: '', sv: 'Hej' } },
      { hello: { en: '{name}', fi: '{wrong}', sv: '{name}' } },
    ]) {
      await put(root, 'src/i18n/messages.json', JSON.stringify(invalid));
      const result = spawnSync(process.execPath, [script('check-translations')], { cwd: root, encoding: 'utf8', timeout: 20_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/MISSING_TRANSLATION|PARAMETER_MISMATCH/);
    }
  }, 30_000);
});

describe('secret quality gate', () => {
  const generatedSecret = () => ['sb', 'secret', randomUUID().replaceAll('-', '')].join('_');
  const jwt = (role: string) => [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role })).toString('base64url'),
    Buffer.from('generated-fictional-signature').toString('base64url'),
  ].join('.');
  it('detects modern secrets and legacy privileged JWTs without flagging variable names/public keys', () => {
    expect(scanText(generatedSecret(), 'docs/example.md')).toEqual(['SUPABASE_SECRET_KEY']);
    expect(scanText(jwt('service_role'), 'dist/assets/example.js')).toEqual(['PRIVILEGED_JWT']);
    expect(scanText(jwt('anon'), 'src/config.ts')).toEqual([]);
    expect(scanText('SUPABASE_SERVICE_ROLE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY; sb_publishable_browser_fixture_only; sb_secret_', 'docs/operations.md')).toEqual([]);
  });
  it('detects private key and credential material but never returns the material', () => {
    const privateHeader = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
    const database = ['postgresql:', '//operator:', randomUUID(), '@localhost/database'].join('');
    expect(scanText(privateHeader, 'docs/example.txt')).toEqual(['PRIVATE_KEY']);
    expect(scanText(database, 'scripts/example.mjs')).toEqual(['DATABASE_CREDENTIAL']);
  });
  it('enforces the browser variable allowlist across dot/bracket/destructured/process reads', () => {
    const unapproved = ['VITE', 'UNAPPROVED'].join('_');
    for (const text of [
      `import.meta.env.${unapproved}`, `process.env['${unapproved}']`, `const {${unapproved}} = import.meta.env`,
      'process.env.SUPABASE_SERVICE_ROLE_KEY', 'import.meta.env[key]', 'const {...all} = import.meta.env',
    ]) expect(scanText(text, 'src/example.ts')).toContain('UNAPPROVED_BROWSER_VARIABLE');
    expect(scanText("import.meta.env.VITE_SUPABASE_URL; import.meta.env['VITE_APP_VERSION']; import.meta.env.DEV;", 'src/config.ts')).toEqual([]);
    expect(scanText("const publicKeys = ['VITE_SUPABASE_URL','VITE_SUPABASE_PUBLISHABLE_KEY','VITE_APP_VERSION'];", 'vite.config.ts')).toEqual([]);
    expect(scanText("process.env.SUPABASE_SERVICE_ROLE_KEY", 'scripts/provision.mjs')).toEqual([]);
  });
  it('scans untracked sources and dist without git, excludes private state, and redacts canaries', async () => {
    const root = await fixture();
    const canary = randomUUID();
    const entries = ['src/leak.ts', 'dist/assets/leak.js', 'blueprint/leak.md', 'docs/leak.txt'];
    for (const name of entries) await put(root, name, canary);
    for (const name of ['.env.local', '.git/leak', 'node_modules/leak.js', '.supabase/leak.json', 'test-results/leak.txt', 'artifacts/leak.js', 'tests/fixtures/photo.jpg']) {
      await put(root, name, canary);
    }
    await put(root, '.env.example', 'VITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\n');
    const result = await scanProject(root, canary);
    expect(result.findings.map((finding: { path: string }) => finding.path).sort()).toEqual(entries.sort());
    expect(JSON.stringify(result)).not.toContain(canary);
    const cli = spawnSync(process.execPath, [script('scan-secrets')], {
      cwd: root, env: { ...process.env, STILLROOM_SECRET_CANARY: canary }, encoding: 'utf8', timeout: 15_000,
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('SECRET_CANARY');
    expect(cli.stderr).not.toContain(canary);
    expect(cli.stderr).not.toContain(root);
    expect(excludedPath('.env.example')).toBe(false);
  });
});

describe('dependency quality gate', () => {
  async function dependencyFixture() {
    const root = await fixture();
    const dependencies = { react: '1.0.0', 'react-dom': '1.0.0', '@supabase/supabase-js': '1.0.0' };
    const packages: Record<string, unknown> = { '': { dependencies } };
    const production = [];
    for (const [name, version] of Object.entries({ ...dependencies, 'fictional-transitive': '1.0.0' })) {
      const location = `node_modules/${name}`;
      const transitive = name === 'react-dom' ? { 'fictional-transitive': '1.0.0' } : {};
      packages[location] = { version, license: 'MIT', dependencies: transitive };
      await put(root, `${location}/package.json`, JSON.stringify({
        name, version, license: 'MIT', repository: 'https://example.test/fictional-upstream', dependencies: transitive,
      }));
      await put(root, `${location}/LICENSE`, 'Fictional licence text used only by a generated unit-test fixture.');
      production.push({
        name, version, location,
        maintenance: {
          status: 'verified', source: `https://registry.npmjs.org/${encodeURIComponent(name)}`,
          checkedOn: '2026-09-06', releasedAt: '2026-01-01T00:00:00.000Z', reason: 'Fictional unit-test evidence.',
        },
      });
    }
    const manifest = { dependencies };
    const lock = { lockfileVersion: 3, packages };
    await put(root, 'package.json', JSON.stringify(manifest));
    await put(root, 'package-lock.json', JSON.stringify(lock));
    return { root, previous: { production }, manifest, lock };
  }
  const audit = (critical = 0) => ({
    vulnerabilities: critical ? { example: { severity: 'critical' } } : {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical, total: critical } },
  });
  it('rejects missing/unreviewed licences instead of inventing SPDX identifiers', () => {
    expect(isReviewedSpdx('MIT')).toBe(true);
    expect(isReviewedSpdx('0BSD')).toBe(true);
    expect(isReviewedSpdx(undefined)).toBe(false);
    expect(isReviewedSpdx('Unknown-License')).toBe(false);
    expect(isReviewedSpdx('SEE LICENSE IN README')).toBe(false);
  });
  it('fails closed for critical advisories, unavailable audits, malformed results and inconsistent severity', () => {
    expect(summarizeAudit(audit()).ok).toBe(true);
    expect(summarizeAudit({ ...audit(), metadata: { vulnerabilities: { ...audit().metadata.vulnerabilities, high: 1, total: 1 } } }))
      .toMatchObject({ ok: true, high: 1 });
    expect(summarizeAudit(audit(1), 1)).toMatchObject({ ok: false, code: 'CRITICAL_ADVISORY' });
    expect(summarizeAudit({ ...audit(), error: { summary: 'private upstream error' } }, 1)).toEqual({ ok: false, code: 'AUDIT_UNAVAILABLE' });
    expect(summarizeAudit(audit(), -1).ok).toBe(false);
    expect(summarizeAudit(audit(), 1).ok).toBe(false);
    expect(summarizeAudit({}).ok).toBe(false);
    expect(summarizeAudit({ ...audit(), vulnerabilities: { example: { severity: 'critical' } } }).ok).toBe(false);
    expect(summarizeAudit({ ...audit(), metadata: { vulnerabilities: { critical: '0' } } }).ok).toBe(false);
  });
  it('records exact-version release evidence and honestly labels unavailable public metadata', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      time: { '1.0.0': '2026-01-01T00:00:00.000Z' }, versions: { '1.0.0': { version: '1.0.0' } },
    }));
    expect(await releaseEvidence('example', '1.0.0', fetcher)).toMatchObject({ status: 'verified', releasedAt: '2026-01-01T00:00:00.000Z' });
    expect(await releaseEvidence('example', '2.0.0', fetcher)).toMatchObject({ status: 'unverified', releasedAt: null });
    expect(await releaseEvidence('example', '1.0.0', async () => { throw new Error('offline'); })).toMatchObject({ status: 'unverified', releasedAt: null });
  });
  it('reproduces the entire recorded local graph/notices without registry requests', async () => {
    const root = process.cwd();
    const previous = JSON.parse(await readFile(path.join(root, 'docs', 'dependencies.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    const result = await buildInventory(root, previous, false);
    expect(result.inventory).toEqual(previous);
    expect(result.inventory.production.length + result.inventory.development.length).toBe(Object.keys(lock.packages).length - 1);
    expect(result.notices).toBe((await readFile(path.join(root, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).replaceAll('\r\n', '\n'));
    for (const entry of result.inventory.production) {
      expect(entry.introducingParents.length).toBeGreaterThan(0);
      expect(entry.licenceFiles.length).toBeGreaterThan(0);
      expect(entry.upstream).toMatch(/^https:/);
    }
    expect(result.inventory.production.find((entry: { name: string }) => entry.name === 'tslib').licenceFiles)
      .toEqual(expect.arrayContaining([expect.objectContaining({ file: 'CopyrightNotice.txt' })]));
  });
  it('keeps complete supplied licence/attribution texts in rendered notices', () => {
    const text = 'Copyright Example\nPermission and all conditions.\nComplete warranty disclaimer.';
    expect(renderNotices([{ name: 'example', version: '1.0.0', license: 'MIT', upstream: 'https://example.test', location: 'node_modules/example', texts: [{ file: 'LICENSE', text }] }])).toContain(text);
  });
  it('finds every transitive production package and its introducing parent', async () => {
    const { root, previous } = await dependencyFixture();
    const result = await buildInventory(root, previous);
    expect(result.inventory.production).toHaveLength(4);
    expect(result.inventory.production.find((entry: { name: string }) => entry.name === 'fictional-transitive').introducingParents)
      .toEqual(['react-dom@1.0.0 (node_modules/react-dom)']);
  });
  it('rejects unapproved direct packages and stale installed versions', async () => {
    const { root, previous, manifest } = await dependencyFixture();
    await put(root, 'package.json', JSON.stringify({ dependencies: { ...manifest.dependencies, extra: '1.0.0' } }));
    await expect(buildInventory(root, previous)).rejects.toThrow('UNAPPROVED_RUNTIME_DEPENDENCY');
    await put(root, 'package.json', JSON.stringify(manifest));
    await put(root, 'node_modules/react/package.json', JSON.stringify({ name: 'react', version: '2.0.0', license: 'MIT' }));
    await expect(buildInventory(root, previous)).rejects.toThrow('INSTALLED_PACKAGE_VERSION_DRIFT');
  });
  it('fails for missing upstream, SPDX licence, or production licence text', async () => {
    const { root, previous } = await dependencyFixture();
    const filename = 'node_modules/react/package.json';
    const original = JSON.parse(await readFile(path.join(root, ...filename.split('/')), 'utf8'));
    await put(root, filename, JSON.stringify({ ...original, repository: undefined }));
    await expect(buildInventory(root, previous)).rejects.toThrow('MISSING_UPSTREAM');
    await put(root, filename, JSON.stringify({ ...original, license: undefined }));
    await expect(buildInventory(root, previous)).rejects.toThrow('INSTALLED_LICENCE_DRIFT');
    await put(root, filename, JSON.stringify({ ...original, license: 'Invented-SPDX' }));
    await expect(buildInventory(root, previous)).rejects.toThrow('MISSING_OR_UNREVIEWED_SPDX');
    await put(root, filename, JSON.stringify(original));
    await rm(path.join(root, 'node_modules', 'react', 'LICENSE'));
    await expect(buildInventory(root, previous)).rejects.toThrow('MISSING_PRODUCTION_LICENCE_TEXT');
  });
  it('importing CLI modules has no side effects', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      ['check-translations', 'scan-secrets', 'check-dependencies'].map((name) =>
        `await import(${JSON.stringify(pathToFileURL(script(name)).href)});`).join('\n')], { encoding: 'utf8' });
    expect(output).toBe('');
  });
});
