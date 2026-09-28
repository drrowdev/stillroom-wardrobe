// BG2b-2: the enhancement stage for one photo form (Add item or Replace photo). It never commits a photo or starts an
// analysis itself; the form commits the stage result once per preparation. In memory only.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { EnhanceLine } from '../../domain/enhance-controls';
import type { PreparedPhoto } from '../../images/process-jpeg';
import type { StageResult } from './enhancement-stage';

export type EnhancementView = {
  /** A request has been sent and its result is awaited: "Enhancing photo…" with Skip. */ working: boolean;
  /** The committed photo is the enhanced one. */ enhanced: boolean;
  line: EnhanceLine;
};
const idle: EnhancementView = { working: false, enhanced: false, line: 'none' };
const skipped: StageResult = { kind: 'skipped', line: 'none', requestId: null };

export function useEnhancement(client: AppClient, scope: OwnerScope, onExpired: () => void) {
  const [view, setView] = useState<EnhancementView>(idle);
  const token = useRef(0);
  const skipper = useRef<AbortController | null>(null);
  // H1 of the committed enhanced photo, for "Use photo without enhancement" and for expiry.
  const original = useRef<PreparedPhoto | null>(null);
  const expireAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frozen = useRef(false);
  const expired = useRef(onExpired);
  useEffect(() => { expired.current = onExpired; }, [onExpired]);
  const disarm = useCallback(() => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }, []);
  const arm = useCallback(() => {
    disarm();
    const at = expireAt.current;
    if (at === null || frozen.current || scope.signal.aborted) return;
    // The deadline is on the monotonic clock (A4); wall-clock changes after receipt don't move it.
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!frozen.current && !scope.signal.aborted && original.current && performance.now() >= at) expired.current();
      else if (!frozen.current) arm();
    }, Math.max(0, at - performance.now()));
  }, [disarm, scope]);
  const clear = useCallback(() => {
    token.current++;
    skipper.current?.abort();
    skipper.current = null;
    disarm();
    original.current = null;
    expireAt.current = null;
    frozen.current = false;
    if (!scope.signal.aborted) setView(idle);
  }, [disarm, scope]);
  useEffect(() => {
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope, clear]);

  /** Runs the stage for a settled photo. The caller checks its own token again before committing the result. */
  const run = useCallback(async (photo: PreparedPhoto, options: { cutOut: boolean; online: boolean; signal: AbortSignal;
    current: () => boolean }): Promise<StageResult> => {
    const mine = ++token.current;
    skipper.current?.abort();
    const skip = new AbortController();
    skipper.current = skip;
    if (!options.cutOut) return skipped;
    const current = () => token.current === mine && options.current() && !scope.signal.aborted;
    try {
      // The stage, its store and the imaging runtime load on first use, outside the sign-in shell's initial bundle.
      const [runtime, stage, stores] = await Promise.all([
        import('./enhancement-runtime'), import('./enhancement-stage'), import('../settings/enhance-store'),
      ]);
      const store = stores.enhanceStoreFor(client, scope);
      if (!store) return skipped;
      if (!current() || options.signal.aborted) return { kind: 'aborted' };
      return await stage.runEnhancementStage({ photo, cutOut: options.cutOut, online: options.online, current, signal: options.signal,
        skip: skip.signal }, { client: store.api, session: store.session, imaging: runtime.browserStageImaging,
        admit: runtime.admitProviderJpeg, compare: runtime.compareEnhancement,
        onDispatch: () => { if (current()) setView((value) => ({ ...value, working: true })); } });
    } catch {
      return current() ? { kind: 'skipped', line: 'generic', requestId: null } : { kind: 'aborted' };
    } finally {
      if (token.current === mine) {
        skipper.current = null;
        if (!scope.signal.aborted) setView((value) => ({ ...value, working: false }));
      }
    }
  }, [client, scope]);

  return {
    view,
    run,
    /** Stops waiting for the result and keeps the photo as it is. The request may still finish and is accounted. */
    skip: () => skipper.current?.abort(),
    /** Records what the form committed for a finished (non-aborted) stage. */
    commit: (result: Exclude<StageResult, { kind: 'aborted' }>, h1: PreparedPhoto) => {
      disarm();
      frozen.current = false;
      if (result.kind === 'enhanced') {
        original.current = h1;
        expireAt.current = result.expireAt;
        setView({ working: false, enhanced: true, line: 'none' });
        arm();
      } else {
        original.current = null;
        expireAt.current = null;
        setView({ working: false, enhanced: false, line: result.line });
      }
    },
    /** "Use photo without enhancement" or expiry: H1 back, for one new analysis. Null when there is nothing to revert. */
    revert: (line: EnhanceLine = 'none'): PreparedPhoto | null => {
      const h1 = original.current;
      if (!h1 || frozen.current) return null;
      token.current++;
      disarm();
      original.current = null;
      expireAt.current = null;
      setView({ working: false, enhanced: false, line });
      return h1;
    },
    /** A Save attempt exists: the photo is frozen with H2 and never replaced or re-analysed under it. */
    freeze: () => { frozen.current = true; disarm(); },
    /** The attempt was cleared without a reservation: an unreserved draft again, so the expiry applies again. */
    thaw: () => { frozen.current = false; if (original.current) arm(); },
    /** The committed photo's evidence has already passed its local deadline. */
    lapsed: () => expireAt.current !== null && performance.now() >= expireAt.current,
    clear,
  };
}
