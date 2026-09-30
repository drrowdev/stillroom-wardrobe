import { useCallback, useEffect, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { AiClient } from '../../data/ai';
import type { OwnerScope, SessionController } from '../../auth/session';
import type { ProfileRow } from '../../data/rows';
import type { AiStatus } from '../../domain/ai-controls';
import { usdCents } from '../../domain/ai-presentation';
import type { Language, Translate } from '../../i18n';
import { AdminEntry } from '../admin/admin-entry';
import type { StylistStore } from '../stylist/stylist-store';
import { AiSettings } from './ai-settings';
import { EnhanceSettings } from './enhance-settings';
import { enhanceStoreFor, type EnhanceStore } from './enhance-store';
import { StylistSettings } from './stylist-settings';
import { TryOnSettings } from './tryon-settings';
import { tryOnStoreFor, type TryOnStore } from './tryon-store';
import {
  analysisFigures, sharedFigures, spendPercent, SpendTracker, type SpendSnapshot, type SpendSource,
} from './ai-features-model';

type Props = { client: AppClient; ai: AiClient; controller: SessionController; scope: OwnerScope; profile: ProfileRow;
  stylist: StylistStore; busy: boolean; unresolved: boolean; language: Language; online: boolean; t: Translate };

/** The AI features card: the shared spending summary, the admin entry and one row per feature. */
export function AiFeatures({ client, ai, controller, scope, profile, stylist, busy, unresolved, language, online, t }: Props) {
  const enhance = enhanceStoreFor(client, scope), tryOn = tryOnStoreFor(client, scope);
  const spend = useSpend(scope, stylist, enhance, tryOn);
  return <div className="settings-group-card ai-features">
    <div className="ai-spend-header">
      {spend.snapshot && <SpendSummary snapshot={spend.snapshot} language={language} t={t} />}
      <AdminEntry client={client} scope={scope} t={t} />
    </div>
    <AiSettings ai={ai} controller={controller} scope={scope} profile={profile} busy={busy} unresolved={unresolved}
      language={language} online={online} t={t} onSpend={spend.analysis} />
    <EnhanceSettings store={enhance} busy={busy} language={language} online={online} t={t} />
    <TryOnSettings store={tryOn} busy={busy} language={language} online={online} t={t} />
    <StylistSettings store={stylist} busy={busy} language={language} online={online} t={t} />
  </div>;
}

type SharedStatus = Parameters<typeof sharedFigures>[0];
type StatusStore<S extends SharedStatus> = { subscribe: (listener: () => void) => () => void; get: () => { read: { kind: string; status?: S } } };
const readyStatus = <S,>(read: { kind: string; status?: S }): S | null => read.kind === 'ready' && read.status ? read.status : null;

/**
 * Mount-fresh spending: statuses already in the stores when Settings opens are never shown; each store's first new
 * reply, and the analysis card's, is stamped with `performance.now()` when it arrives. One timer (at most a day)
 * re-checks the month boundary, and so does returning to the page.
 */
function useSpend(scope: OwnerScope, stylist: StylistStore, enhance: EnhanceStore | null, tryOn: TryOnStore | null) {
  const [tracker] = useState(() => new SpendTracker(scope.epoch, {
    stylist: readyStatus(stylist.get().read), enhance: enhance ? readyStatus(enhance.get().read) : null,
    tryOn: tryOn ? readyStatus(tryOn.get().read) : null, analysis: null,
  }));
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((tick) => tick + 1), []);
  useEffect(() => {
    const watch = <S extends SharedStatus>(source: SpendSource, store: StatusStore<S> | null) => {
      if (!store) return () => undefined;
      const check = () => {
        const status = readyStatus(store.get().read);
        if (tracker.observe(source, scope.epoch, status, status ? sharedFigures(status) : null, performance.now())) bump();
      };
      check();
      return store.subscribe(check);
    };
    const stops = [watch('stylist', stylist), watch('enhance', enhance), watch('tryOn', tryOn)];
    return () => { for (const stop of stops) stop(); };
  }, [tracker, scope, stylist, enhance, tryOn, bump]);
  const analysis = useCallback((status: AiStatus | null, loadFailed: boolean) => {
    const current = loadFailed ? null : status;
    if (tracker.observe('analysis', scope.epoch, current, current ? analysisFigures(current) : null, performance.now())) bump();
  }, [tracker, scope, bump]);
  useEffect(() => {
    const delay = tracker.nextCheckDelay(performance.now(), Date.now());
    if (delay === null) return;
    const timer = setTimeout(bump, delay);
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [bump]);
  return { snapshot: tracker.snapshot(performance.now(), Date.now()), analysis };
}

function SpendSummary({ snapshot, language, t }: { snapshot: SpendSnapshot; language: Language; t: Translate }) {
  const used = usdCents(snapshot.usedMicro, language, 'used'), limit = usdCents(snapshot.limitMicro, language, 'limit');
  return <div className="ai-spend">
    <p className="ai-spend-label">{t('aiF.spending')}</p>
    <p className="ai-spend-figure">{t('aiF.spent', { used, limit })}</p>
    <div className="ai-spend-bar" aria-hidden="true"><span style={{ inlineSize: `${spendPercent(snapshot.usedMicro, snapshot.limitMicro)}%` }} /></div>
    {snapshot.warning && <p className="notice">{t('aiC.warning')}</p>}
  </div>;
}

