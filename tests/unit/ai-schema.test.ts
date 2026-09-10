import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no runtime TypeScript declaration.
import { walkFiles } from '../../scripts/quality/files.mjs';
import {
  aiFields, aiKind, estimatedAiFields, maximumAiBytes, maximumAiCounter, maximumAiLifetimeMs,
  observedAiFields, parseAiFacts, parseAiResult,
} from '../../src/domain/ai-analysis';
import { provenanceFields } from '../../src/domain/attribute-provenance';
import { colours, styleTagLimit } from '../../src/domain/preferences';
import { collectionLimits, enumFields, integerRanges, seasons, textLimits } from '../../src/domain/garment-fields';
// @ts-expect-error Executable normal-session JavaScript shares the server fixture vectors.
import { AI_FACT_VECTORS, assertAiSessionEnvironment } from '../integration/ai-controls.sessions.mjs';

const facts = (fields: unknown = {}, outcome: unknown = 'ready') => ({ outcome, fields });
function result() {
  return {
    schemaVersion: 1, requestId: '10000000-0000-4000-8000-000000000001',
    draftId: '20000000-0000-4000-8000-000000000001', generation: 1, imageSha256: 'a'.repeat(64),
    modelId: 'fictional:model/v1', promptVersion: 1, createdAtMs: 1000, expiresAtMs: 2000, facts: facts(),
  };
}
const excluded = ['title', 'warmth', 'min_temp', 'max_temp', 'rain_rating', 'windproof', 'tags', 'purchase_price', 'purchase_date', 'notes'];
const invalid = { ok: false, code: 'INVALID_RESULT' };
function sessionEnvironment(): Record<string, string> {
  return {
    ALLOW_SECURITY_TESTS: '1', SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture',
    TEST_A_EMAIL: 'user-a@example.test', TEST_A_PASSWORD: 'a'.repeat(24),
    TEST_B_EMAIL: 'user-b@example.test', TEST_B_PASSWORD: 'b'.repeat(24),
  };
}
describe('closed AI normal-child environment', () => {
  it('accepts a strict Linux environment and defaults to the actual platform', () => {
    const env = { ...sessionEnvironment(), HOME: '/fictional', LANG: 'C', LC_ALL: 'C' };
    expect(assertAiSessionEnvironment(env, 'linux')).toEqual(env);
    expect(assertAiSessionEnvironment(env)).toEqual(env);
  });
  it('accepts the finite Windows OS additions without forwarding them as credentials', () => {
    const os = Object.fromEntries([
      'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
      'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
    ].map((name) => [name, 'fictional']));
    expect(assertAiSessionEnvironment({ ...sessionEnvironment(), ...os }, 'win32')).toEqual({
      ...sessionEnvironment(), SYSTEMROOT: 'fictional', USERPROFILE: 'fictional', WINDIR: 'fictional',
    });
  });
  it.each(['Path', 'PATH', 'path'])('accepts Windows %s without widening other platforms', (name) => {
    const env = { ...sessionEnvironment(), [name]: 'fictional' };
    expect(() => assertAiSessionEnvironment(env, 'win32')).not.toThrow();
    for (const platform of ['linux', 'darwin']) expect(() => assertAiSessionEnvironment(env, platform)).toThrow();
  });
  it.each(['SystemRoot', 'SYSTEMROOT', 'systemroot'])('compares Windows %s case-insensitively', (name) => {
    expect(assertAiSessionEnvironment({ ...sessionEnvironment(), [name]: 'fictional' }, 'win32')).toEqual({
      ...sessionEnvironment(), SYSTEMROOT: 'fictional',
    });
  });
  it('accepts equal Windows aliases, including normal-session names, without changing values', () => {
    const env = {
      ...sessionEnvironment(), Path: 'CaseSensitive', PATH: 'CaseSensitive',
      SystemRoot: 'FictionalRoot', SYSTEMROOT: 'FictionalRoot', allow_security_tests: '1',
    };
    expect(assertAiSessionEnvironment(env, 'win32')).toEqual({ ...sessionEnvironment(), SYSTEMROOT: 'FictionalRoot' });
    const lower = Object.fromEntries(Object.entries(sessionEnvironment()).map(([name, value]) => [name.toLowerCase(), value]));
    expect(assertAiSessionEnvironment(lower, 'win32')).toEqual(sessionEnvironment());
    expect(() => assertAiSessionEnvironment(lower, 'linux')).toThrow();
  });
  it.each(['PATH', 'SYSTEMROOT', 'SUPABASE_URL', 'ALLOW_SECURITY_TESTS', 'TEST_A_PASSWORD'])(
    'rejects conflicting Windows %s aliases without logging their values', (name) => {
      const env = { ...sessionEnvironment(), [name]: 'Fictional', [name.toLowerCase()]: 'fictional' };
      expect(() => assertAiSessionEnvironment(env, 'win32')).toThrow('EVIDENCE_REQUIRED');
    },
  );
  it.each(['linux', 'win32'])('rejects arbitrary extras and secret/deployment names on %s, including empty values', (platform) => {
    for (const name of ['UNEXPECTED', 'NODE_OPTIONS', 'TMP', 'APPDATA', 'CI', 'ALLOW_ENV_BYPASS',
      'SUPABASE_SERVICE_ROLE_KEY', 'supabase_access_token', 'DATABASE_URL', 'DB_PASSWORD',
      'PGPASSWORD', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLOUDFLARE_API_TOKEN', 'AZURE_CLIENT_SECRET',
      'OPENAI_API_KEY', 'VITE_SUPABASE_URL']) {
      for (const value of ['fictional', '']) {
        expect(() => assertAiSessionEnvironment({ ...sessionEnvironment(), [name]: value }, platform)).toThrow();
      }
    }
  });
  it.each(['linux', 'win32'])('retains normal credential, local-target and opt-in checks on %s', (platform) => {
    const valid = sessionEnvironment();
    for (const name of Object.keys(valid)) {
      const missing = { ...valid };
      delete missing[name];
      expect(() => assertAiSessionEnvironment(missing, platform)).toThrow();
      expect(() => assertAiSessionEnvironment({ ...valid, [name]: '' }, platform)).toThrow();
    }
    for (const changes of [
      { ALLOW_SECURITY_TESTS: '0' }, { ALLOW_SECURITY_TESTS: 'true' },
      { SUPABASE_URL: 'https://example.test' }, { SUPABASE_URL: 'http://127.0.0.1:54322' },
      { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fixture' }, { SUPABASE_PUBLISHABLE_KEY: 'invalid' },
      { TEST_A_EMAIL: 'other@example.test' }, { TEST_B_EMAIL: valid.TEST_A_EMAIL },
      { TEST_A_PASSWORD: 'short' }, { TEST_B_PASSWORD: 'short' },
      { TEST_B_PASSWORD: valid.TEST_A_PASSWORD },
    ]) expect(() => assertAiSessionEnvironment({ ...valid, ...changes }, platform)).toThrow();
  });
  it('retains strict Linux casing and checks retained values rather than just names', () => {
    const env = { ...sessionEnvironment(), SystemRoot: 'FictionalRoot', SYSTEMROOT: 'OtherRoot' };
    expect(assertAiSessionEnvironment(env, 'linux')).toEqual(env);
    expect(() => assertAiSessionEnvironment({ ...sessionEnvironment(), systemroot: 'fictional' }, 'linux')).toThrow();
    expect(() => assertAiSessionEnvironment({ ...sessionEnvironment(), HOME: '' }, 'linux')).toThrow();
  });
  it.each(['linux', 'win32'])('does not mutate caller input on acceptance or refusal on %s', (platform) => {
    const env = Object.freeze({ ...sessionEnvironment(), SystemRoot: 'FictionalRoot' });
    const before = { ...env };
    const validated = assertAiSessionEnvironment(env, platform);
    expect(env).toEqual(before);
    expect(validated).not.toBe(env);
    validated.TEST_A_PASSWORD = 'changed';
    expect(env).toEqual(before);
    const rejected = Object.freeze({ ...env, UNEXPECTED: 'fictional' });
    expect(() => assertAiSessionEnvironment(rejected, platform)).toThrow();
    expect(rejected).toEqual({ ...before, UNEXPECTED: 'fictional' });
  });
});
describe('strict provider facts', () => {
  it('partitions all 24 provenance fields into observed, estimated and excluded facts', () => {
    expect(observedAiFields).toHaveLength(10);
    expect(estimatedAiFields).toHaveLength(4);
    expect(new Set([...aiFields, ...excluded]).size).toBe(24);
    expect([...aiFields, ...excluded].sort()).toEqual([...provenanceFields].sort());
    for (const field of observedAiFields) expect(aiKind(field)).toBe('ai_observed');
    for (const field of estimatedAiFields) expect(aiKind(field)).toBe('ai_estimated');
  });
  it.each(['category', 'pattern', 'sleeve_length', 'garment_length'] as const)('accepts every existing %s code, not labels or other types', (field) => {
    for (const code of enumFields[field]) expect(parseAiFacts(facts({ [field]: code })).ok).toBe(true);
    for (const bad of ['', 'TOP', 'not-a-code', 0, false, {}, []]) expect(parseAiFacts(facts({ [field]: bad }))).toEqual(invalid);
    expect(parseAiFacts(facts({ [field]: null })).ok).toBe(true);
  });
  it.each(['subcategory', 'brand', 'size_label', 'material'] as const)('preserves %s text and enforces code-point limits', (field) => {
    const value = '  Mixed Case Å 🌿  ';
    expect(parseAiFacts(facts({ [field]: value }))).toEqual({ ok: true, value: facts({ [field]: value }) });
    expect(parseAiFacts(facts({ [field]: '🌿'.repeat(textLimits[field]) })).ok).toBe(true);
    for (const bad of ['🌿'.repeat(textLimits[field] + 1), '', ' \t\n', 'a\0b', 1, false, {}, []]) {
      expect(parseAiFacts(facts({ [field]: bad }))).toEqual(invalid);
    }
    expect(parseAiFacts(facts({ [field]: null })).ok).toBe(true);
  });
  it.each(['formality', 'upper_coverage', 'lower_coverage'] as const)('keeps numeric zero known and rejects malformed %s', (field) => {
    const [min, max] = integerRanges[field];
    for (let value = min; value <= max; value++) expect(parseAiFacts(facts({ [field]: value }))).toEqual({ ok: true, value: facts({ [field]: value }) });
    expect(parseAiFacts(facts({ [field]: null })).ok).toBe(true);
    for (const bad of [-1, max + 1, 0.5, '0', '', NaN, Infinity, -Infinity, {}, [], false, undefined]) {
      expect(parseAiFacts(facts({ [field]: bad }))).toEqual(invalid);
    }
  });
  it.each([['colours', colours], ['seasons', seasons]] as const)('accepts each %s code, unique bounded collections and empty unknowns', (field, codes) => {
    for (const code of codes) expect(parseAiFacts(facts({ [field]: [code] })).ok).toBe(true);
    expect(parseAiFacts(facts({ [field]: codes.slice(0, collectionLimits[field]) })).ok).toBe(true);
    for (const bad of [null, '', [codes[0], codes[0]], ['unknown'], ['UNKNOWN'], [''], [null], [1], Array(1)]) {
      expect(parseAiFacts(facts({ [field]: bad }))).toEqual(invalid);
    }
    expect(parseAiFacts(facts({ [field]: Array.from({ length: collectionLimits[field] + 1 }, (_, index) => codes[index % codes.length]) }))).toEqual(invalid);
    expect(parseAiFacts(facts({ [field]: [] }),)).toEqual({ ok: true, value: facts({ [field]: [] }) });
  });
  it('allows bounded free-text style tags without normalization, not a fixed vocabulary', () => {
    const tags = Array.from({ length: collectionLimits.style_tags }, (_, index) => `${index}${'🌿'.repeat(styleTagLimit - 1)}`);
    expect(parseAiFacts(facts({ style_tags: tags })).ok).toBe(true);
    expect(parseAiFacts(facts({ style_tags: [' Fictional Style ', 'fictional style'] })).ok).toBe(true);
    for (const bad of [[...tags, 'extra'], ['🌿'.repeat(styleTagLimit + 1)], [''], [' \t'], ['a\0b'], ['same', 'same'], [null], null, 'style']) {
      expect(parseAiFacts(facts({ style_tags: bad }))).toEqual(invalid);
    }
  });
  it('distinguishes absent and explicit unknown fields from malformed present facts', () => {
    expect(parseAiFacts(facts())).toEqual({ ok: true, value: facts() });
    const unknown = Object.fromEntries(aiFields.map((field) => [field, ['colours', 'seasons', 'style_tags'].includes(field) ? [] : null]));
    expect(parseAiFacts(facts(unknown, 'unclear'))).toEqual({ ok: true, value: facts(unknown, 'unclear') });
    for (const field of aiFields) expect(parseAiFacts(facts({ [field]: undefined }))).toEqual(invalid);
    for (const value of [facts({ category: 'top' }, 'unclear'), facts({ formality: 0 }, 'unclear'), facts({ style_tags: ['style'] }, 'unclear'),
      facts({}, 'other'), facts([], 'ready'), {}, null, { ...facts(), extra: null }, { fields: {} }, { outcome: 'ready' }]) {
      expect(parseAiFacts(value)).toEqual(invalid);
    }
  });
  it.each([...excluded, 'description', 'currency', 'favourite', 'availability', 'lifecycle', 'exclude_suggestions', 'wear_more',
    'id', 'ownerId', 'owner_id', 'history', 'confidence', 'modelId', 'promptVersion', 'requestId', 'draftId', 'generation',
    'imageSha256', 'field_provenance', 'provider', 'items', '__proto__'])('rejects forbidden %s even when null', (field) => {
    expect(parseAiFacts(facts({ [field]: null }))).toEqual(invalid);
  });
  it('copies and freezes nested collections, rejects executable/non-JSON keys without invoking them', () => {
    const input = facts({ colours: ['black'], style_tags: ['untouched'] });
    const parsed = parseAiFacts(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    (input.fields as { colours: string[] }).colours[0] = 'blue';
    expect(parsed.value.fields.colours).toEqual(['black']);
    expect(() => (parsed.value.fields.colours as string[]).push('white')).toThrow();
    expect(Object.isFrozen(parsed.value.fields)).toBe(true);
    const trap = () => { throw new Error('must not execute'); };
    expect(parseAiFacts(facts({ brand: { toString: trap } }))).toEqual(invalid);
    expect(parseAiFacts(facts({}, { toString: trap }))).toEqual(invalid);
    expect(parseAiFacts(Object.defineProperty({}, 'outcome', { get: trap, enumerable: true }))).toEqual(invalid);
    expect(parseAiFacts({ ...facts(), [Symbol('extra')]: null })).toEqual(invalid);
    expect(parseAiFacts(facts(Object.create({ brand: 'inherited' })))).toEqual(invalid);
    expect(parseAiFacts(facts({ style_tags: Object.assign(['style'], { extra: null }) }))).toEqual(invalid);
  });
});

describe('future authenticated result envelope', () => {
  it('requires exact versioned metadata separate from provider facts and copies all data', () => {
    const input = result();
    const parsed = parseAiResult(input);
    expect(parsed).toEqual({ ok: true, value: input });
    if (!parsed.ok) return;
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(parsed.value).not.toBe(input);
    for (const key of Object.keys(input)) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[key];
      expect(parseAiResult(missing)).toEqual(invalid);
    }
    for (const extra of ['ownerId', 'rawResponse', 'bytes', 'provider', 'url']) expect(parseAiResult({ ...input, [extra]: null })).toEqual(invalid);
    expect(parseAiFacts({ ...input.facts, requestId: input.requestId })).toEqual(invalid);
    for (const version of [0, 2, '1', null, undefined]) expect(parseAiResult({ ...input, schemaVersion: version })).toEqual(invalid);
  });
  it.each(['requestId', 'draftId'])('uses existing UUID rules for %s', (key) => {
    for (const bad of ['', 'not-uuid', '00000000-0000-0000-0000-000000000000', 1, null]) expect(parseAiResult({ ...result(), [key]: bad })).toEqual(invalid);
    expect(parseAiResult({ ...result(), [key]: 'ABCDEF01-1234-4567-89AB-ABCDEF012345' }).ok).toBe(true);
  });
  it.each(['generation', 'promptVersion'])('bounds %s to positive int32', (key) => {
    for (const valid of [1, maximumAiCounter]) expect(parseAiResult({ ...result(), [key]: valid }).ok).toBe(true);
    for (const bad of [0, -1, 1.5, maximumAiCounter + 1, NaN, Infinity, '1', null]) expect(parseAiResult({ ...result(), [key]: bad })).toEqual(invalid);
  });
  it('requires lower-case SHA-256 and a bounded opaque ASCII model identifier', () => {
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 0]) expect(parseAiResult({ ...result(), imageSha256: bad })).toEqual(invalid);
    for (const valid of ['a', 'A0._:/-', 'x'.repeat(128)]) expect(parseAiResult({ ...result(), modelId: valid }).ok).toBe(true);
    for (const bad of ['', 'x'.repeat(129), ' model', 'å', 'a\0b', 'a?b', 'a\n', null]) expect(parseAiResult({ ...result(), modelId: bad })).toEqual(invalid);
  });
  it('requires safe nonnegative millisecond timestamps with a strict positive lifetime at most 24 hours', () => {
    expect(parseAiResult({ ...result(), createdAtMs: 0, expiresAtMs: maximumAiLifetimeMs }).ok).toBe(true);
    expect(parseAiResult({ ...result(), createdAtMs: Number.MAX_SAFE_INTEGER - 1, expiresAtMs: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    for (const key of ['createdAtMs', 'expiresAtMs']) for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null]) {
      expect(parseAiResult({ ...result(), [key]: bad })).toEqual(invalid);
    }
    for (const expiresAtMs of [999, 1000, 1001 + maximumAiLifetimeMs]) expect(parseAiResult({ ...result(), expiresAtMs })).toEqual(invalid);
  });
  it('bounds facts and the entire encoded envelope, including multibyte text, without raw responses', () => {
    const huge = '🌿'.repeat(maximumAiBytes / 4);
    const oversized = { ...result(), facts: facts({ material: huge }) };
    expect(new TextEncoder().encode(JSON.stringify(oversized)).length).toBeGreaterThan(maximumAiBytes);
    expect(parseAiResult(oversized)).toEqual(invalid);
    expect(parseAiFacts(oversized.facts)).toEqual(invalid);
    const bounded = { ...result(), facts: facts({ material: '🌿'.repeat(textLimits.material) }) };
    expect(parseAiResult(bounded).ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(maximumAiBytes);
  });
});

const root = fileURLToPath(new URL('../../', import.meta.url));
describe('I29e SQL/shared contract parity', () => {
  const migration = path.join(root, 'supabase/migrations/20260909180000_ai_request_controls.sql');
  it('uses the same semantic vectors in TypeScript and actual CI server fixtures', () => {
    expect(AI_FACT_VECTORS.length).toBeGreaterThan(30);
    for (const [input, expected] of AI_FACT_VECTORS as [unknown, boolean][]) {
      expect(parseAiFacts(input).ok).toBe(expected);
    }
  });
  it('pins the SQL field partition, vocabularies and all scalar/collection bounds to shared definitions', async () => {
    const sql = await readFile(migration, 'utf8');
    const list = (values: readonly string[]) => `array[${values.map((v) => `'${v}'`).join(',')}]`;
    expect(sql).toContain(`observed constant text[] := ${list(observedAiFields)}`);
    expect(sql).toContain(`estimated constant text[] := ${list(estimatedAiFields)}`);
    for (const [field, codes] of Object.entries({
      category: enumFields.category, pattern: enumFields.pattern, sleeve_length: enumFields.sleeve_length,
      colours, seasons,
    })) expect(sql).toContain(`when '${field}' then ${list(codes)}`);
    expect(sql).toContain(`else ${list(enumFields.garment_length)} end`);
    expect(sql).toContain(`when 'colours' then ${collectionLimits.colours} when 'seasons' then ${collectionLimits.seasons} else ${collectionLimits.style_tags}`);
    expect(sql).toContain(`char_length(e#>>'{}')>${styleTagLimit}`);
    expect(sql).toContain(`when 'subcategory' then ${textLimits.subcategory} when 'brand' then ${textLimits.brand} when 'size_label' then ${textLimits.size_label} else ${textLimits.material}`);
    expect(sql).toContain(`when 'formality' then ${integerRanges.formality[1]} else ${integerRanges.upper_coverage[1]}`);
    expect(integerRanges.lower_coverage).toEqual(integerRanges.upper_coverage);
    expect(sql).toContain('n<>trunc(n) or n<0 or n>lim');
    expect(sql).toContain(`octet_length(convert_to(p_facts::text,'UTF8'))>${maximumAiBytes}`);
    expect(sql).toContain(`octet_length(convert_to(private.ai_result(r,p_facts)::text,'UTF8'))>${maximumAiBytes}`);
    expect(sql).toContain(`generation between 1 and ${maximumAiCounter}`);
    expect(sql).toContain(`prompt_version between 1 and ${maximumAiCounter}`);
    expect(sql).toContain(`result_ttl_seconds between 1 and ${maximumAiLifetimeMs / 1000}`);
    expect(sql).toContain('floor(extract(epoch from p_request.created_at)*1000)::bigint');
    expect(sql).toContain('floor(extract(epoch from p_request.expires_at)*1000)::bigint');
    expect(sql).toContain("'^[A-Za-z0-9._:/-]{1,128}$'");
    expect(sql).toContain("'^[0-9a-f]{64}$'");
  });
});
const modules = ['ai-analysis', 'ai-draft'].map((name) => path.join(root, 'src/domain', `${name}.ts`));
function imports(source: string, filename: string): string[] {
  const found: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return found;
}
function resolveImport(filename: string, specifier: string): string | undefined {
  return ts.resolveModuleName(specifier, filename, {
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
  }, ts.sys).resolvedModule?.resolvedFileName;
}
describe('executable unwired production boundary', () => {
  it('non-vacuously resolves static/type/re-export/dynamic imports, extensions and relative paths', () => {
    const filename = path.join(root, 'src/features/boundary-probe.tsx');
    const source = [
      "import { x } from '../domain/ai-analysis';",
      "import type { X } from '../domain/ai-analysis.ts';",
      "export { x } from './../domain/ai-draft';",
      "export type { Y } from '../domain/ai-draft.ts';",
      "const load = import('../domain/ai-draft');",
      "type Z = import('../domain/ai-analysis').AiResult;",
      "const other = import(`../domain/ai-analysis.ts`);",
    ].join('\n');
    const resolved = imports(source, filename).map((specifier) => resolveImport(filename, specifier));
    expect(resolved).toHaveLength(7);
    expect(resolved.every((entry) => entry && modules.includes(entry))).toBe(true);
    expect(resolveImport(modules[0]!, './ai-draft')).toBe(modules[1]);
  });
  it('walks every other source TS/TSX file and forbids importing either contract', async () => {
    const files: string[] = await walkFiles(path.join(root, 'src'));
    const existing = files.filter((filename) => /\.tsx?$/.test(filename) && !modules.includes(filename));
    expect(existing.length).toBeGreaterThan(30);
    let count = 0;
    for (const filename of existing) {
      for (const specifier of imports(await readFile(filename, 'utf8'), filename)) {
        count++;
        expect(modules, `${path.relative(root, filename)} imports ${specifier}`).not.toContain(resolveImport(filename, specifier));
      }
    }
    expect(count).toBeGreaterThan(30);
  });
  it('allows only reviewed direct domain imports in the new modules', async () => {
    const allowed = [...modules, ...['wardrobe', 'preferences', 'attribute-provenance', 'garment-fields']
      .map((name) => path.join(root, 'src/domain', `${name}.ts`))];
    for (const filename of modules) {
      const references = imports(await readFile(filename, 'utf8'), filename);
      expect(references.length).toBeGreaterThan(0);
      for (const specifier of references) expect(allowed).toContain(resolveImport(filename, specifier));
    }
  });
});
