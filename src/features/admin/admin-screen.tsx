import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { OwnerScope } from '../../auth/session';
import { ADMIN_REASONS, readAdminSpending, readAdminStatus, writeAdminLimits, type AdminReason } from '../../data/admin';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import {
  SPEND_PURPOSES, belowUse, draftOf, formatUsd, formatUsdCents, limitsFromDraft, monthTotals, sameLimits,
  type AdminAccount, type AdminSpending, type FieldErrors, type LimitReason, type Limits, type MonthSpend, type SpendPurpose,
} from '../../domain/admin-limits';
import { locales, type Language, type MessageKey, type Translate } from '../../i18n';
import { monthSplit, usageShare } from './usage-share';
import '../../styles/data-flow.css';

type Props = { client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate; onBack: () => void };
type Load = { kind: 'checking' } | { kind: 'denied' } | { kind: 'failed' } | { kind: 'ready'; spending: AdminSpending; failed: boolean; read: number };

const purposeKey: Record<SpendPurpose, MessageKey> = { analysis: 'admin.tagging', stylist: 'admin.stylist', enhancement: 'admin.enhancement', tryOn: 'admin.tryOn' };
const reasonKey: Record<AdminReason, MessageKey> = { RAISE: 'admin.reasonRaise', LOWER: 'admin.reasonLower', PAUSE: 'admin.reasonPause',
  RESTORE: 'admin.reasonRestore', CORRECTION: 'admin.reasonCorrection' };
const errorKey: Record<LimitReason, MessageKey> = { FORMAT: 'admin.errFormat', NOT_POSITIVE: 'admin.errPositive', APP_LIMIT: 'admin.overAppLimit' };
const whole = (value: number, language: Language) => new Intl.NumberFormat(locales[language]).format(value);
const monthName = (month: string, language: Language) => new Intl.DateTimeFormat(locales[language], { month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${month}-15T12:00:00.000Z`));

// The admin's spending and limits view (ADR27): per account and feature, amounts the app has recorded, and the limits
// the admin may change. It re-checks admin status on arrival; state is held only here and ends with the owner scope.
export function AdminScreen({ client, scope, online, language, t, onBack }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'checking' });
  const [months, setMonths] = useState<6 | 12>(6);
  const [month, setMonth] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const requested = useRef(0);
  const admin = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      if (!admin.current) {
        if (!await readAdminStatus(client, scope, controller.signal)) return 'denied' as const;
        admin.current = true;
      }
      return readAdminSpending(client, scope, months, controller.signal);
    })().then((result) => {
      if (controller.signal.aborted) return;
      if (result === 'denied' || result.kind === 'unavailable') { admin.current = false; setLoad({ kind: 'denied' }); return; }
      setLoad({ kind: 'ready', spending: result.spending, failed: false, read: tick });
    }, (problem: unknown) => {
      if (controller.signal.aborted || isAborted(problem)) return;
      setLoad((current) => current.kind === 'ready' ? { ...current, failed: true } : { kind: 'failed' });
    });
    return () => controller.abort();
  }, [client, scope, months, tick]);
  // Returns the number of the requested read, so a card can wait for a read that started after its write.
  const reload = () => { requested.current = Math.max(requested.current, tick) + 1; setTick(requested.current); return requested.current; };
  const heading = <div className="page-heading"><div><h1 id="admin-title" tabIndex={-1}>{t('admin.title')}</h1></div></div>;
  if (load.kind === 'checking') return <section className="admin-page" aria-labelledby="admin-title">{heading}<p role="status">{t('common.loading')}</p></section>;
  if (load.kind === 'denied') return <section className="admin-page" aria-labelledby="admin-title">{heading}
    <p>{t('admin.unavailable')}</p><button type="button" className="button button-secondary" onClick={onBack}>{t('common.back')}</button></section>;
  if (load.kind === 'failed') return <section className="admin-page" aria-labelledby="admin-title">{heading}
    <div className="notice notice-error" role="alert"><span>{t('admin.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={reload}>{t('common.retry')}</button></div></section>;
  const spending = load.spending;
  const selected = month !== null && spending.months.includes(month) ? month : spending.months[0]!;
  return <section className="admin-page" aria-labelledby="admin-title">
    {heading}
    <p className="muted">{t('admin.estimates')}</p>
    {load.failed && <div className="notice notice-error" role="alert"><span>{t('admin.loadFailed')} {t('common.stale')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={reload}>{t('common.retry')}</button></div>}
    <div className="admin-months">
      <div className="field"><label htmlFor="admin-month">{t('admin.month')}</label>
        <select id="admin-month" value={selected} onChange={(event) => setMonth(event.target.value)}>
          {spending.months.map((entry) => <option key={entry} value={entry}>{monthName(entry, language)}</option>)}
        </select></div>
      {months === 6 && <button type="button" className="button button-secondary" disabled={!online} onClick={() => setMonths(12)}>{t('admin.moreMonths')}</button>}
    </div>
    <div className="admin-accounts">
      {spending.accounts.map((account) => <AccountCard key={account.admissionNo} account={account} month={selected}
        client={client} scope={scope} online={online} language={language} t={t} read={load.read} readFailed={load.failed} onReload={reload} />)}
    </div>
  </section>;
}

function SpendRow({ label, spend, language, t, total }: { label: string; spend: MonthSpend; language: Language; t: Translate; total?: boolean }) {
  const cell = (key: MessageKey, value: string) => <td data-label={t(key)}>{value}</td>;
  return <tr className={total ? 'admin-total' : undefined}>
    <th scope="row">{label}</th>
    {cell('admin.confirmed', formatUsd(spend.confirmedMicro, language))}
    {cell('admin.estimated', formatUsd(spend.estimatedMicro, language))}
    {cell('admin.reserved', formatUsd(spend.reservedMicro, language))}
    {cell('admin.total', formatUsd(spend.totalMicro, language))}
    {cell('admin.requests', whole(spend.requests, language))}
  </tr>;
}

type Message = { key: MessageKey; tone: 'status' | 'alert'; belowUse?: boolean };
const formMessages = new Set<MessageKey>(['admin.invalid']);
type Edit = { base: Limits; version: string; initial: string; draft: string; errors: FieldErrors };
type Confirm = { limits: Limits };

function AccountCard({ account, month, client, scope, online, language, t, read, readFailed, onReload }: {
  account: AdminAccount; month: string; client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate;
  read: number; readFailed: boolean; onReload: () => number;
}) {
  const id = `admin-account-${account.admissionNo}`;
  const history = account.history.find((entry) => entry.month === month) ?? account.history[0]!;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  // After a write, editing waits for a spending read requested after it, so the form never starts from values the write may have changed.
  const [awaitRead, setAwaitRead] = useState<number | null>(null);
  const reconciling = awaitRead !== null && read < awaitRead;
  const editButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const focusNext = useRef<'summary' | 'message' | 'edit' | 'field' | null>(null);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => () => saveController.current?.abort(), []);
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    (target === 'summary' ? summary.current : target === 'message' ? messageRef.current : target === 'field' ? firstField.current : editButton.current)?.focus();
  });
  const limits = account.limits;
  const canEdit = account.enabled && limits !== null;
  const reconcile = () => setAwaitRead(onReload());
  const usedOf = (used: string, limit: string | null) => <>{limit === null ? formatUsdCents(used, language)
    : t('admin.usedOf', { used: formatUsdCents(used, language), limit: formatUsdCents(limit, language) })}<UsageBar used={used} limit={limit} /></>;
  const split = monthSplit(monthTotals(history));
  const open = () => {
    if (!limits || reconciling || saving) return;
    const initial = draftOf(limits, language);
    setMessage(null);
    setEdit({ base: limits, version: account.accountVersion, initial, draft: initial, errors: {} });
    focusNext.current = 'field';
  };
  const close = (focus: 'edit' | 'message') => { setEdit(null); setConfirm(null); focusNext.current = focus; };
  const review = () => {
    if (!edit) return;
    const { limits: next, errors } = limitsFromDraft(edit.draft, language);
    setEdit({ ...edit, errors });
    if (!next) { setMessage({ key: 'admin.invalid', tone: 'alert' }); focusNext.current = 'summary'; return; }
    if (sameLimits(next, edit.base)) { setMessage({ key: 'admin.unchanged', tone: 'status' }); focusNext.current = 'message'; return; }
    setMessage(null);
    setConfirm({ limits: next });
  };
  const save = async (reason: AdminReason | null) => {
    if (!edit || !confirm || saving) return;
    const controller = new AbortController();
    saveController.current = controller;
    setSaving(true);
    try {
      const result = await writeAdminLimits(client, scope, { admissionNo: account.admissionNo, accountVersion: edit.version,
        expected: edit.base, limits: confirm.limits, reason }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.code === 'INVALID_LIMITS') {
        setConfirm(null);
        setEdit({ ...edit, errors: { [result.field]: result.reason } });
        setMessage({ key: 'admin.invalid', tone: 'alert' });
        focusNext.current = 'summary';
        return;
      }
      setMessage(result.code === 'OK' ? { key: 'admin.saved', tone: 'status', belowUse: result.belowUse }
        : result.code === 'UNCHANGED' ? { key: 'admin.unchanged', tone: 'status' }
          : result.code === 'CONFLICT' ? { key: 'admin.conflict', tone: 'alert' }
            : result.code === 'UNAVAILABLE' ? { key: 'admin.unavailable', tone: 'alert' } : { key: 'admin.failed', tone: 'alert' });
      close('message');
      reconcile();
    } catch (problem) {
      if (controller.signal.aborted || isAborted(problem)) return;
      setMessage({ key: 'admin.unknown', tone: 'alert' });
      close('message');
      reconcile();
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  return <section className="settings-card admin-card" aria-labelledby={id}>
    <h2 id={id}>{t('admin.account', { number: account.admissionNo })}</h2>
    {!account.enabled && <p className="muted">{t('admin.accountOff')}</p>}
    <h3>{t('admin.spendIn', { month: monthName(month, language) })}</h3>
    <dl className="admin-summary">
      <div><dt>{t('admin.used')}</dt><dd>{formatUsdCents(split.usedMicro, language)}</dd></div>
      <div><dt>{t('admin.pending')}</dt><dd>{formatUsdCents(split.pendingMicro, language)}</dd></div>
      <div><dt>{t('admin.requests')}</dt><dd>{whole(split.requests, language)}</dd></div>
    </dl>
    <h3>{t('admin.currentUse')}</h3>
    <dl className="admin-use">
      <div><dt>{t('admin.allFeatures')}</dt><dd>{usedOf(account.current.shared.usedMicro, limits?.monthlyAllowanceMicro ?? null)}
        {limits && belowUse(limits, account.current.shared.usedMicro) && <span className="stats-note">{t('admin.belowUse')}</span>}</dd></div>
      <div><dt>{t('admin.tagging')}</dt><dd>{formatUsdCents(account.current.analysis.usedMicro, language)}</dd></div>
      {(['stylist', 'enhancement', 'tryOn'] as const).map((feature) => <div key={feature}><dt>{t(purposeKey[feature])}</dt>
        <dd>{formatUsdCents(account.current[feature].usedMicro, language)}
          {!account.features[feature].configured && <span className="stats-note">{t('admin.notSetUp')}</span>}</dd></div>)}
    </dl>
    <p className="stats-note">{t('admin.currentNote')}</p>
    <h3>{t('admin.limits')}</h3>
    {!limits ? <p>{t('admin.notSetUp')}</p> : !edit ? <>
      <p>{formatUsd(limits.monthlyAllowanceMicro, language)}</p>
      {canEdit && <button ref={editButton} type="button" className="button button-secondary" disabled={!online || reconciling} onClick={open}>{t('admin.edit')}</button>}
    </> : <LimitsForm id={id} edit={edit} t={t} online={online} saving={saving} firstField={firstField} reviewButton={reviewButton}
      onChange={(draft) => setEdit({ ...edit, draft })} onReview={review} onCancel={() => { setMessage(null); close('edit'); }}
      summary={message && formMessages.has(message.key) ? <div ref={summary} tabIndex={-1} role="alert" className="notice notice-error"><p>{t(message.key)}</p></div> : null} />}
    {message && !formMessages.has(message.key) && <p ref={messageRef} tabIndex={-1} role={message.tone} className={message.tone === 'alert' ? 'notice notice-error' : 'settings-success'}>
      {t(message.key)}{message.belowUse ? ` ${t('admin.belowUse')}` : ''}</p>}
    {reconciling && readFailed && <div className="notice notice-error"><span>{t('admin.checkFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={reconcile}>{t('admin.checkAgain')}</button></div>}
    <details className="admin-details">
      <summary>{t('admin.details')}</summary>
      <h4>{t('admin.spendIn', { month: monthName(month, language) })}</h4>
      <table className="stats-table admin-table">
        <caption className="sr-only">{t('admin.spendIn', { month: monthName(month, language) })}</caption>
        <thead><tr><th scope="col">{t('admin.feature')}</th><th scope="col">{t('admin.confirmed')}</th><th scope="col">{t('admin.estimated')}</th>
          <th scope="col">{t('admin.reserved')}</th><th scope="col">{t('admin.total')}</th><th scope="col">{t('admin.requests')}</th></tr></thead>
        <tbody>
          {SPEND_PURPOSES.map((purpose) => <SpendRow key={purpose} label={t(purposeKey[purpose])} spend={history[purpose]} language={language} t={t} />)}
          <SpendRow label={t('admin.total')} spend={monthTotals(history)} language={language} t={t} total />
        </tbody>
      </table>
      {account.probe.count > 0 && <p className="stats-note">{t('admin.probe', { feature: t('admin.enhancement'), amount: formatUsd(account.probe.allocationMicro, language) })}</p>}
      {account.tryOnProbe.count > 0 && <p className="stats-note">{t('admin.probe', { feature: t('admin.tryOn'), amount: formatUsd(account.tryOnProbe.allocationMicro, language) })}</p>}
    </details>
    {edit && confirm && <ConfirmDialog number={account.admissionNo} from={edit.base} to={confirm.limits} saving={saving} language={language} t={t}
      onCancel={() => { setConfirm(null); requestAnimationFrame(() => reviewButton.current?.focus()); }} onConfirm={(reason) => { void save(reason); }} />}
  </section>;
}

function UsageBar({ used, limit }: { used: string; limit: string | null }) {
  const share = usageShare(used, limit);
  if (share === null) return null;
  return <span className="usage-bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 1000) / 10}%` }} /></span>;
}

function LimitsForm({ id, edit, t, online, saving, firstField, reviewButton, summary, onChange, onReview, onCancel }: {
  id: string; edit: Edit; t: Translate; online: boolean; saving: boolean;
  firstField: RefObject<HTMLInputElement | null>; reviewButton: RefObject<HTMLButtonElement | null>; summary: ReactNode;
  onChange: (draft: string) => void; onReview: () => void; onCancel: () => void;
}) {
  const hint = useId();
  const changed = edit.draft !== edit.initial;
  const input = `${id}-monthly`, error = edit.errors.monthlyAllowanceMicro;
  return <form className="admin-form" noValidate aria-describedby={hint} onSubmit={(event) => { event.preventDefault(); onReview(); }}>
    <p id={hint} className="muted">{t('admin.usdHint')}</p>
    {summary}
    <div className="field">
      <label htmlFor={input}>{t('admin.monthly')}</label>
      <input ref={firstField} id={input} inputMode="decimal" autoComplete="off" value={edit.draft}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${input}-error` : undefined} disabled={saving}
        onChange={(event) => onChange(event.target.value)} />
      {error && <p id={`${input}-error`} className="field-error">{t(errorKey[error])}</p>}
    </div>
    <div className="settings-actions">
      <button ref={reviewButton} type="submit" className="button button-primary" disabled={!online || saving || !changed}>{t('admin.review')}</button>
      <button type="button" className="text-button" disabled={saving} onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  </form>;
}

function ConfirmDialog({ number, from, to, saving, language, t, onCancel, onConfirm }: {
  number: number; from: Limits; to: Limits; saving: boolean; language: Language; t: Translate; onCancel: () => void; onConfirm: (reason: AdminReason | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<AdminReason | ''>('');
  const titleId = useId(), reasonId = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="dialog" aria-labelledby={titleId} aria-busy={saving}
    onCancel={(event) => { event.preventDefault(); if (!saving) onCancel(); }}>
    <h2 id={titleId}>{t('admin.confirmTitle', { number })}</h2>
    <ul className="admin-changes"><li>{t('admin.changeLine', { label: t('admin.monthly'),
      from: formatUsd(from.monthlyAllowanceMicro, language), to: formatUsd(to.monthlyAllowanceMicro, language) })}</li></ul>
    <div className="field"><label htmlFor={reasonId}>{t('admin.reason')}</label>
      <select id={reasonId} value={reason} disabled={saving} onChange={(event) => setReason(ADMIN_REASONS.find((entry) => entry === event.target.value) ?? '')}>
        <option value="">{t('admin.reasonNone')}</option>
        {ADMIN_REASONS.map((entry) => <option key={entry} value={entry}>{t(reasonKey[entry])}</option>)}
      </select></div>
    {saving && <p role="status">{t('common.saving')}</p>}
    <div className="dialog-actions">
      <button type="button" className="button button-primary" disabled={saving} onClick={() => onConfirm(reason || null)}>{t('admin.confirm')}</button>
      <button type="button" className="button button-secondary" disabled={saving} autoFocus onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  </dialog>;
}
