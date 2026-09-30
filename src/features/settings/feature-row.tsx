import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import type { Translate } from '../../i18n';
import type { FeatureSwitch } from './ai-features-model';

type SheetProps = { id: string; title: string; summary?: string; notice: ReactNode; writing: boolean; disabled: boolean;
  onCancel: () => void; onConfirm: () => void; t: Translate };
export function ConsentSheet({ id, title, summary, notice, writing, disabled, onCancel, onConfirm, t }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog consent-sheet" aria-labelledby={`${id}-sheet-title`} aria-describedby={`${id}-sheet-body`}
    aria-busy={writing} onCancel={(event) => { event.preventDefault(); if (!writing) onCancel(); }}>
    <h2 id={`${id}-sheet-title`}>{title}</h2>
    <div id={`${id}-sheet-body`} className="consent-sheet-body">
      {summary && <p>{summary}</p>}
      {notice}
    </div>
    <div className="dialog-actions">
      <button className="button button-secondary" type="button" autoFocus disabled={writing} onClick={onCancel}>{t('common.cancel')}</button>
      <button className="button button-primary" type="button" disabled={writing || disabled} onClick={onConfirm}>{t(writing ? 'common.saving' : 'aiC.enable')}</button>
    </div>
  </dialog>;
}

type RowProps = {
  id: string; headingRef: RefObject<HTMLHeadingElement | null>; switchRef: RefObject<HTMLButtonElement | null>;
  title: string; description: string; value: string | null; busy: boolean;
  control: FeatureSwitch; switchDisabled: boolean; onSwitch: () => void;
  status: ReactNode; actions: ReactNode; error: ReactNode; notice: ReactNode | null; sheet: ReactNode | null; t: Translate;
};
/**
 * One feature row: title, one-line description, this month's figure, the switch, the state lines and the notice under
 * "How it works and privacy". When the sheet closes, focus returns to the switch, or to the title if the switch is gone.
 * A busy switch is aria-disabled rather than disabled, so it keeps focus while its write runs.
 */
export function FeatureRow({ id, headingRef, switchRef, title, description, value, busy, control, switchDisabled, onSwitch, status, actions, error, notice, sheet, t }: RowProps) {
  const sheetOpen = sheet !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !sheetOpen) {
      const target = switchRef.current?.isConnected ? switchRef.current : headingRef.current;
      target?.focus();
    }
    wasOpen.current = sheetOpen;
  }, [sheetOpen, switchRef, headingRef]);
  const described = [`${id}-description`, ...(value ? [`${id}-value`] : [])].join(' ');
  return <section className="settings-card feature-row" aria-labelledby={id} aria-busy={busy}>
    <div className="feature-main">
      <div className="feature-text">
        <h3 id={id} ref={headingRef} tabIndex={-1}>{title}</h3>
        <p id={`${id}-description`} className="feature-description">{description}</p>
        {value && <p id={`${id}-value`} className="feature-value">{value}</p>}
      </div>
      {control.present && <button ref={switchRef} type="button" role="switch" className="switch" aria-checked={control.checked}
        aria-labelledby={id} aria-describedby={described} aria-disabled={switchDisabled || undefined}
        onClick={switchDisabled ? undefined : onSwitch}>
        <span className="switch-thumb" aria-hidden="true" />
      </button>}
    </div>
    <div role="status" className="ai-state">{status}</div>
    {actions}
    {error}
    {notice && <details className="ai-details"><summary>{t('aiF.about')}</summary>{notice}</details>}
    {sheet}
  </section>;
}
