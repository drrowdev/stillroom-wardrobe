import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { AssertionError } from 'node:assert';
import path from 'node:path';
import {
  ROOT, DB_CONTAINER, PROJECT_ID, MIGRATION_HASH, assertLoopbackUrl, assertLocalApi, assertPublishableKey,
  normalSessionEnvironment, validateSessionEnvironment, commandEnvironment, requireDocker, requireLocalContainer,
  LocalBackendError, securityFailureExitCode, describeGenerationResult, describeStartupOrResetFailure,
} from '../../scripts/backend/local.mjs';

declare module '../../scripts/backend/local.mjs' {
  export function describeStartupOrResetFailure(result: unknown, elapsedMs: unknown): Record<string, unknown>;
  export function describeGenerationResult(result: unknown, elapsedMs: unknown): {
    tag: 'success' | 'nonzero-empty-output' | 'nonzero-with-stderr' | 'nonzero-with-stdout'
      | 'missing-database-output' | 'missing-images-output' | 'invalid-result';
    exitCode: number | null;
    elapsedMs: number | null;
    stdoutBytes: number | null;
    stderrBytes: number | null;
    hasDatabaseOutput: boolean;
    hasImagesOutput: boolean;
    stderrMentionsConnectPhase: boolean;
    stderrLines: number | null;
    stderrFirstLineBytes: number | null;
    stderrDockerOperation: 'none' | 'inspect-image' | 'pull-image' | 'create-container' | 'start-container'
      | 'inspect-container' | 'read-logs' | 'copy-logs' | 'run-container';
  };
}

const credentials = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only',
  TEST_A_EMAIL: 'user-a@example.test', TEST_A_PASSWORD: 'a'.repeat(32),
  TEST_B_EMAIL: 'user-b@example.test', TEST_B_PASSWORD: 'b'.repeat(32),
  ALLOW_SECURITY_TESTS: '1',
};

describe('safe local type-generation description', () => {
  const stdout = 'export type Database = { item_images: {} }';
  const keys = ['tag', 'exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes', 'hasDatabaseOutput', 'hasImagesOutput',
    'stderrMentionsConnectPhase', 'stderrLines', 'stderrFirstLineBytes', 'stderrDockerOperation'];
  const tags = ['success', 'nonzero-empty-output', 'nonzero-with-stderr', 'nonzero-with-stdout',
    'missing-database-output', 'missing-images-output', 'invalid-result'];
  const operations = [
    ['failed to inspect docker image', 'inspect-image'],
    ['failed to pull docker image', 'pull-image'],
    ['failed to create docker container:', 'create-container'],
    ['failed to start docker container ', 'start-container'],
    ['failed to inspect docker container:', 'inspect-container'],
    ['failed to read docker logs:', 'read-logs'],
    ['failed to copy docker logs:', 'copy-logs'],
    ['error running container:', 'run-container'],
  ] as const;
  const inactive = {
    stderrMentionsConnectPhase: false, stderrLines: null, stderrFirstLineBytes: null, stderrDockerOperation: 'none',
  };

  function expectFixedReport(report: ReturnType<typeof describeGenerationResult>) {
    expect(Object.keys(report)).toEqual(report.tag === 'nonzero-with-stderr' ? [...keys, 'stderrContainerExitBucket'] : keys);
    if ('stderrContainerExitBucket' in report) {
      expect(['exit-125', 'exit-126-or-127', 'other-nonzero', 'unclassified']).toContain(report.stderrContainerExitBucket);
    }
    expect(tags).toContain(report.tag);
    for (const field of ['exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes', 'stderrLines', 'stderrFirstLineBytes'] as const) {
      const value = report[field];
      expect(value === null || typeof value === 'number' && Number.isSafeInteger(value)).toBe(true);
      if (field !== 'exitCode' && value !== null) expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(typeof report.hasDatabaseOutput).toBe('boolean');
    expect(typeof report.hasImagesOutput).toBe('boolean');
    expect(typeof report.stderrMentionsConnectPhase).toBe('boolean');
    expect(['none', ...operations.map(([, operation]) => operation)]).toContain(report.stderrDockerOperation);
    if (report.tag !== 'nonzero-with-stderr') expect(report).toMatchObject(inactive);
    expect(JSON.stringify(report).length).toBeLessThan(512);
  }

  it('describes the exact successful tuple without changing or returning it', () => {
    const result = Object.freeze({ code: 0, stdout, stderr: '' });
    const report = describeGenerationResult(result, 12.75);
    expect(report).toEqual({
      tag: 'success', exitCode: 0, elapsedMs: 12, stdoutBytes: 42, stderrBytes: 0,
      hasDatabaseOutput: true, hasImagesOutput: true,
      ...inactive,
    });
    expectFixedReport(report);
    expect(result).toEqual({ code: 0, stdout, stderr: '' });
  });

  it.each([
    [2, '', '', 'nonzero-empty-output', false, false],
    [1, '', 'synthetic error', 'nonzero-with-stderr', false, false],
    [1, stdout, 'synthetic error', 'nonzero-with-stderr', true, true],
    [-1, stdout, '', 'nonzero-with-stdout', true, true],
    [0, '', '', 'missing-database-output', false, false],
    [0, 'item_images:', '', 'missing-database-output', false, true],
    [0, 'export type Database = {}', '', 'missing-images-output', true, false],
    [0, stdout, 'synthetic warning', 'success', true, true],
    [0, 'export type Database= { item_images : {} }', '', 'missing-database-output', false, false],
  ])('uses observational precedence for case %#', (code, output, error, tag, database, images) => {
    const report = describeGenerationResult({ code, stdout: output, stderr: error }, 180_001);
    expectFixedReport(report);
    expect(report).toMatchObject({ tag, exitCode: code, hasDatabaseOutput: database, hasImagesOutput: images });
    expect(report.stdoutBytes).toBe(Buffer.byteLength(output as string, 'utf8'));
    expect(report.stderrBytes).toBe(Buffer.byteLength(error as string, 'utf8'));
  });

  it('counts UTF-8 bytes of retained strings, not characters or supplied counters', () => {
    const report = describeGenerationResult({
      code: 1, stdout: 'ä🙂', stderr: '漢\u0000', stdoutBytes: 999, stderrBytes: 999,
      tag: 'success', hasDatabaseOutput: true, hasImagesOutput: true,
    }, 0);
    expectFixedReport(report);
    expect(report).toEqual({
      tag: 'nonzero-with-stderr', exitCode: 1, elapsedMs: 0, stdoutBytes: 6, stderrBytes: 4,
      hasDatabaseOutput: false, hasImagesOutput: false,
      stderrMentionsConnectPhase: false, stderrLines: 0, stderrFirstLineBytes: 4, stderrDockerOperation: 'none',
      stderrContainerExitBucket: 'unclassified',
    });
  });

  it.each(operations)('observes the exact embedded CLI literal %s', (literal, operation) => {
    const stderr = `prior announcement\nCLI: ${literal} synthetic detail`;
    const result = Object.freeze({ code: 1, stdout: '', stderr });
    const report = describeGenerationResult(result, 1);
    expectFixedReport(report);
    expect(report.stderrDockerOperation).toBe(operation);
    expect(result).toEqual({ code: 1, stdout: '', stderr });
    const nearMiss = describeGenerationResult({ code: 1, stdout: '', stderr: literal.slice(0, -1) }, 1);
    expectFixedReport(nearMiss);
    expect(nearMiss.stderrDockerOperation).toBe('none');
  });

  it.each(operations)('uses fixed precedence rather than text position for %s', (literal, operation) => {
    const index = operations.findIndex(([candidate]) => candidate === literal);
    const later = operations.slice(index + 1).map(([candidate]) => candidate);
    for (const sequence of [[literal, ...later], [...later].reverse().concat(literal)]) {
      const report = describeGenerationResult({ code: 1, stdout: '', stderr: sequence.join('\nCLI: ') }, 1);
      expectFixedReport(report);
      expect(report.stderrDockerOperation).toBe(operation);
    }
  });

  it.each([
    ['Connecting to', true], ['prior\nCLI: Connecting to fictional target', true],
    ['connecting to', false], ['Connecting', false], ['unknown Docker failure', false],
  ])('observes only the case-sensitive connection literal for case %#', (stderr, expected) => {
    const report = describeGenerationResult({ code: 1, stdout: '', stderr }, 1);
    expectFixedReport(report);
    expect(report.stderrMentionsConnectPhase).toBe(expected);
    expect(report.stderrDockerOperation).toBe('none');
  });

  it.each([
    ['', null, null], ['plain', 0, 5], ['\n', 1, 0], ['\n\n', 2, 0],
    ['a\nb\n', 2, 1], ['a\r\nb\r\n', 2, 2], ['\r\n', 1, 1], ['a\rb', 0, 3],
    ['ä🙂', 0, 6], ['ä🙂\r\n漢\n', 2, 7], ['漢\u0000\n', 1, 4],
  ])('counts LF separators and UTF-8 bytes before LF for case %#', (stderr, lines, bytes) => {
    const report = describeGenerationResult({ code: 1, stdout: '', stderr }, 1);
    expectFixedReport(report);
    expect(report).toMatchObject({ stderrLines: lines, stderrFirstLineBytes: bytes });
  });

  it('keeps observations inactive for every other tag even with matching text', () => {
    const stderr = `Connecting to\n${operations.map(([literal]) => literal).join('\r\n')}\nerror running container: exit 125\n`;
    const cases = [
      { code: 0, stdout, stderr }, { code: 0, stdout: '', stderr },
      { code: 0, stdout: 'export type Database = {}', stderr },
      { code: null, stdout, stderr }, { code: 1, stdout: null, stderr },
      { code: 1, stdout: stderr, stderr: '' }, { code: 1, stdout: '', stderr: '' },
    ];
    for (const result of cases) {
      const report = describeGenerationResult(result, 1);
      expectFixedReport(report);
      expect(report).toMatchObject(inactive);
    }
    const invalidElapsed = describeGenerationResult({ code: 1, stdout, stderr }, Infinity);
    expectFixedReport(invalidElapsed);
    expect(invalidElapsed).toMatchObject({ tag: 'invalid-result', ...inactive });
  });

  // SOURCE-DERIVED, not observed stderr: pinned CLI 2.116.0 types.handler.ts and
  // shared/output/output.layer.ts emit this uncoloured message with a trailing LF.
  it.each([
    [0, 'unclassified'], [1, 'other-nonzero'], [124, 'other-nonzero'], [125, 'exit-125'],
    [126, 'exit-126-or-127'], [127, 'exit-126-or-127'], [128, 'other-nonzero'],
    [255, 'other-nonzero'], [256, 'unclassified'],
  ])('buckets only the complete source-derived container exit %s', (exit, bucket) => {
    for (const prefix of ['', 'Connecting to db 5432\nsynthetic container detail\n']) {
      const stderr = `${prefix}error running container: exit ${exit}\n`;
      const report = describeGenerationResult(Object.freeze({ code: 1, stdout: '', stderr }), 12.75);
      expectFixedReport(report);
      expect(report).toHaveProperty('stderrContainerExitBucket', bucket);
      const legacy = Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'stderrContainerExitBucket'));
      expect(JSON.stringify(legacy)).toBe(JSON.stringify({
        tag: 'nonzero-with-stderr', exitCode: 1, elapsedMs: 12, stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(stderr), hasDatabaseOutput: false, hasImagesOutput: false,
        stderrMentionsConnectPhase: prefix !== '', stderrLines: prefix === '' ? 1 : 3,
        stderrFirstLineBytes: prefix === '' ? 30 + String(exit).length : 21,
        stderrDockerOperation: 'run-container',
      }));
    }
  });

  it.each([
    '', '0', '00', '01', '0125', '+125', '-125', '125.0', '1.25', '125e0', '0x7d',
    '125n', '125text', '125 126', '125 ', ' 125', '\t125', '125\t', '256', '999',
    '1250', '125' + '0'.repeat(1000), '１２５', '125\u0000', '125\u2028',
  ])('rejects a noncanonical or partial exit token, case %#', (token) => {
    const report = describeGenerationResult({ code: 1, stdout: '', stderr: `error running container: exit ${token}\n` }, 1);
    expectFixedReport(report);
    expect(report).toHaveProperty('stderrContainerExitBucket', 'unclassified');
  });

  it.each([
    'unrelated failure\n', 'exit 125\n', 'error running container:\n',
    'error running container: exit\n', 'error running container:exit 125\n',
    'error running container: exit 125', 'error running container: exit 125\r\n',
    'error running container: exit 125\r', 'Error running container: exit 125\n',
    'prefix error running container: exit 125\n', ' error running container: exit 125\n',
    '\terror running container: exit 125\n', '\rerror running container: exit 125\n',
    '`error running container: exit 125`\n', '`error running container: exit 125\n',
    'error running container: exit 125`\n', '"error running container: exit 125"\n',
    '\u001b[31merror running container: exit 125\u001b[39m\n',
    'error running container: exit 125\nerror running container: exit 125\n',
    'error running container: exit 125\nerror running container: exit 127\n',
    'error running container: exit 125\nprefix error running container: exit nope\n',
    'error running container:\nerror running container: exit 125\n',
    'error running container: exit 1250\nerror running container: exit 125\n',
    'error running container: exit 125\nerror running container:',
  ])('rejects absent, unsupported, malformed or ambiguous message framing, case %#', (stderr) => {
    const report = describeGenerationResult({ code: 1, stdout: '', stderr }, 1);
    expectFixedReport(report);
    expect(report).toHaveProperty('stderrContainerExitBucket', 'unclassified');
  });

  it('bounds only the new scan in UTF-8 bytes without changing old observations', () => {
    const message = 'error running container: exit 125\n';
    for (const [fill, bytes] of [['x', 1], ['ä', 2]] as const) {
      const remaining = 4096 - message.length - 1;
      const prefix = fill.repeat(Math.floor(remaining / bytes)) + 'x'.repeat(remaining % bytes) + '\n';
      expect(Buffer.byteLength(prefix + message)).toBe(4096);
      for (const [stderr, bucket] of [
        [prefix + message, 'exit-125'],
        ['x' + prefix + message, 'unclassified'],
        [message + 'x'.repeat(4096), 'unclassified'],
        [prefix + message + 'error running container: exit 127\n', 'unclassified'],
      ] as const) {
        const report = describeGenerationResult({ code: 1, stdout: '', stderr }, 1);
        expectFixedReport(report);
        expect(report).toHaveProperty('stderrContainerExitBucket', bucket);
        expect(report.stderrBytes).toBe(Buffer.byteLength(stderr));
        expect(report.stderrDockerOperation).toBe('run-container');
        expect(report.stderrLines).toBe(stderr.split('\n').length - 1);
        expect(report.stderrFirstLineBytes).toBe(Buffer.byteLength(stderr.split('\n')[0]!));
      }
    }
  });

  it('leaves the old operation priority independent of the numeric bucket', () => {
    for (const [literal, operation] of operations.slice(0, -1)) {
      for (const lines of [[literal, 'error running container: exit 127'], ['error running container: exit 127', literal]]) {
        const report = describeGenerationResult({ code: 1, stdout, stderr: lines.join('\n') + '\n' }, 1);
        expectFixedReport(report);
        expect(report.stderrDockerOperation).toBe(operation);
        expect(report).toHaveProperty('stderrContainerExitBucket', 'exit-126-or-127');
      }
    }
  });

  it('preserves the complete serialized legacy output for inactive and invalid branches', () => {
    const message = 'error running container: exit 125\n';
    const fixtures = [
      [{ code: 0, stdout, stderr: message }, 'success', 0, 42, 34, true, true],
      [{ code: 0, stdout: '', stderr: message }, 'missing-database-output', 0, 0, 34, false, false],
      [{ code: 0, stdout: 'export type Database = {}', stderr: message }, 'missing-images-output', 0, 25, 34, true, false],
      [{ code: 1, stdout: '', stderr: '' }, 'nonzero-empty-output', 1, 0, 0, false, false],
      [{ code: 1, stdout, stderr: '' }, 'nonzero-with-stdout', 1, 42, 0, true, true],
      [{ code: null, stdout, stderr: message }, 'invalid-result', null, 42, 34, true, true],
      [{ code: 1, stdout: null, stderr: message }, 'invalid-result', 1, null, 34, false, false],
    ] as const;
    for (const [result, tag, exitCode, stdoutBytes, stderrBytes, database, images] of fixtures) {
      const report = describeGenerationResult(result, 1);
      expectFixedReport(report);
      expect(JSON.stringify(report)).toBe(JSON.stringify({
        tag, exitCode, elapsedMs: 1, stdoutBytes, stderrBytes,
        hasDatabaseOutput: database, hasImagesOutput: images, ...inactive,
      }));
    }
  });

  it('does not read or coerce unsupported stderr values or supplied bucket properties', () => {
    const accessor = vi.fn(() => { throw new Error('synthetic private coercion'); });
    for (const stderr of [undefined, null, 125, true, 1n, Symbol('private'), [],
      new String('error running container: exit 125\n'), { toString: accessor, toJSON: accessor }]) {
      const report = describeGenerationResult({ code: 1, stdout, stderr }, 1);
      expectFixedReport(report);
      expect(report).toMatchObject({ tag: 'invalid-result', stderrBytes: null, ...inactive });
    }
    const result = { code: 1, stdout, stderr: 'error running container: exit 125\n', toJSON: accessor };
    Object.defineProperty(result, 'stderrContainerExitBucket', { get: accessor });
    expect(describeGenerationResult(result, 1)).toHaveProperty('stderrContainerExitBucket', 'exit-125');
    for (const field of ['code', 'stdout', 'stderr']) {
      const report = describeGenerationResult(Object.defineProperty({ ...result }, field, { get: accessor }), 1);
      expectFixedReport(report);
      expect(report.tag).toBe('invalid-result');
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it.each([undefined, null, false, '0', 1n, NaN, Infinity, -Infinity, 0.5,
    Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])('rejects invalid exit code case %#', (code) => {
    const report = describeGenerationResult({ code, stdout, stderr: '' }, 1);
    expectFixedReport(report);
    expect(report).toMatchObject({ tag: 'invalid-result', exitCode: null, hasDatabaseOutput: true, hasImagesOutput: true });
  });

  it.each([undefined, null, '1', false, 1n, NaN, Infinity, -Infinity, -0.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid elapsed case %#', (elapsed) => {
      const report = describeGenerationResult({ code: 0, stdout, stderr: '' }, elapsed);
      expectFixedReport(report);
      expect(report).toMatchObject({ tag: 'invalid-result', elapsedMs: null });
    },
  );

  it.each([Number.MIN_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER])('preserves bounded exit code %s', (code) => {
    const report = describeGenerationResult({ code, stdout, stderr: '' }, Number.MAX_SAFE_INTEGER);
    expectFixedReport(report);
    expect(report).toMatchObject({ exitCode: code, elapsedMs: Number.MAX_SAFE_INTEGER,
      tag: code === 0 ? 'success' : 'nonzero-with-stdout' });
  });

  it('never serializes synthetic private text, including malformed and unknown inputs', () => {
    const canary = 'generation-report-canary-8f42c6e9';
    const privateParts = [
      canary, ['sb', 'secret', 'fictional-only-0123456789'].join('_'),
      ['ghp', 'x'.repeat(36)].join('_'),
      [Buffer.from('{}').toString('base64url'),
        Buffer.from(JSON.stringify({ role: ['service', 'role'].join('_') })).toString('base64url'), 'signature'].join('.'),
      ['postgresql:', '//fictional:never-a-password@example.test/db'].join(''),
      '/private/fictional.sql', 'SELECT fictional_private_value;',
    ];
    const text = privateParts.join('\n');
    const accessor = vi.fn(() => { throw new Error(text); });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const unknown = { code: 0, stdout, stderr: '', toJSON: accessor, message: text, path: text, payload: text };
    Object.defineProperty(unknown, 'unrelated', { get: accessor });
    const cases = [
      undefined, null, true, 0, text, Symbol(text), [], new Error(text), {},
      Object.create({ code: 0, stdout, stderr: '' }),
      { code: 0, stdout: text, stderr: text }, { code: 1, stdout: text, stderr: text },
      { code: 1, stdout: text, stderr: '' }, { code: 2, stdout: '', stderr: '' },
      { code: 0, stdout: `${stdout}\n${text}`, stderr: text },
      { code: 0, stdout: `export type Database = {}\n${text}`, stderr: text },
      { code: text, stdout: text, stderr: text }, { code: 0, stdout: { toString: accessor }, stderr: text },
      { code: 0, stdout: text, stderr: null }, Object.defineProperty({}, 'code', { get: accessor }),
      ...operations.map(([literal]) => ({
        code: 1, stdout: text, stderr: `${text}\nConnecting to ${text}\nCLI: ${literal} ${text}`,
        stderrMentionsConnectPhase: text, stderrLines: text, stderrFirstLineBytes: text, stderrDockerOperation: text,
      })),
      ...['125', '126', '127', '128', '0', '125private'].map((token) => ({
        code: 1, stdout: text, stderr: `${text}\nerror running container: exit ${token}\n${text}\n`,
        stderrContainerExitBucket: text, toJSON: accessor,
      })),
      { code: 1, stdout, stderr: 'unknown', stderrMentionsConnectPhase: true,
        stderrLines: 999, stderrFirstLineBytes: 999, stderrDockerOperation: 'inspect-image' },
      Object.defineProperty({ code: 1, stdout }, 'stderr', { get: accessor }),
      new Proxy({}, { getOwnPropertyDescriptor: accessor }), revoked.proxy, unknown,
    ];
    for (const result of cases) {
      const report = describeGenerationResult(result, 1);
      expectFixedReport(report);
      for (const part of privateParts) expect(JSON.stringify(report).includes(part)).toBe(false);
      expect(JSON.stringify(report)).not.toContain('error running container:');
    }
    for (const result of [null, {}, new Error(text), revoked.proxy,
      { code: 0, stdout: null, stderr: '' }, { code: 0, stdout, stderr: [] }]) {
      expect(describeGenerationResult(result, 1).tag).toBe('invalid-result');
    }
    expect(accessor).toHaveBeenCalledTimes(1); // Only the throwing Proxy trap, never an accessor/coercion/toJSON.
    expect(describeGenerationResult(unknown, text)).toMatchObject({ tag: 'invalid-result', elapsedMs: null });
  });
});

describe('safe startup/reset failure description', () => {
  const defaults = Object.freeze({
    tag: 'invalid-result', exitCode: null, elapsedMs: null, stdoutBytes: null, stderrBytes: null,
    stderrDockerOperation: 'none', stderrContainerExitBucket: 'unclassified', stderrSqlState: 'none',
    announcedKnownMigrationCount: 0, lastAnnouncedKnownMigrationIndex: null, stderrPortAllocationMarker: false,
  });
  const keys = Object.freeze(['tag', 'exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes',
    'stderrDockerOperation', 'stderrContainerExitBucket', 'stderrSqlState',
    'announcedKnownMigrationCount', 'lastAnnouncedKnownMigrationIndex', 'stderrPortAllocationMarker']);
  const operations = Object.freeze([
    ['failed to inspect docker image', 'inspect-image'],
    ['failed to pull docker image', 'pull-image'],
    ['failed to create docker container:', 'create-container'],
    ['failed to start docker container ', 'start-container'],
    ['failed to inspect docker container:', 'inspect-container'],
    ['failed to read docker logs:', 'read-logs'],
    ['failed to copy docker logs:', 'copy-logs'],
    ['error running container:', 'run-container'],
  ] as const);
  const sqlStates = Object.freeze(['42601', '42P01', '42702', '42703', '42883', '42501',
    '23505', '23503', '23514', '55P03', '40P01']);
  const migrations = Object.freeze([
    '20260905000000_initial.sql', '20260906000000_item_field_provenance.sql',
    '20260909070000_item_description_edit.sql', '20260909110000_item_optional_collections.sql',
    '20260909180000_ai_request_controls.sql', '20260910070000_checked_item_save.sql',
    '20260911040000_ai_analysis_backend.sql',
  ]);

  function report(result: unknown, ...elapsed: [] | [unknown]) {
    const value = describeStartupOrResetFailure(result, elapsed.length ? elapsed[0] : 1);
    expect(Reflect.ownKeys(value)).toEqual(keys);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    for (const key of keys) expect(Object.getOwnPropertyDescriptor(value, key)).toHaveProperty('value');
    expect(['invalid-result', 'success', 'nonzero-empty-output', 'nonzero-with-stdout', 'nonzero-with-stderr']).toContain(value.tag);
    for (const key of ['exitCode', 'elapsedMs', 'stdoutBytes', 'stderrBytes',
      'announcedKnownMigrationCount', 'lastAnnouncedKnownMigrationIndex']) {
      const field = value[key];
      expect(field === null || typeof field === 'number' && Number.isSafeInteger(field) && field >= 0).toBe(true);
    }
    if (value.exitCode !== null) expect(value.exitCode).toBeLessThanOrEqual(255);
    expect(value.announcedKnownMigrationCount).not.toBeNull();
    expect(value.announcedKnownMigrationCount).toBeLessThanOrEqual(7);
    if (value.lastAnnouncedKnownMigrationIndex !== null) {
      expect(value.lastAnnouncedKnownMigrationIndex).toBeGreaterThanOrEqual(1);
      expect(value.lastAnnouncedKnownMigrationIndex).toBeLessThanOrEqual(7);
    }
    expect(['none', 'multiple', ...operations.map(([, operation]) => operation)]).toContain(value.stderrDockerOperation);
    expect(['unclassified', 'exit-125', 'exit-126-or-127', 'other-nonzero']).toContain(value.stderrContainerExitBucket);
    expect(['none', 'unclassified', 'multiple', ...sqlStates]).toContain(value.stderrSqlState);
    expect(typeof value.stderrPortAllocationMarker).toBe('boolean');
    expect(JSON.stringify(value).length).toBeLessThan(512);
    return value;
  }
  const failure = (stderr: string) => report({ code: 1, stdout: '', stderr });

  it.each([
    [0, '', '', 'success'], [0, 'synthetic', 'warning', 'success'],
    [1, '', '', 'nonzero-empty-output'], [255, 'ä🙂', '', 'nonzero-with-stdout'],
    [2, 'ä🙂', '漢\u0000', 'nonzero-with-stderr'],
  ])('returns exactly eleven bounded fields for branch %#', (code, stdout, stderr, tag) => {
    const result = Object.freeze({ code, stdout, stderr });
    expect(report(result, 12.75)).toEqual({
      ...defaults, tag, exitCode: code, elapsedMs: 12,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    });
    expect(result).toEqual({ code, stdout, stderr });
  });

  it('never observes stdout markers or activates failure observations on success', () => {
    const markers = [...operations.map(([literal]) => literal), 'error running container: exit 125',
      ...sqlStates.map((state) => ` (SQLSTATE ${state})`),
      ...migrations.map((name) => `Applying migration ${name}...`), 'port is already allocated'].join('\n') + '\n';
    expect(report({ code: 1, stdout: markers, stderr: '' })).toEqual({
      ...defaults, tag: 'nonzero-with-stdout', exitCode: 1, elapsedMs: 1,
      stdoutBytes: Buffer.byteLength(markers), stderrBytes: 0,
    });
    expect(report({ code: 0, stdout: markers, stderr: markers })).toEqual({
      ...defaults, tag: 'success', exitCode: 0, elapsedMs: 1,
      stdoutBytes: Buffer.byteLength(markers), stderrBytes: Buffer.byteLength(markers),
    });
  });

  it.each(operations)('observes only the fixed Docker literal %s', (literal, operation) => {
    expect(failure(`CLI: ${literal} synthetic\n${literal}`)).toHaveProperty('stderrDockerOperation', operation);
    expect(failure(literal.slice(0, -1))).toHaveProperty('stderrDockerOperation', 'none');
    const other = operations.find(([, candidate]) => candidate !== operation)![0];
    for (const text of [`${literal}\n${other}`, `${other}\n${literal}`]) {
      expect(failure(text)).toHaveProperty('stderrDockerOperation', 'multiple');
    }
  });

  it.each([
    [1, 'other-nonzero'], [125, 'exit-125'], [126, 'exit-126-or-127'],
    [127, 'exit-126-or-127'], [255, 'other-nonzero'], [0, 'unclassified'], [256, 'unclassified'],
  ])('retains strict bounded container exit %s', (exit, bucket) => {
    expect(failure(`before\nerror running container: exit ${exit}\nafter\n`)).toHaveProperty('stderrContainerExitBucket', bucket);
  });

  it.each([
    'error running container: exit 125', 'error running container: exit 125\r\n',
    'prefix error running container: exit 125\n', 'error running container: exit 125 suffix\n',
    'error running container: exit 0125\n', 'error running container: exit +125\n',
    'error running container: exit 125.0\n', 'error running container: exit 1250\n',
    'error running container: exit 125\nerror running container: exit 125\n',
    'error running container: exit 125\nerror running container: private\n',
    '\u001b[31merror running container: exit 125\u001b[0m\n',
  ])('rejects near-miss container framing %#', (stderr) => {
    expect(failure(stderr)).toHaveProperty('stderrContainerExitBucket', 'unclassified');
  });

  it('enforces the existing container scan byte bound', () => {
    const message = '\nerror running container: exit 125\n';
    const bounded = 'ä'.repeat(2030) + 'x' + message;
    expect(Buffer.byteLength(bounded)).toBe(4096);
    expect(failure(bounded)).toHaveProperty('stderrContainerExitBucket', 'exit-125');
    expect(failure('x' + bounded)).toHaveProperty('stderrContainerExitBucket', 'unclassified');
  });

  it.each(sqlStates)('returns only the literal SQLSTATE %s', (state) => {
    expect(failure(`synthetic (SQLSTATE ${state})\r\nrepeat (SQLSTATE ${state})`)).toHaveProperty('stderrSqlState', state);
    expect(failure(`synthetic (SQLSTATE ${state})\nother (SQLSTATE ZZ999)`)).toHaveProperty('stderrSqlState', 'multiple');
  });

  it.each([
    ['SQLSTATE 42P01', 'none'], ['(SQLSTATE 42P01)', 'none'], [' (sqlstate 42P01)', 'none'],
    [' (SQLSTATE 42p01)', 'none'], [' (SQLSTATE 42P01', 'none'],
    [' (SQLSTATE 42P01x)', 'none'], [' (SQLSTATE 42P01 )', 'none'],
    [' (SQLSTATE 42P01\n)', 'none'], [' (SQLSTATE  42P01)', 'none'],
    [' (SQLSTATE ZZ999)', 'unclassified'], [' (SQLSTATE ZZ999) (SQLSTATE ZZ999)', 'unclassified'],
    [' (SQLSTATE ZZ999) (SQLSTATE YY999)', 'multiple'],
    [' (SQLSTATE 42P01) (SQLSTATE 23505)', 'multiple'],
    [' (SQLSTATE ZZ999) (SQLSTATE 42P01)', 'multiple'],
  ])('classifies SQLSTATE framing and distinct observations %#', (stderr, state) => {
    expect(failure(stderr)).toHaveProperty('stderrSqlState', state);
  });

  it.each(migrations)('observes the exact known migration %s with LF/CRLF', (name) => {
    const index = migrations.indexOf(name) + 1;
    for (const newline of ['\n', '\r\n']) {
      expect(failure(`Applying migration ${name}...${newline}Applying migration ${name}...${newline}`))
        .toMatchObject({ announcedKnownMigrationCount: 1, lastAnnouncedKnownMigrationIndex: index });
    }
  });

  it('counts distinct announcements and uses stderr order rather than version order', () => {
    const lines = [...migrations, migrations[1], migrations[0]];
    expect(failure(lines.map((name) => `Applying migration ${name}...\n`).join('')))
      .toMatchObject({ announcedKnownMigrationCount: 7, lastAnnouncedKnownMigrationIndex: 1 });
  });

  it.each([
    'Applying migration private.sql...\n', 'Applying migration /private/20260905000000_initial.sql...\n',
    'prefix Applying migration 20260905000000_initial.sql...\n',
    'Applying migration 20260905000000_initial.sql....\n',
    'Applying migration 20260905000000_initial.sql...\r',
    'Applying migration 20260905000000_initial.sql...',
    'Applying migration 20260905000000_initial.sql... trailing\n',
    'Applying migration 20260905000000_initial.sql...\u2028',
  ])('ignores unknown and near-miss announcements %#', (stderr) => {
    expect(failure(stderr)).toMatchObject({ announcedKnownMigrationCount: 0, lastAnnouncedKnownMigrationIndex: null });
  });

  it('observes only the verified case-sensitive port literal', () => {
    expect(failure('synthetic: port is already allocated.')).toHaveProperty('stderrPortAllocationMarker', true);
    for (const text of ['Port is already allocated', 'port already allocated', 'port is already allocate', 'rate limit disk deadline']) {
      expect(failure(text)).toHaveProperty('stderrPortAllocationMarker', false);
    }
  });

  it('fails closed on malformed, inherited, accessor and coercible input without invoking it', () => {
    const hostile = vi.fn(() => { throw new Error('synthetic private accessor'); });
    const tuple = { code: 1, stdout: '', stderr: '' };
    const cases: unknown[] = [null, undefined, false, 1, 'private', Symbol('private'), 1n, [], new Error('private'),
      {}, Object.create(tuple)];
    for (const code of [-1, 256, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1', true, 1n, Symbol('private')]) {
      cases.push({ ...tuple, code });
    }
    for (const field of ['code', 'stdout', 'stderr']) {
      cases.push(Object.defineProperty({ ...tuple }, field, { get: hostile }));
      for (const value of [undefined, null, {}, [], new String('private'), { toString: hostile, valueOf: hostile, toJSON: hostile }]) {
        cases.push({ ...tuple, [field]: value });
      }
    }
    for (const value of cases) expect(report(value)).toEqual(defaults);
    expect(report({ ...tuple, toJSON: hostile })).toHaveProperty('tag', 'nonzero-empty-output');
    for (const elapsed of [null, undefined, '1', false, 1n, NaN, Infinity, -Infinity, -0.1,
      Number.MAX_SAFE_INTEGER + 1, { valueOf: hostile }, Symbol('private')]) {
      expect(report(tuple, elapsed)).toEqual(defaults);
    }
    expect(report(tuple, Number.MAX_SAFE_INTEGER)).toHaveProperty('elapsedMs', Number.MAX_SAFE_INTEGER);
    expect(hostile).not.toHaveBeenCalled();
  });

  it('returns the same invalid shape if reflection throws after any property', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(report(revoked.proxy)).toEqual(defaults);
    for (const field of ['code', 'stdout', 'stderr']) {
      const proxy = new Proxy({ code: 1, stdout: '', stderr: '' }, {
        getOwnPropertyDescriptor(target, key) {
          if (key === field) throw new Error('synthetic private reflection');
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      expect(report(proxy)).toEqual(defaults);
    }
  });

  it('bounds direct strings and combined UTF-8 bytes before scanning', () => {
    const limit = 16 * 1024 * 1024;
    expect(report({ code: 1, stdout: 'x'.repeat(limit), stderr: '' })).toHaveProperty('stdoutBytes', limit);
    expect(failure('x'.repeat(limit))).toHaveProperty('stderrBytes', limit);
    for (const tuple of [
      { code: 1, stdout: 'x'.repeat(limit + 1), stderr: '' },
      { code: 1, stdout: '', stderr: 'x'.repeat(limit + 1) },
      { code: 1, stdout: 'ä'.repeat(limit / 2), stderr: 'x' },
      { code: 1, stdout: '', stderr: 'ä'.repeat(limit / 2 + 1) },
    ]) expect(report(tuple)).toEqual(defaults);
    expect(failure(' (SQLSTATE ZZ999)'.repeat(100_000))).toHaveProperty('stderrSqlState', 'unclassified');
  });

  it('never serializes private text or caller-supplied report fields', () => {
    const privateParts = ['a2-private-canary', ['sb', 'secret', 'fictional-only'].join('_'),
      ['ghp', 'x'.repeat(36)].join('_'), 'fictional@example.test', '/private/fictional.sql',
      ['postgresql:', '//fictional:never-a-password@example.test/db'].join(''),
      'SELECT fictional_private_value;', 'synthetic-token.payload.signature'];
    const text = privateParts.join('\n');
    const hostile = vi.fn(() => { throw new Error(text); });
    const fakeFields = Object.fromEntries(keys.map((key) => [key, text]));
    expect(report({ ...fakeFields, code: 1, stdout: 'ä🙂', stderr: '漢\u0000' })).toEqual({
      ...defaults, tag: 'nonzero-with-stderr', exitCode: 1, elapsedMs: 1, stdoutBytes: 6, stderrBytes: 4,
    });
    for (const code of [0, 1, null]) {
      const tuple = { code, stdout: text, stderr: text, toJSON: hostile };
      for (const key of keys) Object.defineProperty(tuple, key, { get: hostile });
      const output = report(tuple);
      for (const part of privateParts) expect(JSON.stringify(output)).not.toContain(part);
      expect(output).toMatchObject({ stderrSqlState: 'none', stderrDockerOperation: 'none',
        announcedKnownMigrationCount: 0, lastAnnouncedKnownMigrationIndex: null, stderrPortAllocationMarker: false });
    }
    expect(hostile).not.toHaveBeenCalled();
  });
});

describe('security failure classification', () => {
  const outage = new LocalBackendError('BLOCKED: fictional outage.');
  const assertion = new AssertionError({ message: 'Fictional assertion failure.' });

  it.each([undefined, 0, 1, 2])('preserves primary %s across cleanup outages and assertion failures', (primary) => {
    expect(securityFailureExitCode(primary, outage)).toBe(primary === 1 ? 1 : 2);
    expect(securityFailureExitCode(primary, assertion)).toBe(primary === 2 ? 2 : 1);
  });

  it.each([undefined, null, false, 0, 'BLOCKED', { name: 'LocalBackendError', exitCode: 2 }])('never treats an unknown error as success: %j', (error) => {
    for (const primary of [undefined, 0, 1, 2]) {
      expect(securityFailureExitCode(primary, error)).toBe(primary === 2 ? 2 : 1);
    }
  });

  it.each([null, -1, 3, Number.NaN, '0', '1', '2', {}])('does not propagate an unrecognized primary value: %j', (primary) => {
    expect(securityFailureExitCode(primary, outage)).toBe(2);
    expect(securityFailureExitCode(primary, assertion)).toBe(1);
  });
});

describe('disposable local backend boundaries', () => {
  it.each(['http://127.0.0.1:54321', 'http://localhost:54321/', 'http://[::1]:54321'])('accepts literal loopback origin %s', (url) => {
    expect(assertLocalApi(url)).toBe(url.replace(/\/$/, ''));
  });

  it.each([
    'https://example.supabase.co', 'http://127.0.0.1.evil.test:54321', 'http://user:password@localhost:54321',
    'http://localhost:54321/path', 'http://localhost:54321/?redirect=remote', 'http://localhost:54321/#fragment',
    'http://0.0.0.0:54321', 'http://127.1:54321', 'http://2130706433:54321', 'http://0177.0.0.1:54321',
    'https://localhost:54321', 'http://[::ffff:127.0.0.1]:54321', 'file:///localhost', 'not a URL',
  ])('refuses unsafe/nonliteral URL %s', (url) => {
    expect(() => assertLoopbackUrl(url)).toThrow(/REFUSED/);
  });

  it('restricts tests to the fixed disposable API port even on loopback', () => {
    expect(() => assertLocalApi('http://localhost:443')).toThrow(/port 54321/);
    expect(() => assertLocalApi('http://127.0.0.1:54324')).toThrow(/port 54321/);
    expect(() => validateSessionEnvironment({ ...credentials, SUPABASE_URL: 'https://example.supabase.co', ALLOW_REMOTE_TEST_PROJECT: '1' })).toThrow(/REFUSED/);
  });

  it('rejects both modern service keys and service-role JWTs', () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ role: ['service', 'role'].join('_') })).toString('base64url')}.signature`;
    expect(() => assertPublishableKey(['sb', 'secret', 'unit'].join('_'))).toThrow(/REFUSED/);
    expect(() => assertPublishableKey(jwt)).toThrow(/REFUSED/);
    expect(() => assertPublishableKey('unknown')).toThrow(/REFUSED/);
    const anon = `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature`;
    expect(assertPublishableKey(anon)).toBe(anon);
  });

  it('requires explicit consent and distinct fictional credentials', () => {
    expect(() => validateSessionEnvironment({ ...credentials, ALLOW_SECURITY_TESTS: '' })).toThrow(/NOT RUN/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_A_PASSWORD: '' })).toThrow(/NOT RUN/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_B_PASSWORD: credentials.TEST_A_PASSWORD })).toThrow(/REFUSED/);
    expect(() => validateSessionEnvironment({ ...credentials, TEST_A_EMAIL: 'not-a-fixture@example.test' })).toThrow(/REFUSED/);
  });

  it('whitelists child environment and refuses administrator variables', () => {
    const env = normalSessionEnvironment({
      ALLOW_SECURITY_TESTS: '1', NODE_OPTIONS: '--inspect', UNRELATED_TOKEN: 'private',
      GH_TOKEN: 'not-forwarded', GITHUB_TOKEN: 'not-forwarded', AWS_SECRET_ACCESS_KEY: 'not-forwarded',
    }, credentials);
    expect(Object.keys(env).sort()).toEqual(Object.keys(credentials).sort());
    expect(() => normalSessionEnvironment({ ALLOW_SECURITY_TESTS: '1', SUPABASE_SERVICE_ROLE_KEY: 'private' }, credentials)).toThrow(/REFUSED/);
    expect(() => normalSessionEnvironment({ ALLOW_SECURITY_TESTS: '1', DATABASE_URL: 'private' }, credentials)).toThrow(/REFUSED/);
    expect(commandEnvironment({
      PATH: 'local', SUPABASE_ACCESS_TOKEN: 'private', NODE_OPTIONS: '--inspect', SUPABASE_CLI_BINARY_OVERRIDE: 'other',
      GH_TOKEN: 'not-forwarded', GITHUB_TOKEN: 'not-forwarded', AWS_SECRET_ACCESS_KEY: 'not-forwarded',
    })).toEqual({
      PATH: 'local', NO_COLOR: '1', SUPABASE_TELEMETRY_DISABLED: 'true',
    });
  });

  it('reports missing Docker as NOT RUN with nonzero exit status without requiring Docker', async () => {
    const run = vi.fn().mockResolvedValue({ code: 2, stdout: '', stderr: 'never surfaced' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('NOT RUN: Docker') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses remote Docker contexts before any daemon/reset operation', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: 'ssh://remote.example.test', stderr: '' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('REFUSED') });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine'])('checks daemon health for local Docker endpoint %s', async (endpoint) => {
    const run = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: endpoint, stderr: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'never surfaced' });
    await expect(requireDocker(run)).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('NOT RUN') });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('requires the known project label, container name and Postgres image', async () => {
    const container = { name: `/${DB_CONTAINER}`, project: PROJECT_ID, image: 'public.ecr.aws/supabase/postgres:17.6.1', running: true };
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(container), stderr: '' });
    await expect(requireLocalContainer(run)).resolves.toBeUndefined();
    for (const change of [{ project: 'another-project' }, { name: '/different-db' }, { running: false }, { image: 'postgres:17' }]) {
      run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ...container, ...change }), stderr: '' });
      await expect(requireLocalContainer(run)).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('rejects unknown/remote db arguments without reaching Docker', () => {
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.mjs'), 'reset', '--linked'], {
      env: commandEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('REFUSED');
    expect(child.stdout).toBe('');
  });

  it.each([
    ['types', '--check', '--setup-artifact'],
    ['types', '--setup-artifact', '--check'],
    ['types', '--setup-artifact', '--setup-artifact'],
    ['types', '--check', '--check'],
    ['types', '--setup-artifact', 'extra'],
    ['types', '--check', 'extra'],
    ['types', '--unknown'],
    ['types', '--setup-artifact=elsewhere.ts'],
    ['types', '--setup-artifact', '--output', 'elsewhere.ts'],
    ['start', '--setup-artifact'],
    ['reset', '--setup-artifact'],
    ['start', '--check'],
    ['reset', '--check'],
  ])('rejects invalid db options before Docker: %s %s', (...args) => {
    const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'db.mjs'), ...args], {
      env: commandEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('REFUSED');
    expect(child.stdout).toBe('');
  });

  it('wires checked Save suites through the same stripped normal environment', async () => {
    const source = await readFile(path.join(ROOT, 'scripts', 'run-local-tests.mjs'), 'utf8');
    expect(source).toContain("path.join(ROOT, 'tests', suite, 'item-save.sessions.mjs')");
    expect(source).toContain('const env = normalSessionEnvironment(process.env, credentials)');
    const save = source.slice(source.indexOf('const saveCode'), source.indexOf("if (suite === 'integration')"));
    expect(save).toContain('cwd: ROOT, env, shell: false');
    expect(save).toContain('if (saveCode !== 0) { process.exitCode = saveCode; return; }');
    expect(save).not.toContain('process.env');
  });

  it.each([
    ['scripts', 'run-local-tests.mjs', 'security'],
    ['scripts', 'run-local-tests.mjs', 'integration'],
    ['tests', 'security', 'rls.sessions.mjs'],
    ['tests', 'integration', 'local.sessions.mjs'],
  ])('does not silently skip unavailable normal-session configuration: %s %s', (...segments) => {
    const isRunner = segments[0] === 'scripts';
    const file = path.join(ROOT, ...segments.slice(0, isRunner ? 2 : 3));
    const child = spawnSync(process.execPath, [file, ...(isRunner ? [segments[2]!] : [])], {
      env: commandEnvironment(), encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('NOT RUN');
    expect(child.stdout).not.toContain('PASS');
  });

  it('keeps the reviewed migration and synthetic JPEG byte-for-byte intact', async () => {
    const source = await readFile(path.join(ROOT, 'blueprint', '07-DATABASE-AND-RLS.sql'));
    const migration = await readFile(path.join(ROOT, 'supabase', 'migrations', '20260905000000_initial.sql'));
    expect(migration.equals(source)).toBe(true);
    expect(createHash('sha256').update(migration).digest('hex')).toBe(MIGRATION_HASH);
    const original = await readFile(path.join(ROOT, 'blueprint', 'validation', 'fixture.jpg'));
    const fixture = await readFile(path.join(ROOT, 'tests', 'security', 'fixture.jpg'));
    expect(fixture.equals(original)).toBe(true);
  });
});
