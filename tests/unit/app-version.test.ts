import { afterEach, describe, expect, it, vi } from 'vitest';
import { appVersion } from '../../src/data/app-version';

const commit = '47c3bddbe58dfaf6e9d2b30cf3e7e0b71c180635';

describe('app version label', () => {
  it('uses the short Pages build commit when it is present', () => {
    expect(appVersion({ CF_PAGES_COMMIT_SHA: commit, VITE_APP_VERSION: '6fa15c65' })).toBe('47c3bddb');
    expect(appVersion({ CF_PAGES_COMMIT_SHA: ` ${commit.toUpperCase()} ` })).toBe('47c3bddb');
  });
  it('falls back to VITE_APP_VERSION, then 0.1.0, without a usable commit', () => {
    expect(appVersion({ VITE_APP_VERSION: '6fa15c65' })).toBe('6fa15c65');
    expect(appVersion({ CF_PAGES_COMMIT_SHA: '', VITE_APP_VERSION: ' browser-fixture ' })).toBe('browser-fixture');
    expect(appVersion({ CF_PAGES_COMMIT_SHA: 'not-a-commit', VITE_APP_VERSION: '6fa15c65' })).toBe('6fa15c65');
    expect(appVersion({ CF_PAGES_COMMIT_SHA: commit.slice(0, 12), VITE_APP_VERSION: '6fa15c65' })).toBe('6fa15c65');
    expect(appVersion({})).toBe('0.1.0');
  });
});

describe('build define', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const define = async () => {
    const { default: config } = await import('../../vite.config');
    const resolved = await (config as unknown as (env: { mode: string; command: 'build' }) => { define: Record<string, string> })({ mode: 'unit-version', command: 'build' });
    return resolved.define;
  };
  it('replaces the public VITE_APP_VERSION with the Pages commit at build time', async () => {
    vi.stubEnv('CF_PAGES_COMMIT_SHA', commit);
    vi.stubEnv('VITE_APP_VERSION', '6fa15c65');
    const values = await define();
    expect(values['import.meta.env.VITE_APP_VERSION']).toBe(JSON.stringify('47c3bddb'));
    // Only the short label is defined; the build variable itself is not exposed.
    expect(Object.keys(values).some((key) => key.includes('CF_PAGES'))).toBe(false);
  });
  it('keeps VITE_APP_VERSION outside Pages', async () => {
    vi.stubEnv('CF_PAGES_COMMIT_SHA', '');
    vi.stubEnv('VITE_APP_VERSION', '6fa15c65');
    expect((await define())['import.meta.env.VITE_APP_VERSION']).toBe(JSON.stringify('6fa15c65'));
  });
});
