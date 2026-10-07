import { useEffect, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { outfitRecoveryDays, recoverableOutfit } from '../../domain/outfit-lifecycle';
import type { OutfitRecord } from '../../domain/outfits';
import { pluralText, type Language, type Translate } from '../../i18n';
import { OutfitLifecycleDialog } from '../outfits/lifecycle-controls';
import type { OutfitLifecycle } from '../outfits/use-outfit-lifecycle';
import { useOutfitTrash } from '../outfits/use-outfits';

export function OutfitTrash({ client, scope, online, invalidation, lifecycle, disabled, language, t }: {
  client: AppClient; scope: OwnerScope; online: boolean; invalidation: number; lifecycle: OutfitLifecycle; disabled: boolean; language: Language; t: Translate;
}) {
  const list = useOutfitTrash(client, scope, online, invalidation);
  const [confirmation, setConfirmation] = useState<OutfitRecord | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 30000); window.addEventListener('focus', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); };
  }, []);
  const locked = disabled || lifecycle.locked || list.loading || !!list.error || !online;
  return <section aria-labelledby="outfit-trash-title" className="outfit-trash">
    <h2 id="outfit-trash-title">{t('nav.outfits')}</h2>
    {list.error && <div className="notice notice-error" role="alert"><span>{t('outfits.loadFailed')}</span>
      <button type="button" className="text-button" disabled={!online || lifecycle.busy} onClick={list.reload}>{t('common.retry')}</button></div>}
    {!list.data && !list.error && <p role="status">{t('common.loading')}</p>}
    {list.data && !list.data.length && <p>{t('outfitTrash.empty')}</p>}
    <ul className="trash-list">{list.data?.map(record => <li key={record.id} className="settings-card">
      <h3><a href={`#/outfits/${record.id}`}>{record.title}</a></h3>
      {recoverableOutfit(record, now) && <p className="muted">{pluralText(language, 'outfitTrash.days', outfitRecoveryDays(record, now))}</p>}
      <div className="settings-actions">
        {recoverableOutfit(record, now) ? <button type="button" className="button button-primary" disabled={locked}
          onClick={() => { void lifecycle.execute([record], 'restore'); }}>{t('trash.restore')}</button>
          : <p className="muted">{t('outfitTrash.expired')}</p>}
        <button type="button" className="text-button trash-delete" disabled={locked}
          onClick={event => { event.currentTarget.focus(); setConfirmation(structuredClone(record)); }}>{t('lifecycle.delete')}</button>
      </div>
    </li>)}</ul>
    {confirmation && <OutfitLifecycleDialog title={t('outfitTrash.deleteName', { name: confirmation.title })}
      body={t('outfitTrash.deleteBody')} action={t('lifecycle.delete')} lifecycle={lifecycle} online={online} t={t}
      onCancel={() => setConfirmation(null)} onConfirm={() => { void lifecycle.execute([confirmation], 'delete').then(result => {
        if (!scope.signal.aborted && (result.done.length || result.failed.length)) { setConfirmation(null); document.getElementById('trash-title')?.focus(); }
      }); }} />}
  </section>;
}
