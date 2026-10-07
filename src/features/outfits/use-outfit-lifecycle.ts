import { useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { changeOutfit, checkOutfitAction } from '../../data/outfit-lifecycle';
import { undoMs } from '../../domain/item-lifecycle';
import { outfitProblems, type OutfitAction, type OutfitIntent, type OutfitOutcome } from '../../domain/outfit-lifecycle';
import type { OutfitRecord } from '../../domain/outfits';
import type { MessageKey } from '../../i18n';

type Failure = { id: string; key: MessageKey };
type Results = { done: string[]; failed: string[] };
type Notice = { records: OutfitRecord[]; expiresAt: number };

// Owner-lived, not route-lived: uncertain intents survive navigation but never an owner/epoch change.
export function useOutfitLifecycle({ client, scope, online, onChanged, onWriting }: {
  client: AppClient; scope: OwnerScope; online: boolean; onChanged: () => void; onWriting: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [unknown, setUnknown] = useState<OutfitIntent[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const running = useRef(false);
  const pending = useRef(new Map<string, OutfitIntent>());
  const connected = useRef(online); connected.current = online;
  useEffect(() => {
    const clear = () => { pending.current.clear(); running.current = false; };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope]);

  async function run(intents: OutfitIntent[], checking: boolean, undoing = false): Promise<Results> {
    const results: Results = { done: [], failed: [] };
    if (running.current || !connected.current || scope.signal.aborted || !checking && pending.current.size
      && (!undoing || intents.some(intent => pending.current.has(intent.baseline.id)))) return results;
    const affected = new Set(intents.map(intent => intent.baseline.id));
    const failed = failures.filter(failure => pending.current.has(failure.id) && !affected.has(failure.id));
    running.current = true; setBusy(true); onWriting(true); setFailures(failed);
    const undo: OutfitRecord[] = [];
    try {
      for (const intent of intents) {
        if (scope.signal.aborted) break;
        const id = intent.baseline.id;
        let reply: OutfitOutcome;
        if (!connected.current) reply = { kind: 'notSaved' };
        else {
          // Keep the exact target before sending anything. Check never resends a write.
          pending.current.set(id, intent);
          try { reply = await (checking ? checkOutfitAction(client, scope, intent) : changeOutfit(client, scope, intent)); }
          catch (problem) {
            if (isAborted(problem) || scope.signal.aborted) break;
            reply = { kind: 'unknown' };
          }
        }
        if (scope.signal.aborted) break;
        if (reply.kind !== 'unknown') pending.current.delete(id);
        if (reply.kind === 'saved') {
          results.done.push(id);
          if (intent.action === 'trash' && reply.record) undo.push(reply.record);
          if (intent.action !== 'trash') setNotice(current => current ? { ...current, records: current.records.filter(record => record.id !== id) } : null);
        } else { results.failed.push(id); failed.push({ id, key: outfitProblems[reply.kind] }); }
      }
      if (!scope.signal.aborted) {
        setFailures(failed); setUnknown([...pending.current.values()]);
        if (undo.length) setNotice({ records: undo, expiresAt: performance.now() + undoMs });
        // Refresh failures too; stale versions may only be used again after a fresh, explicit confirmation.
        onChanged();
      }
    } finally {
      if (!scope.signal.aborted) { running.current = false; setBusy(false); onWriting(false); }
    }
    return results;
  }
  function intentsFor(records: readonly OutfitRecord[], action: OutfitAction): OutfitIntent[] {
    return [...new Map(records.map(record => [record.id, {
      baseline: structuredClone(record), epoch: scope.epoch, action,
    }])).values()];
  }
  return {
    busy, locked: busy || unknown.length > 0, failures, unknown, notice, execute,
    undoBlocked: busy || unknown.some(intent => notice?.records.some(record => record.id === intent.baseline.id)),
    check: () => run([...pending.current.values()], true),
    undo: () => notice && performance.now() < notice.expiresAt
      ? run(intentsFor(notice.records, 'restore'), false, true) : Promise.resolve({ done: [], failed: [] }),
    dismiss: () => { if (!running.current) { setFailures(current => current.filter(failure => pending.current.has(failure.id))); setNotice(null); } },
  };
  function execute(records: readonly OutfitRecord[], action: OutfitAction) {
    return run(intentsFor(records, action), false);
  }
}
export type OutfitLifecycle = ReturnType<typeof useOutfitLifecycle>;
