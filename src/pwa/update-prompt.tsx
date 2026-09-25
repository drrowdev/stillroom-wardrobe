import type { Translate } from '../i18n';
import { applyUpdate, useShellUpdate } from './register';

export function UpdatePrompt({ t }: { t: Translate }) {
  const { waiting, reloading } = useShellUpdate();
  if (!waiting) return null;
  return <div className="language-warning notice update-notice" role="status">
    <span>{t('update.available')}</span>
    <button type="button" className="text-button" disabled={reloading} onClick={applyUpdate}>{t('update.reload')}</button>
  </div>;
}
