import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { avoidedRows, loadAvoidedPairs, readPair, writePair, type AvoidedRow as Row } from '../../data/suggestions';
import { locales, type Language, type Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { ComponentText, OutfitThumb } from '../outfits/outfits-screen';
import { pickerComponent } from '../outfits/use-outfits';

type Props = { client: AppClient; scope: OwnerScope; images: PrivateImages; language: Language; online: boolean; t: Translate };


export function AvoidedPairs({ client, scope, images, language, online, t }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const writes = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    writes.current?.abort();
    writes.current = controller;
    setRows(null); setLoadFailed(false); setFailed(null); setRemoving(null);
    Promise.all([loadAvoidedPairs(client, scope, controller.signal), loadWardrobe(client, scope, controller.signal)])
      .then(([pairs, items]) => { if (!controller.signal.aborted) setRows(avoidedRows(pairs, items)); })
      .catch(problem => { if (!controller.signal.aborted && !isAborted(problem)) setLoadFailed(true); });
    return () => controller.abort();
  }, [client, scope, attempt]);

  const remove = useCallback(async (pair: string) => {
    const signal = writes.current?.signal;
    if (!signal || removing || !online) return;
    setRemoving(pair); setFailed(null);
    const change = { ownerId: scope.ownerId, epoch: scope.epoch, pair, avoid: false };
    try {
      const outcome = await writePair(client, scope, change, signal);
      // A lost reply is settled by reading back what is stored.
      const gone = outcome === 'done' || outcome === 'unknown' && !await readPair(client, scope, change, signal);
      if (signal.aborted) return;
      if (gone) {
        setRows(current => current?.filter(row => row.pair !== pair) ?? current);
        heading.current?.focus();
      } else setFailed(pair);
    } catch (problem) {
      if (!signal.aborted && !isAborted(problem)) setFailed(pair);
    } finally {
      if (!signal.aborted) setRemoving(null);
    }
  }, [client, scope, online, removing]);

  const names = (row: Row) => new Intl.ListFormat(locales[language], { type: 'conjunction' })
    .format(row.items.map(item => item.title));
  return <section className="settings-card" aria-labelledby="avoided-pairs-heading">
    <h2 id="avoided-pairs-heading" ref={heading} tabIndex={-1}>{t('pairs.title')}</h2>
    {loadFailed ? <div className="notice notice-error" role="alert"><span>{t('pairs.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online} onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></div>
      : !rows ? <p role="status">{t('common.loading')}</p>
      : rows.length === 0 ? <p className="muted">{t('pairs.empty')}</p>
      : <ul className="avoided-pairs">
        {rows.map(row => <li key={row.pair} className="avoided-pair">
          <ul className="avoided-pair-items">
            {row.items.map(item => {
              const component = pickerComponent(item);
              return <li key={item.id} className="outfit-component"><OutfitThumb component={component} images={images} t={t} /><ComponentText component={component} t={t} /></li>;
            })}
          </ul>
          {failed === row.pair && <p className="notice notice-error" role="alert">{t('pairs.removeFailed')}</p>}
          <button type="button" className="button button-secondary" disabled={!online || removing !== null} aria-busy={removing === row.pair || undefined}
            aria-label={t('pairs.removeLabel', { items: names(row) })} onClick={() => { void remove(row.pair); }}>{t('pairs.remove')}</button>
        </li>)}
      </ul>}
  </section>;
}
