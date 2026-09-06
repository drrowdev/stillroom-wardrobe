import { authStorageKey } from '../data/client';
import { isRecord, isUuid } from '../domain/wardrobe';
import type { MessageKey } from '../i18n';

export type RecoveryLink = { accessToken: string; refreshToken: string; subject: string; expiresAt: number };
export type RecoveryCallback = { kind: 'none' | 'invalid' | 'conflict'; notice?: MessageKey } | { kind: 'link'; link: RecoveryLink };
const margin = 150_000;
const callbackKeys = new Set([
  'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'code', 'token', 'token_hash',
  'code_verifier', 'code_challenge', 'code_challenge_method', 'type', 'token_type', 'expires_in', 'expires_at',
  'error', 'error_code', 'error_description', 'error_uri', 'sb',
]);
function hasCallbackKeys(parameters: string): boolean {
  // Decoded key delimiters also detect unsupported route-query/encoded forms, never accept them.
  return [...new URLSearchParams(parameters).keys()].some(key => key.split(/[?&=]/).some(part => callbackKeys.has(part)));
}
export function freshRecoveryLink(link: RecoveryLink, now = Date.now()): boolean {
  return Number.isSafeInteger(link.expiresAt) && link.expiresAt * 1000 > now + margin;
}
export function parseRecoveryCallback(address: string, origin: string, occupied: boolean, now = Date.now()): RecoveryCallback {
  if (address.length > 16_384) return { kind: occupied ? 'conflict' : 'invalid' };
  let url: URL;
  try { url = new URL(address); } catch { return { kind: 'invalid' }; }
  if (url.hash !== '#/recovery' && !hasCallbackKeys(url.search) && !hasCallbackKeys(url.hash.slice(1))) return { kind: 'none' };
  if (occupied) return { kind: 'conflict' };
  if (url.origin !== origin || url.pathname !== '/' || url.search || url.username || url.password) return { kind: 'invalid' };
  const fields = new URLSearchParams(url.hash.slice(1));
  const allowed = ['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type'];
  if ([...fields.keys()].some(key => !allowed.includes(key) && key !== 'sb') || allowed.some(key => fields.getAll(key).length !== 1)
    || fields.getAll('sb').length > 1 || (fields.has('sb') && fields.get('sb') !== '')
    || fields.get('type') !== 'recovery' || fields.get('token_type') !== 'bearer') return { kind: 'invalid' };
  const accessToken = fields.get('access_token')!;
  const refreshToken = fields.get('refresh_token')!;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken) || accessToken.length > 8192
    || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(refreshToken)
    || !/^\d{1,10}$/.test(fields.get('expires_at')!) || !/^\d{1,6}$/.test(fields.get('expires_in')!)) return { kind: 'invalid' };
  try {
    const payload: unknown = JSON.parse(atob(accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    const expiresAt = Number(fields.get('expires_at')), expiresIn = Number(fields.get('expires_in'));
    if (!isRecord(payload) || !isUuid(payload.sub) || payload.role !== 'authenticated' || payload.aud !== 'authenticated'
      || payload.exp !== expiresAt || expiresIn < 1 || expiresIn > 86_400 || expiresAt * 1000 > now + expiresIn * 1000 + 5000) return { kind: 'invalid' };
    const link = { accessToken, refreshToken, subject: payload.sub, expiresAt };
    return freshRecoveryLink(link, now) ? { kind: 'link', link } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
}

let normalStarted = false;
let configured = false;
let snapshot: RecoveryCallback = { kind: 'none' };
const listeners = new Set<() => void>();
let cancelAttempt: (() => MessageKey | undefined) | undefined;
export const recoverySnapshot = () => snapshot;
export const normalAuthStarted = () => normalStarted;
export function markNormalAuthStarted(): void { normalStarted = true; }
export function subscribeRecovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function registerRecoveryCancellation(cancel: () => MessageKey | undefined): void { cancelAttempt = cancel; }
export function clearRecoveryNotice(): void {
  if (snapshot.kind !== 'none' || !snapshot.notice) return;
  snapshot = { kind: 'none' };
  for (const listener of listeners) listener();
}
export function leaveRecovery(notice?: MessageKey): void {
  const cancellationNotice = cancelAttempt?.();
  cancelAttempt = undefined;
  snapshot = { kind: 'none', notice: notice ?? cancellationNotice };
  history.replaceState(null, '', '/#/wardrobe');
  for (const listener of listeners) listener();
}
function capture(): void {
  if (snapshot.kind !== 'none' && !location.search && location.hash === '#/recovery') return;
  let occupied = normalStarted;
  try { occupied ||= Boolean(sessionStorage.getItem(authStorageKey)); } catch { occupied = true; }
  const next = parseRecoveryCallback(location.href, location.origin, occupied);
  if (next.kind === 'none') {
    if (snapshot.kind !== 'none') leaveRecovery();
    else clearRecoveryNotice();
    return;
  }
  // Discard both URL and history state before any SDK, render or asynchronous work.
  history.replaceState(null, '', '/#/recovery');
  if (snapshot.kind === 'link') {
    const notice = cancelAttempt?.();
    snapshot = notice ? { kind: 'invalid', notice } : { kind: 'invalid' };
  } else snapshot = !configured && next.kind === 'link' ? { kind: 'invalid' } : next;
  for (const listener of listeners) listener();
}
export function installRecoveryCapture(configurationReady: boolean): void {
  configured = configurationReady;
  capture();
  window.addEventListener('hashchange', capture);
  window.addEventListener('popstate', capture);
}
