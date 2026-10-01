import { useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadWearHistory } from '../../data/wear-history';
import { buildStatistics, costTable, spending, type ItemStatistics, type SpendGroup, type Statistics } from '../../domain/statistics';
import { categories, categoryKeys, isCategory } from '../../domain/wardrobe';
import { formatMoney } from '../../i18n/format';
import { locales, type Language, type Translate } from '../../i18n';
import { centsPerText, centsText, costPerWearText, number, pluralKey, wearLineText } from './wear-text';
import '../../styles/data-flow.css';

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

function CostPerWear({ stats, language, t, currency }: { stats: Statistics; language: Language; t: Translate; currency: string | undefined }) {
  const rows = currency ? costTable(stats, currency) : [];
  return <section className="settings-card stats-card stats-cost" aria-labelledby="stats-cost">
    <h2 id="stats-cost">{t('stats.costPerWear')}</h2>
    {!currency ? <p>{t('stats.noPrices')}</p> : <ul className="stats-cost-list">{rows.map(row => <li key={row.id}>
      <a href={`#/items/${row.id}`}>{row.title}</a>
      <dl>
        <div><dt>{t('item.price')}</dt><dd>{row.price !== null && formatMoney(row.price, row.currency, language)}</dd></div>
        <div><dt>{t('stats.wearCount')}</dt><dd>{number(row.count, language)}</dd></div>
        <div><dt>{t('stats.costPerWear')}</dt><dd>{costText(row, language, t)}</dd></div>
      </dl>
    </li>)}</ul>}
    {stats.unpriced > 0 && <p className="stats-note">{t(pluralKey(stats.unpriced, language, 'stats.unpriced_one', 'stats.unpriced_other'), { count: number(stats.unpriced, language) })}</p>}
  </section>;
}

function SpendList({ id, title, groups, label, currency, language, t, bars }: {
  id: string; title: string; groups: SpendGroup[]; label: (key: string) => string; currency: string; language: Language; t: Translate; bars?: boolean;
}) {
  if (!groups.length) return null;
  const largest = groups.reduce((max, group) => group.cents > max ? group.cents : max, 0n);
  return <section className="stats-spend" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <ul className={bars ? 'stats-list stats-bars' : 'stats-list'}>{groups.map(group => <li key={group.key}>
      {label(group.key)}
      {bars && largest > 0n && <span className="stats-bar" aria-hidden="true"><span style={{ width: `${Number(group.cents * 1000n / largest) / 10}%` }} /></span>}
      <span className="stats-meta">{t('stats.spendLine', { amount: centsText(group.cents, currency, language),
        items: t(pluralKey(group.count, language, 'stats.itemCount_one', 'stats.itemCount_other'), { count: number(group.count, language) }) })}</span>
    </li>)}</ul>
  </section>;
}

function Spending({ stats, language, t, currency }: { stats: Statistics; language: Language; t: Translate; currency: string | undefined }) {
  const summary = currency ? spending(stats, currency, categories) : null;
  const month = (key: string) => new Intl.DateTimeFormat(locales[language], { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${key}-15T12:00:00.000Z`));
  const category = (key: string) => isCategory(key) ? t(categoryKeys[key]) : key;
  const total = stats.items.filter(row => row.active).length;
  const priced = stats.items.filter(row => row.active && row.price !== null).length;
  return <section className="settings-card stats-card stats-spending" aria-labelledby="stats-spending">
    <h2 id="stats-spending">{t('stats.spending')}</h2>
    {!currency || !summary || summary.count === 0 ? <p>{t(priced === 0 ? 'stats.spendingNoPrices' : 'stats.spendingNoPricesIn', { currency: currency ?? '' })}</p> : <>
      <dl className="stats-figures">
        <div><dt>{t('stats.averageCostPerWear')}</dt>
          <dd>{summary.wears > 0 ? centsPerText(summary.wornCents, summary.wears, currency, language) : t('stats.neverWorn')}</dd></div>
      </dl>
      <div className="stats-spend-groups">
        <SpendList id="stats-by-category" title={t('stats.byCategory')} groups={summary.byCategory} label={category} currency={currency} language={language} t={t} bars />
        <SpendList id="stats-by-month" title={t('stats.byMonth')} groups={summary.byMonth} label={month} currency={currency} language={language} t={t} />
      </div>
      {summary.undated > 0 && <p className="stats-note">{t(pluralKey(summary.undated, language, 'stats.undated_one', 'stats.undated_other'), { count: number(summary.undated, language) })}</p>}
    </>}
    {total > 0 && <p className="stats-note stats-priced">{currency && stats.currencies.length > 1
      ? t(pluralKey(total, language, 'stats.pricedIn_one', 'stats.pricedIn_other'), { priced: number(priced, language), total: number(total, language), currency })
      : t(pluralKey(total, language, 'stats.priced_one', 'stats.priced_other'), { priced: number(priced, language), total: number(total, language) })}</p>}
  </section>;
}

export function StatisticsScreen({ client, scope, online, language, t, currency }: Props) {
  const [state, setState] = useState<{ stats: Statistics | null; error: boolean }>({ stats: null, error: false });
  const [tick, setTick] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
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
  // One currency at a time for both money cards: the chosen one, else the profile currency, else the first priced one.
  const selected = !stats ? undefined : chosen !== null && stats.currencies.includes(chosen) ? chosen
    : stats.currencies.includes(currency) ? currency : stats.currencies[0];
  const worth = stats && selected ? spending(stats, selected, categories) : null;
  const picker = stats && selected && stats.currencies.length > 1 && <div className="field stats-currency"><label htmlFor="stats-currency">{t('stats.currency')}</label>
    <select id="stats-currency" value={selected} onChange={event => setChosen(event.target.value)}>
      {stats.currencies.map(code => <option key={code} value={code}>{code}</option>)}
    </select></div>;
  return <section className="statistics-page" aria-labelledby="statistics-title">
    <div className="page-heading stats-heading"><div><h1 id="statistics-title" tabIndex={-1}>{t('nav.statistics')}</h1></div>{picker}</div>
    {state.error && <div className="notice notice-error" role="alert"><span>{t('wardrobe.historyUnavailable')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={() => setTick(value => value + 1)}>{t('common.retry')}</button></div>}
    {stats && (!online || state.error) && <p role="status" className="notice">{t(online ? 'common.stale' : 'stats.offline')}</p>}
    {!stats ? !state.error && <p role="status">{t('common.loading')}</p>
      : <><dl className="stats-summary">
        <div><dt>{t('stats.worn')}</dt><dd>{number(stats.items.filter(row => row.active && row.count > 0).length, language)}</dd></div>
        <div><dt>{t('stats.neverWorn')}</dt><dd>{number(stats.unworn.length, language)}</dd></div>
        {worth && worth.count > 0 && <div><dt>{t('stats.value')}</dt><dd>{centsText(worth.cents, selected!, language)}</dd></div>}
      </dl>{!worn ? <div className="stats-layout">
          <div className="settings-card stats-card stats-empty"><p>{t('stats.empty')}</p><a className="button button-secondary" href="#/calendar">{t('nav.calendar')}</a></div>
          <Spending stats={stats} language={language} t={t} currency={selected} />
        </div>
        : <div className="stats-layout">
          <ItemList id="stats-most" title={t('stats.mostWorn')} rows={stats.mostWorn} language={language} t={t} />
          <ItemList id="stats-least" title={t('stats.leastWorn')} rows={stats.leastWorn} language={language} t={t} />
          <section className="settings-card stats-card" aria-labelledby="stats-unworn">
            <h2 id="stats-unworn">{t('stats.neverWorn')}</h2>
            {stats.unworn.length ? <ul className="stats-list">{stats.unworn.map(row => <li key={row.id}><a href={`#/items/${row.id}`}>{row.title}</a></li>)}</ul>
              : <p>{t('stats.allWorn')}</p>}
          </section>
          <Spending stats={stats} language={language} t={t} currency={selected} />
          <CostPerWear stats={stats} language={language} t={t} currency={selected} />
        </div>}</>}
  </section>;
}
