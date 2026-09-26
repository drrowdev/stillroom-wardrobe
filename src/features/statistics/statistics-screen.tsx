import { useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadWearHistory } from '../../data/wear-history';
import { buildStatistics, costTable, type ItemStatistics, type Statistics } from '../../domain/statistics';
import { formatMoney } from '../../i18n/format';
import type { Language, Translate } from '../../i18n';
import { costPerWearText, number, pluralKey, wearLineText } from './wear-text';

type Props = { client: AppClient; scope: OwnerScope; online: boolean; language: Language; t: Translate; currency: string };

// A cost per wear in the item's own currency.
function costText(row: ItemStatistics, language: Language, t: Translate): string {
  if (row.price === null) return t('stats.unavailable');
  if (row.costPerWear === null) return t('stats.neverWorn');
  return costPerWearText(row.price, row.count, row.currency, language);
}

function ItemList({ id, title, rows, language, t }: { id: string; title: string; rows: ItemStatistics[]; language: Language; t: Translate }) {
  if (!rows.length) return null;
  return <section className="settings-card stats-card" aria-labelledby={id}>
    <h2 id={id}>{title}</h2>
    <ol className="stats-list">{rows.map(row => <li key={row.id}>
      <a href={`#/items/${row.id}`}>{row.title}</a>
      <span className="stats-meta">{wearLineText(row.count, row.lastWorn, language, t)}</span>
    </li>)}</ol>
  </section>;
}

function CostPerWear({ stats, language, t, preferred }: { stats: Statistics; language: Language; t: Translate; preferred: string }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const currency = chosen !== null && stats.currencies.includes(chosen) ? chosen
    : stats.currencies.includes(preferred) ? preferred : stats.currencies[0];
  const rows = currency ? costTable(stats, currency) : [];
  return <section className="settings-card stats-card stats-cost" aria-labelledby="stats-cost">
    <h2 id="stats-cost">{t('stats.costPerWear')}</h2>
    {!currency ? <p>{t('stats.noPrices')}</p> : <>
      {stats.currencies.length > 1 && <div className="field stats-currency"><label htmlFor="stats-currency">{t('stats.currency')}</label>
        <select id="stats-currency" value={currency} onChange={event => setChosen(event.target.value)}>
          {stats.currencies.map(code => <option key={code} value={code}>{code}</option>)}
        </select></div>}
      {/* Explicit roles keep the table semantics when narrow screens stack the cells. */}
      <table className="stats-table" role="table">
        <caption className="sr-only">{t('stats.costCaption', { currency })}</caption>
        <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">{t('stats.item')}</th><th scope="col" role="columnheader">{t('item.price')}</th>
          <th scope="col" role="columnheader">{t('stats.wearCount')}</th><th scope="col" role="columnheader">{t('stats.costPerWear')}</th></tr></thead>
        <tbody role="rowgroup">{rows.map(row => <tr key={row.id} role="row">
          <th scope="row" role="rowheader"><a href={`#/items/${row.id}`}>{row.title}</a></th>
          <td role="cell" data-label={t('item.price')}>{row.price !== null && formatMoney(row.price, row.currency, language)}</td>
          <td role="cell" data-label={t('stats.wearCount')}>{number(row.count, language)}</td>
          <td role="cell" data-label={t('stats.costPerWear')}>{costText(row, language, t)}</td>
        </tr>)}</tbody>
      </table>
    </>}
    {stats.unpriced > 0 && <p className="stats-note">{t(pluralKey(stats.unpriced, language, 'stats.unpriced_one', 'stats.unpriced_other'), { count: number(stats.unpriced, language) })}</p>}
  </section>;
}

export function StatisticsScreen({ client, scope, online, language, t, currency }: Props) {
  const [state, setState] = useState<{ stats: Statistics | null; error: boolean }>({ stats: null, error: false });
  const [tick, setTick] = useState(0);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) setTick(value => value + 1);
    wasOnline.current = online;
  }, [online]);
  useEffect(() => {
    const controller = new AbortController();
    setState(current => ({ ...current, error: false }));
    void (async () => {
      const items = await loadWardrobe(client, scope, controller.signal);
      const history = await loadWearHistory(client, scope, items, controller.signal);
      return buildStatistics(items, history.items);
    })().then(stats => { if (!controller.signal.aborted) setState({ stats, error: false }); },
      (problem: unknown) => { if (!controller.signal.aborted && !isAborted(problem)) setState(current => ({ ...current, error: true })); });
    return () => controller.abort();
  }, [client, scope, tick]);
  const stats = state.stats;
  const worn = stats?.items.some(row => row.count > 0) ?? false;
  return <section className="statistics-page" aria-labelledby="statistics-title">
    <div className="page-heading"><div><h1 id="statistics-title" tabIndex={-1}>{t('nav.statistics')}</h1></div></div>
    {state.error && <div className="notice notice-error" role="alert"><span>{t('wardrobe.historyUnavailable')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={() => setTick(value => value + 1)}>{t('common.retry')}</button></div>}
    {stats && (!online || state.error) && <p role="status" className="notice">{t(online ? 'common.stale' : 'stats.offline')}</p>}
    {!stats ? !state.error && <p role="status">{t('common.loading')}</p>
      : !worn ? <div className="settings-card stats-card stats-empty"><p>{t('stats.empty')}</p><a className="button button-secondary" href="#/calendar">{t('nav.calendar')}</a></div>
        : <div className="stats-layout">
          <ItemList id="stats-most" title={t('stats.mostWorn')} rows={stats.mostWorn} language={language} t={t} />
          <ItemList id="stats-least" title={t('stats.leastWorn')} rows={stats.leastWorn} language={language} t={t} />
          <section className="settings-card stats-card" aria-labelledby="stats-unworn">
            <h2 id="stats-unworn">{t('stats.neverWorn')}</h2>
            {stats.unworn.length ? <ul className="stats-list">{stats.unworn.map(row => <li key={row.id}><a href={`#/items/${row.id}`}>{row.title}</a></li>)}</ul>
              : <p>{t('stats.allWorn')}</p>}
          </section>
          <CostPerWear stats={stats} language={language} t={t} preferred={currency} />
        </div>}
  </section>;
}
