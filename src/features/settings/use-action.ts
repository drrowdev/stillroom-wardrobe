import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { errorKey } from '../../data/errors';
import type { MessageKey } from '../../i18n';

export function useAction(scope: OwnerScope, online: boolean, outer?: () => AbortSignal) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const lifetime = useRef(new AbortController());
  const latch = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); latch.current = false; };
  }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error, busy]);
  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (latch.current || !online || scope.signal.aborted) return;
    const mounted = lifetime.current.signal;
    const signal = AbortSignal.any([scope.signal, mounted, ...(outer ? [outer()] : [])]);
    latch.current = true; setBusy(true); setError(null);
    try { await operation(signal); }
    catch (problem) { if (!scope.signal.aborted && !mounted.aborted) setError(errorKey(problem)); }
    finally { if (!scope.signal.aborted && !mounted.aborted) { latch.current = false; setBusy(false); } }
  }, [scope, online, outer]);
  return { busy, error, alert, run };
}
