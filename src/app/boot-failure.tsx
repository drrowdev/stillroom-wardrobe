import { useState } from 'react';
import { bootMessages } from '../i18n/boot';
import type { Language } from '../i18n';

// LANG1: shown when the startup catalogue could not load. Try again retries in this same document, so an in-memory
// password-recovery link captured at startup is kept; nothing is reloaded, stored or written back to the address.
export function BootFailure({ language, retry, onReady }: { language: Language; retry: () => Promise<void>; onReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const text = (key: keyof typeof bootMessages) => bootMessages[key][language];
  async function again() {
    if (busy) return;
    setBusy(true);
    try {
      await retry();
      onReady();
    } catch {
      setBusy(false);
      setFailures((value) => value + 1);
    }
  }
  return <main className="fatal-error boot-failure">
    <h1>{text('common.errorTitle')}</h1>
    <p>{text('error.unavailable')}</p>
    <button type="button" className="button button-primary" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={() => { void again(); }}>{text('common.retry')}</button>
    <p className="sr-only" role="status">{failures > 0 && !busy ? `${text('error.unavailable')}${'\u200b'.repeat(failures % 2)}` : ''}</p>
  </main>;
}