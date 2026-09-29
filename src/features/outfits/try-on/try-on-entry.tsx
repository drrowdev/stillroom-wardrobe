import { useCallback, useState } from 'react';
import type { OwnerScope } from '../../../auth/session';
import type { AppClient } from '../../../data/client';
import { tryOnReady } from '../../../data/tryon';
import type { OutfitComponent, OutfitRecord } from '../../../domain/outfits';
import type { Language, Translate } from '../../../i18n';
import '../../../i18n/tryon';
import { tryOnStoreFor } from '../../settings/tryon-store';
import { tryOnSelection, useOutfitTryOns, useTryOnStatus } from '../use-try-on';
import { TryOnPicture } from './try-on-parts';

/** Outfit detail: Try on (only when try-on is on and a garment can be tried on) and this outfit's saved try-ons. */
export function TryOnButton({ client, scope, record, components, disabled, t, onTryOn }: {
  client: AppClient; scope: OwnerScope; record: OutfitRecord; components: ReadonlyMap<string, OutfitComponent>; disabled: boolean;
  t: Translate; onTryOn: () => void;
}) {
  const store = tryOnStoreFor(client, scope);
  const status = useTryOnStatus(store);
  if (!tryOnReady(status) || !tryOnSelection(record, components).steps.length) return null;
  return <button id="tryon-open" type="button" className="button button-secondary" disabled={disabled} onClick={onTryOn}>{t('tryon.open')}</button>;
}

export function SavedTryOns({ client, scope, outfitId, online, language, t }: {
  client: AppClient; scope: OwnerScope; outfitId: string; online: boolean; language: Language; t: Translate;
}) {
  const store = tryOnStoreFor(client, scope);
  const status = useTryOnStatus(store);
  const { state, retry } = useOutfitTryOns(store?.api ?? null, outfitId, status !== null && status.results > 0);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  // Idempotent: reporting the same removal again changes nothing and renders nothing.
  const remove = useCallback((id: string) => setRemoved(current => current.has(id) ? current : new Set(current).add(id)), []);
  if (!store) return null;
  if (state.kind === 'failed') {
    return <section className="tryon-saved stack" aria-labelledby="tryon-saved-title">
      <h2 id="tryon-saved-title">{t('tryon.saved')}</h2>
      <div className="notice notice-error" role="alert"><span>{t('tryon.savedFailed')}</span>
        <button id="tryon-saved-retry" type="button" className="text-button" disabled={!online} onClick={retry}>{t('common.retry')}</button></div>
    </section>;
  }
  if (state.kind !== 'ready' || !state.results.length) return null;
  const shown = state.results.filter(result => !removed.has(result.id));
  return <section className="tryon-saved stack" aria-labelledby="tryon-saved-title">
    <h2 id="tryon-saved-title">{t('tryon.saved')}</h2>
    {removed.size > 0 && <p role="status">{t('tryon.deleted')}</p>}
    {shown.length > 0 && <ul className="tryon-saved-list">
      {shown.map(result => <li key={result.id}>
        <TryOnPicture api={store.api} result={result} language={language} t={t} online={online} idPrefix={`tryon-${result.id}`}
          onDeleted={() => remove(result.id)} />
      </li>)}
    </ul>}
  </section>;
}
