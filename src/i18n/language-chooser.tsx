import { useEffect, useRef, useState } from 'react';
import { catalogueLoaded, type Language, type Translate } from './index';
import { ensureCatalogue } from './load';
import { LanguageSelector } from './language-selector';
import { requestCurrent } from './display-language';

type Props = {
  language: Language;
  onChange: (language: Language) => void;
  t: Translate;
  /** The parent's Auth/entry context. A new object (client, phase, epoch or owner change) cancels a pending choice. */
  context: object;
  disabled?: boolean;
  load?: (language: Language) => Promise<void>;
};

// LANG1: a choice is applied only after its catalogue has loaded; until then the current language stays.
export function LanguageChooser({ language, onChange, t, context, disabled = false, load = ensureCatalogue }: Props) {
  const [pending, setPending] = useState<Language | null>(null);
  const [failed, setFailed] = useState<Language | null>(null);
  const [focus, setFocus] = useState<{ target: 'error' | Language } | null>(null);
  const latest = useRef({ token: 0, context, mounted: false });
  latest.current.context = context;
  const root = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const gate = latest.current;
    gate.mounted = true;
    return () => { gate.mounted = false; gate.token++; };
  }, []);
  // An Auth transition drops a pending or failed choice: nothing stale is applied, shown or focused.
  useEffect(() => {
    latest.current.token++;
    setPending(null); setFailed(null); setFocus(null);
  }, [context]);
  // While the owner's save runs the buttons are disabled; focus moves once they can take it again.
  useEffect(() => {
    if (!focus || (disabled && focus.target !== 'error')) return;
    const element = focus.target === 'error'
      ? root.current?.querySelector<HTMLElement>('.language-load-error')
      : root.current?.querySelector<HTMLElement>(`button[lang="${focus.target}"]`);
    element?.focus();
    setFocus(null);
  }, [focus, disabled]);
  function choose(next: Language, retrying = false) {
    if (catalogueLoaded(next)) {
      latest.current.token++;
      setPending(null); setFailed(null);
      onChangeRef.current(next);
      if (retrying) setFocus({ target: next });
      return;
    }
    const request = { token: ++latest.current.token, context: latest.current.context };
    setFailed(null); setPending(next);
    load(next).then(() => {
      if (!requestCurrent(request, latest.current)) return;
      setPending(null);
      onChangeRef.current(next);
      if (retrying) setFocus({ target: next });
    }, () => {
      if (!requestCurrent(request, latest.current)) return;
      setPending(null); setFailed(next); setFocus({ target: 'error' });
    });
  }
  return <div ref={root} className="language-chooser">
    <LanguageSelector language={language} onChange={(next) => choose(next)} t={t} disabled={disabled} pending={pending} />
    <p className="sr-only" aria-live="polite">{pending ? t('language.loading') : ''}</p>
    {failed && <div className="language-load-failed">
      <p className="language-load-error notice notice-error" role="alert" tabIndex={-1}>{t('language.loadFailed')}</p>
      <button type="button" className="text-button" disabled={disabled} onClick={() => choose(failed, true)}>{t('common.retry')}</button>
    </div>}
  </div>;
}