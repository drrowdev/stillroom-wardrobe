export type Transfer = Map<string, number>;

export type StartupTransfer = { total: number; expected: number; extra: { pathname: string; bytes: number }[] };

// The transfer budget counts every page transfer observed in the measurement window, including dynamic imports and
// prefetches. The expected set is only checked for presence; an absent expected asset is an error, not zero bytes.
export function startupTransfer(transfer: Transfer, expectedInitial: readonly string[]): StartupTransfer {
  const missing = expectedInitial.filter((pathname) => !((transfer.get(pathname) ?? 0) > 0));
  if (missing.length > 0) throw new Error(`expected startup assets not transferred: ${missing.join(', ')}`);
  for (const [pathname, bytes] of transfer) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error(`invalid transfer size for ${pathname}: ${bytes}`);
  }
  const expectedSet = new Set(expectedInitial);
  const expected = expectedInitial.reduce((sum, pathname) => sum + transfer.get(pathname)!, 0);
  const extra = [...transfer].filter(([pathname]) => !expectedSet.has(pathname)).map(([pathname, bytes]) => ({ pathname, bytes }));
  return { total: [...transfer.values()].reduce((sum, bytes) => sum + bytes, 0), expected, extra };
}
