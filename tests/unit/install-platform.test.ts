import { describe, expect, it } from 'vitest';
import { browserInstallPlatform, installPlatform } from '../../src/features/settings/install-platform';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ipadDesktop = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const base = { maxTouchPoints: 0, standaloneDisplay: false, navigatorStandalone: undefined };

describe('install hint platform', () => {
  it('shows the Safari steps on iPhone and on iPadOS, which reports a Mac user agent with touch', () => {
    expect(installPlatform({ ...base, userAgent: iphone, maxTouchPoints: 5 })).toBe('ios');
    expect(installPlatform({ ...base, userAgent: ipadDesktop, maxTouchPoints: 5 })).toBe('ios');
  });
  it('shows the browser-menu steps elsewhere, including a Mac without touch', () => {
    expect(installPlatform({ ...base, userAgent: android, maxTouchPoints: 5 })).toBe('other');
    expect(installPlatform({ ...base, userAgent: ipadDesktop })).toBe('other');
  });
  it('shows nothing once the app runs installed', () => {
    expect(installPlatform({ ...base, userAgent: android, standaloneDisplay: true })).toBe('installed');
    expect(installPlatform({ ...base, userAgent: iphone, navigatorStandalone: true })).toBe('installed');
    expect(installPlatform({ ...base, userAgent: iphone, navigatorStandalone: false })).toBe('ios');
  });
  it('reads the browser without matchMedia instead of throwing', () => {
    expect(browserInstallPlatform({}, { userAgent: iphone, maxTouchPoints: 5, standalone: true })).toBe('installed');
    expect(browserInstallPlatform({}, { userAgent: iphone, maxTouchPoints: 5 })).toBe('ios');
    expect(browserInstallPlatform({}, { userAgent: android })).toBe('other');
  });
  it('uses matchMedia when present', () => {
    const standalone = { matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' }) };
    expect(browserInstallPlatform(standalone, { userAgent: android })).toBe('installed');
    expect(browserInstallPlatform({ matchMedia: () => ({ matches: false }) }, { userAgent: android })).toBe('other');
  });
});