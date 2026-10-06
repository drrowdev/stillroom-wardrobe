import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeFlakes, parseAllowlist } from '../../scripts/flake-gate.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const entry = { file: 'enhancement.spec.ts', title: 'replace: a failed enhancement keeps the cut-out and says so', k2: 'K2 enhancement.spec:679' };
const allowlist = parseAllowlist(JSON.stringify([entry]));
const result = (outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped', title = entry.title, file = entry.file) =>
  ({ file, title, project: 'webkit-photo', outcome });

describe('PROC1 flake gate', () => {
  it('passes an allowlisted flaky test with a warning that names it', () => {
    const verdict = judgeFlakes([result('expected', 'other'), result('flaky')], allowlist);
    expect(verdict.failed).toBe(false);
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([`Known flaky test passed on retry: [webkit-photo] enhancement.spec.ts \u203a ${entry.title} (K2 enhancement.spec:679)`]);
  });

  it('fails an unknown flaky test, including the same title in another spec file', () => {
    for (const unknown of [result('flaky', 'replace: something else'), result('flaky', entry.title, 'item-details.spec.ts')]) {
      const verdict = judgeFlakes([unknown], allowlist);
      expect(verdict.failed).toBe(true);
      expect(verdict.warnings).toEqual([]);
      expect(verdict.errors[0]).toContain(`${unknown.file} \u203a ${unknown.title}`);
    }
  });

  it('never excuses a hard failure, even of an allowlisted test', () => {
    // Playwright already fails the run for an unexpected outcome; the gate adds no warning that could read as a pass.
    const verdict = judgeFlakes([result('unexpected')], allowlist);
    expect(verdict).toEqual({ failed: false, warnings: [], errors: [] });
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', '{}'],
    ['a non-object entry', '["x"]'],
    ['a missing K2 reference', JSON.stringify([{ file: entry.file, title: entry.title }])],
    ['an extra key', JSON.stringify([{ ...entry, line: 679 }])],
    ['an empty title', JSON.stringify([{ ...entry, title: '' }])],
    ['an untrimmed title', JSON.stringify([{ ...entry, title: ` ${entry.title}` }])],
    ['a path instead of a file name', JSON.stringify([{ ...entry, file: 'tests/browser/enhancement.spec.ts' }])],
    ['a line number in the file', JSON.stringify([{ ...entry, file: 'enhancement.spec.ts:679' }])],
    ['a reference that is not K2', JSON.stringify([{ ...entry, k2: 'see #160' }])],
    ['a duplicate', JSON.stringify([entry, entry])],
  ])('rejects a malformed allowlist: %s', (_name, text) => {
    expect(() => parseAllowlist(text)).toThrow(/^Known flakes: /);
  });

  it('keeps the checked-in allowlist valid, and both Playwright configs gate flaky tests through it', () => {
    const listed = parseAllowlist(readFileSync(path.join(root, 'tests/known-flakes.json'), 'utf8'));
    expect(listed.length).toBeGreaterThan(0);
    for (const { file } of listed) expect(readFileSync(path.join(root, 'tests/browser', file), 'utf8').length).toBeGreaterThan(0);
    for (const config of ['playwright.config.ts', 'playwright.pwa.config.ts']) {
      const text = readFileSync(path.join(root, config), 'utf8');
      expect(text, config).toContain("['./tests/flake-gate-reporter.ts']");
      expect(text, config).toContain('  failOnFlakyTests: false,');
    }
  });
});
