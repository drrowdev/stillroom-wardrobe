import { useEffect, useRef, useState } from 'react';
import type { SessionController, OwnerScope } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import { errorKey, isAborted } from '../../data/errors';
import { LanguageSelector } from '../../i18n/language-selector';
import type { Language, MessageKey, Translate } from '../../i18n';

type Props = { controller: SessionController; scope: OwnerScope; profile: ProfileRow; language: Language; busy: boolean; online: boolean; t: Translate };
export function LanguageSettings({ controller, scope, profile, language, busy, online, t }: Props) {
  const [error, setError] = useState<MessageKey | null>(null);
  const [saved, setSaved] = useState(false);
  const summary = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) summary.current?.focus(); }, [error]);
  async function save(next: Language) {
    setError(null); setSaved(false);
    try {
      await controller.saveProfile(scope, profile, { kind: 'language', language: next });
      if (!scope.signal.aborted) setSaved(true);
    } catch (problem) {
      if (scope.signal.aborted || isAborted(problem)) return;
      setError(errorKey(problem));
      summary.current?.focus();
    }
  }
  return <div className="settings-language">
    <LanguageSelector language={language} onChange={(next) => { void save(next); }} disabled={busy || !online} t={t} />
    <p className="muted fine">{t('settings.languageHint')}</p>
    {!online && <p role="status">{t('common.offline')}</p>}
    {error && <p ref={summary} tabIndex={-1} className="notice notice-error" role="alert">{t(error)}</p>}
    {error === 'error.conflict' && <button className="text-button" disabled={busy || !online} onClick={() => {
      void controller.reloadProfile(scope).then(() => { if (!scope.signal.aborted) setError(null); }).catch(() => {});
    }}>{t('settings.reload')}</button>}
    {saved && <p className="settings-success" role="status">{t('language.saved')}</p>}
  </div>;
}
