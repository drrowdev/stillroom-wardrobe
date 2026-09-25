export type InstallPlatform = 'installed' | 'ios' | 'other';

type Environment = { userAgent: string; maxTouchPoints: number; standaloneDisplay: boolean; navigatorStandalone: boolean | undefined };

// iPadOS Safari reports a desktop Mac user agent, so a touch-capable "Macintosh" counts as iOS.
export function installPlatform({ userAgent, maxTouchPoints, standaloneDisplay, navigatorStandalone }: Environment): InstallPlatform {
  if (standaloneDisplay || navigatorStandalone === true) return 'installed';
  if (/iPhone|iPad|iPod/.test(userAgent) || /Macintosh/.test(userAgent) && maxTouchPoints > 1) return 'ios';
  return 'other';
}
type BrowserWindow = { matchMedia?: (query: string) => { matches: boolean } };
type BrowserNavigator = { userAgent: string; maxTouchPoints?: number; standalone?: boolean };

// Older browsers may lack matchMedia; that must not break Settings.
export function browserInstallPlatform(win: BrowserWindow, nav: BrowserNavigator): InstallPlatform {
  return installPlatform({
    userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints ?? 0,
    standaloneDisplay: typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: nav.standalone,
  });
}