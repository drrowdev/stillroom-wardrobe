import { Icon } from '../../app/icon';
import { dayParts } from '../../domain/local-date';
import type { WardrobeItem } from '../../domain/wardrobe';
import { locales, type Language, type Translate } from '../../i18n';
import { wearPanelId, type WearToday } from './use-wear-today';

// Above the idea card, never inside it, so it stays with its own look while the ideas change.
export function WearPanel({ wear, byId, language, online, t }: {
  wear: WearToday; byId: ReadonlyMap<string, WardrobeItem>; language: Language; online: boolean; t: Translate;
}) {
  const { state, refs } = wear;
  if (state.kind === 'idle') return null;
  const locale = locales[language];
  const { snapshot } = state;
  const titles = snapshot.titles ?? snapshot.itemIds.map(id => byId.get(id)?.title ?? '').filter(Boolean);
  const day = t('calendar.dayHeading', dayParts(snapshot.localDate, locale));
  const what = `${snapshot.label} · ${day}${titles.length ? `: ${new Intl.ListFormat(locale, { type: 'conjunction' }).format(titles)}` : ''}`;
  const busy = state.kind === 'inFlight';
  return <div ref={refs.panel} id={wearPanelId} className="today-wear">
    <p className="today-wear-look">{what}</p>
    {busy && <p className="muted" role="status">{t('common.saving')}</p>}
    {state.kind === 'settled' && <div className="notice notice-success" role="status"><Icon name="check" /><span>{t(state.message)}</span>
      {state.look && <button ref={refs.undoButton} type="button" className="text-button" disabled={!online} onClick={wear.undo}>{t('common.undo')}</button>}
      <button type="button" className="icon-button" aria-label={t('common.close')} onClick={wear.close}><Icon name="close" /></button></div>}
    {state.kind === 'unresolved' && <div className="notice notice-error" role="alert"><span>{t(state.problem)}</span>
      <button ref={refs.retryButton} type="button" className="text-button" disabled={!online} onClick={wear.retry}>{t('common.retry')}</button></div>}
    {state.kind === 'failed' && <div className="notice notice-error" role="alert"><span>{t(state.problem.key)}</span>
      {state.retry && <button type="button" className="text-button" disabled={!online} onClick={wear.retry}>{t('common.retry')}</button>}
      <button type="button" className="icon-button" aria-label={t('common.close')} onClick={wear.close}><Icon name="close" /></button></div>}
  </div>;
}
