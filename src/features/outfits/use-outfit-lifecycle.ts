import { useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { isAborted } from '../../data/errors';
import { changeOutfit, checkOutfitAction, outfitWearKey, pendingOutfitWear } from '../../data/outfit-lifecycle';
import { createLook } from '../../data/wear-events';
import { undoMs } from '../../domain/item-lifecycle';
import { outfitProblems, type OutfitAction, type OutfitIntent, type OutfitOutcome } from '../../domain/outfit-lifecycle';
import type { OutfitRecord } from '../../domain/outfits';
import type { MessageKey } from '../../i18n';

type Failure = { id: string; key: MessageKey };
type TargetResult = { id: string; outcome: OutfitOutcome | { kind: 'not-started' } };
type Results = { done: string[]; failed: string[]; outcomes: TargetResult[] };
type Notice = { records: OutfitRecord[]; expiresAt: number };

// Owner-lived, not route-lived: uncertain intents survive navigation but never an owner/epoch change.
export function useOutfitLifecycle({ client, scope, online, onChanged, onWriting }: {
  client: AppClient; scope: OwnerScope; online: boolean; onChanged: () => void; onWriting: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [unknown, setUnknown] = useState<OutfitIntent[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const running = useRef(false);
  const pending = useRef(new Map<string, OutfitIntent>());
  const connected = useRef(online); connected.current = online;
  const currentFailures = useRef(failures); currentFailures.current = failures;
  useEffect(() => {
    const clear = () => { pending.current.clear(); running.current = false; };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); clear(); };
  }, [scope]);

  async function run(intents: OutfitIntent[], checking: boolean, undoing = false): Promise<Results> {
    const results: Results = { done: [], failed: [], outcomes: intents.map(intent => ({ id: intent.baseline.id, outcome: { kind: 'not-started' } })) };
    if (running.current || !connected.current || scope.signal.aborted || !checking && pending.current.size
      && (!undoing || intents.some(intent => pending.current.has(intent.baseline.id)))) return results;
    const affected = new Set(intents.map(intent => intent.baseline.id));
    const failed = currentFailures.current.filter(failure => pending.current.has(failure.id) && !affected.has(failure.id));
    running.current = true; setBusy(true); setReading(checking); onWriting(true); setFailures(failed);
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
        results.outcomes = results.outcomes.map(result => result.id === id ? { id, outcome: reply } : result);
        if (reply.kind !== 'unknown') pending.current.delete(id);
        if (reply.kind === 'saved') {
          results.done.push(id);
          if (intent.action === 'trash' && reply.record) undo.push(reply.record);
          if (intent.action !== 'trash') setNotice(current => current ? { ...current, records: current.records.filter(record => record.id !== id) } : null);
        } else { results.failed.push(id); failed.push({ id, key: outfitProblems[reply.kind] }); }
      }
      if (!scope.signal.aborted) {
        setFailures(current => [...current.filter(failure => !affected.has(failure.id) && pending.current.has(failure.id)),
          ...failed.filter(failure => affected.has(failure.id))]); setUnknown([...pending.current.values()]);
        if (undo.length) setNotice({ records: undo, expiresAt: performance.now() + undoMs });
        // Refresh failures too; stale versions may only be used again after a fresh, explicit confirmation.
        onChanged();
      }
    } finally {
      if (!scope.signal.aborted) { running.current = false; setBusy(false); setReading(false); onWriting(false); }
    }
    return results;
  }
  function intentsFor(records: readonly OutfitRecord[], action: OutfitAction): OutfitIntent[] {
    return [...new Map(records.map(record => [record.id, {
      baseline: structuredClone(record), epoch: scope.epoch, action,
    }])).values()];
  }
  async function checkWear(id: string) {
    if (running.current || !connected.current || scope.signal.aborted) return null;
    running.current = true; setBusy(true); setReading(true); onWriting(true);
    try {
      return await createLook(client, scope, outfitWearKey(id), null, false, scope.signal);
    } finally {
      if (!scope.signal.aborted) { running.current = false; setBusy(false); setReading(false); onWriting(false); refreshWear(); }
    }
  }
  function refreshWear() {
    setFailures(current => current.filter(failure => failure.key !== 'calendar.unknown' || pendingOutfitWear(scope, failure.id)));
    onChanged();
  }
  function execute(records: readonly OutfitRecord[], action: OutfitAction) {
    return run(intentsFor(records, action), false);
  }
  return {
    busy, reading, locked: busy || unknown.length > 0, failures, unknown, notice, execute,
    pendingWear: (id: string) => pendingOutfitWear(scope, id), checkWear, refresh: refreshWear,
    undoBlocked: busy || unknown.some(intent => notice?.records.some(record => record.id === intent.baseline.id)),
    check: () => run([...pending.current.values()], true),
    undo: () => notice && performance.now() < notice.expiresAt
      ? run(intentsFor(notice.records, 'restore'), false, true) : Promise.resolve<Results>({ done: [], failed: [], outcomes: [] }),
    dismiss: () => { if (!running.current) { setFailures(current => current.filter(failure => pending.current.has(failure.id))); setNotice(null); } },
  };
}
export type OutfitLifecycle = ReturnType<typeof useOutfitLifecycle>;
