import { useCallback, useState } from 'react';

/**
 * The consent sheet's open state. It closes without writing when Turn on is no longer permitted, or when the notice it
 * shows (`bindKey`) changes under it, unless a write is running; the caller closes it when the write settles.
 */
export function useConsentSheet(permitted: boolean, writing: boolean, bindKey: string | null = null) {
  const [openKey, setOpenKey] = useState<{ key: string | null } | null>(null);
  if (openKey && !writing && (!permitted || openKey.key !== bindKey)) setOpenKey(null);
  const show = useCallback(() => setOpenKey({ key: bindKey }), [bindKey]);
  const close = useCallback(() => setOpenKey(null), []);
  return { open: openKey !== null, show, close };
}
