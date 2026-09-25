import { useEffect, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { ItemLifecycleClient, LifecycleError } from '../../data/item-lifecycle';
import type { LifecycleSnapshot, TrashIntent, UndoItem } from '../../domain/item-lifecycle';
import type { ItemBaseline, ImageBaseline } from '../../domain/item-details';
import type { Translate } from '../../i18n';
import type { PrivateImages } from '../../images/private-images';
import { useAction } from './use-action';

export type Shared = { lifecycle: ItemLifecycleClient; scope: OwnerScope; online: boolean; t: Translate; images: PrivateImages };
export function Failure({ action, t }: { action: ReturnType<typeof useAction>; t: Translate }) {
  return action.error && <div className="notice notice-error" role="alert" tabIndex={-1} ref={action.alert}>{t(action.error)}</div>;
}
export function TrashAction(props: Shared & {
  item: ItemBaseline; image: ImageBaseline; blocked: boolean; onState: (busy: boolean, pending: boolean) => void;
  onTrashed: (item: LifecycleSnapshot) => void;
}) {
  const { lifecycle, scope, online, t, images, onState } = props;
  const action = useAction(scope, online);
  const [intent, setIntent] = useState<TrashIntent | null>(null);
  useEffect(() => { onState(action.busy, intent !== null); return () => onState(false, false); }, [action.busy, intent, onState]);
  function confirmed(item: LifecycleSnapshot) {
    images.invalidate([props.image.mainPath, props.image.thumbPath]);
    setIntent(null); onState(false, false); props.onTrashed(item);
  }
  return <section className="settings-card lifecycle-actions" aria-label={t('item.trash')}>
    <Failure action={action} t={t} />
    {intent ? <button type="button" className="button button-secondary" disabled={action.busy || !online}
      onClick={() => { void action.run(async signal => { const row = await lifecycle.checkChange(intent, signal); if (!signal.aborted) confirmed(row); }); }}>{t('lifecycle.check')}</button>
      : <button type="button" className="button button-secondary" disabled={props.blocked || action.busy || !online}
        onClick={() => {
          if (props.blocked) return;
          void action.run(async signal => {
            onState(true, false);
            try {
              const row = await lifecycle.change(props.item.id, true, props.item.version, setIntent, signal, { item: props.item, image: props.image });
              if (!signal.aborted) confirmed(row);
            } catch (problem) {
              if (!signal.aborted && problem instanceof LifecycleError && !problem.uncertain) setIntent(null);
              throw problem;
            }
          });
        }}>{t('item.trash')}</button>}
  </section>;
}
export function UndoNotice({ undo, visible, routeSignal, ...props }: Shared & { undo: UndoItem; visible: boolean; routeSignal: () => AbortSignal; onRestored: () => void }) {
  const { t, lifecycle, scope, online } = props;
  const action = useAction(scope, online, routeSignal);
  const [expired, setExpired] = useState(() => performance.now() >= undo.expiresAt);
  const [intent, setIntent] = useState<TrashIntent | null>(null);
  useEffect(() => {
    const update = () => {
      if (performance.now() >= undo.expiresAt) {
        if (document.activeElement?.id === 'lifecycle-undo') document.getElementById('wardrobe-title')?.focus();
        setExpired(true);
      }
    };
    const timer = setTimeout(update, Math.max(0, undo.expiresAt - performance.now()));
    window.addEventListener('focus', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [undo]);
  return <div className="notice lifecycle-undo" hidden={!visible}>
    <p role="status">{t('item.trashed')}</p><Failure action={action} t={t} />
    {intent ? <button className="text-button" disabled={action.busy || !online} onClick={() => { void action.run(async signal => {
      await lifecycle.checkChange(intent, signal); if (!signal.aborted) props.onRestored();
    }); }}>{t('lifecycle.check')}</button> : !expired && <button id="lifecycle-undo" className="text-button" disabled={action.busy || !online}
      onClick={() => {
        if (performance.now() >= undo.expiresAt) { setExpired(true); return; }
        void action.run(async signal => {
          try {
            await lifecycle.change(undo.item.id, false, undo.item.version, setIntent, signal);
            if (!signal.aborted) props.onRestored();
          } catch (problem) {
            if (!scope.signal.aborted && problem instanceof LifecycleError && !problem.uncertain) setIntent(null);
            throw problem;
          }
        });
      }}>{t('common.undo')}</button>}
    <a className="text-button" href="#/trash">{t('nav.trash')}</a>
  </div>;
}
