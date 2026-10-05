import { useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import { LifecycleError, type ItemLifecycleClient } from '../../data/item-lifecycle';
import { runBatch, type BatchSteps, type BatchTarget } from '../../domain/bulk-trash';
import { undoMs, type LifecycleSnapshot } from '../../domain/item-lifecycle';
import type { PrivateImages } from '../../images/private-images';
import type { WardrobeBrowse } from './use-wardrobe-browse';

export type BulkNotice =
  | { kind: 'trashed'; items: readonly LifecycleSnapshot[]; count: number; expiresAt: number }
  | { kind: 'restoreFailed'; count: number };
type Options = {
  lifecycle: ItemLifecycleClient; scope: OwnerScope; browse: WardrobeBrowse; images: PrivateImages; online: boolean;
  onChanged: () => void; onNotice: () => void;
};

function steps(lifecycle: ItemLifecycleClient, trashed: boolean): BatchSteps {
  return {
    change: (target, prepared) => lifecycle.change(target.id, trashed, target.version, prepared),
    check: intent => lifecycle.checkChange(intent),
    uncertain: problem => problem instanceof LifecycleError && problem.uncertain,
  };
}

// A disabled or removed control drops focus to the page; on the Wardrobe it goes back to the heading.
function refocus() {
  requestAnimationFrame(() => {
    if (!document.activeElement || document.activeElement === document.body) document.getElementById('wardrobe-title')?.focus();
  });
}

// Lives in OwnedWardrobe, not the screen: leaving the Wardrobe doesn't stop a batch. Only the owner scope does, and
// then the whole component (and every result) goes with it.
export function useBulkTrash({ lifecycle, scope, browse, images, online, onChanged, onNotice }: Options) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<'trash' | 'restore' | null>(null);
  const [failed, setFailed] = useState(0);
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  const running = useRef(false);
  if (!busy && selected.size) {
    const visible = new Set(browse.visible.map(item => item.id));
    if ([...selected].some(id => !visible.has(id))) setSelected(new Set([...selected].filter(id => visible.has(id))));
  }
  function start(kind: 'trash' | 'restore'): boolean {
    if (running.current || !online || scope.signal.aborted) return false;
    running.current = true; setBusy(kind);
    return true;
  }
  function finish() {
    if (scope.signal.aborted) return;
    running.current = false; setBusy(null);
  }
  function trash() {
    // Frozen before the first await: later filter, search or selection changes can't add, drop or shift targets.
    const targets = browse.visible.filter(item => selected.has(item.id))
      .map(item => ({ id: item.id, version: item.version, paths: [item.mainPath, item.thumbPath] }));
    if (!targets.length || !start('trash')) return;
    setFailed(0);
    void (async () => {
      try {
        const result = await runBatch(targets.map(({ id, version }): BatchTarget => ({ id, version })), steps(lifecycle, true), scope.signal);
        if (scope.signal.aborted) return;
        for (const row of result.done) {
          browse.remove(row.id);
          images.invalidate(targets.find(target => target.id === row.id)!.paths);
        }
        setSelected(new Set(result.failed));
        setFailed(result.failed.length);
        if (!result.failed.length) setSelecting(false);
        if (result.done.length) {
          setNotice({ kind: 'trashed', items: result.done, count: result.done.length, expiresAt: performance.now() + undoMs });
          onNotice();
        }
        if (result.done.length || result.unconfirmed.length) onChanged();
        refocus();
      } finally { finish(); }
    })();
  }
  function restore() {
    if (notice?.kind !== 'trashed' || performance.now() >= notice.expiresAt || !start('restore')) return;
    const items = notice.items;
    void (async () => {
      try {
        const result = await runBatch(items.map(({ id, version }) => ({ id, version })), steps(lifecycle, false), scope.signal);
        if (scope.signal.aborted) return;
        setNotice(result.failed.length ? { kind: 'restoreFailed', count: result.failed.length } : null);
        onChanged();
        refocus();
      } finally { finish(); }
    })();
  }
  return {
    selecting, selected, busy, failed, notice,
    toggleSelecting() {
      if (running.current) return;
      setSelecting(value => !value); setSelected(new Set()); setFailed(0);
    },
    cancel() {
      if (running.current) return;
      setSelecting(false); setSelected(new Set()); setFailed(0);
    },
    toggle(id: string) {
      if (running.current) return;
      setSelected(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
    },
    trash, restore,
    clearNotice() { setNotice(null); },
    // Trash is deleting this item for good, so Undo can no longer restore it.
    forget(id: string) {
      setNotice(current => {
        if (current?.kind !== 'trashed') return current;
        const items = current.items.filter(item => item.id !== id);
        return items.length ? { ...current, items } : null;
      });
    },
  };
}
export type BulkTrash = ReturnType<typeof useBulkTrash>;
