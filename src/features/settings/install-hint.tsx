import type { Translate } from '../../i18n';
import { browserInstallPlatform } from './install-platform';

export function InstallHint({ t }: { t: Translate }) {
  const platform = browserInstallPlatform(window, navigator);
  if (platform === 'installed') return null;
  return <section className="settings-card" aria-labelledby="install-heading">
    <h2 id="install-heading">{t('install.title')}</h2>
    <p className="muted fine">{t(platform === 'ios' ? 'install.ios' : 'install.android')}</p>
  </section>;
}