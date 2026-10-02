/**
 * Cross-tab sign-out messages. A sign-out the user starts is the only thing that sends; a tab acting on a received
 * message never sends anything, so one sign-out can never echo or cascade.
 *
 * - `stillroom.auth.v2` carries `{v: 2, type, nonce}` for this and later releases.
 * - The legacy `stillroom.logout` channel still reaches tabs of older releases, which treat any message (or any
 *   non-empty storage value) as a sign-out. It carries only genuine sign-outs, marked so that current tabs ignore the
 *   twin and act on the v2 message instead. An unmarked legacy message can only come from an older release.
 */
export const legacyChannelName = 'stillroom.logout';
export const authChannelName = 'stillroom.auth.v2';
export const markedLegacyMessage = 'sign-out:v2';
const markedStoragePrefix = 'v2:';
export type AuthCommand = 'sign-out';
type V2Message = { v: 2; type: AuthCommand; nonce: string };

function parseV2(data: unknown): V2Message | null {
  if (typeof data !== 'object' || data === null) return null;
  const { v, type, nonce } = data as Record<string, unknown>;
  if (v !== 2 || type !== 'sign-out' || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) return null;
  return { v, type, nonce };
}

/**
 * Both channels for one tab. Sending uses the same objects that listen, so a tab never receives its own message.
 * `receive` gets each distinct command once.
 */
export function openAuthChannels(receive: (command: AuthCommand) => void): { send(type: AuthCommand): void; close(): void } {
  const seen: string[] = [];
  const remember = (nonce: string) => {
    if (seen.includes(nonce)) return false;
    seen.push(nonce);
    if (seen.length > 64) seen.shift();
    return true;
  };
  const hasChannels = typeof BroadcastChannel === 'function';
  const v2 = hasChannels ? new BroadcastChannel(authChannelName) : null;
  const legacy = hasChannels ? new BroadcastChannel(legacyChannelName) : null;
  if (v2) v2.onmessage = (event: MessageEvent) => { const message = parseV2(event.data); if (message && remember(message.nonce)) receive(message.type); };
  if (legacy) legacy.onmessage = (event: MessageEvent) => { if (event.data !== markedLegacyMessage) receive('sign-out'); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== legacyChannelName || !event.newValue) return;
    // A marked value comes from a current tab without BroadcastChannel; it is the only copy that tab sent.
    if (!event.newValue.startsWith(markedStoragePrefix)) receive('sign-out');
    else if (remember(event.newValue.slice(markedStoragePrefix.length))) receive('sign-out');
  };
  window.addEventListener('storage', onStorage);
  return {
    /** Sends one command. Only a user's own action in this tab may call this. */
    send(type: AuthCommand) {
      const nonce = crypto.randomUUID();
      remember(nonce);
      try {
        if (v2) {
          v2.postMessage({ v: 2, type, nonce } satisfies V2Message);
          if (type === 'sign-out') legacy?.postMessage(markedLegacyMessage);
        } else if (type === 'sign-out') {
          window.localStorage.setItem(legacyChannelName, `${markedStoragePrefix}${nonce}`);
          window.localStorage.removeItem(legacyChannelName);
        }
      } catch { /* Other tabs notice on their next request. */ }
    },
    close() {
      v2?.close();
      legacy?.close();
      window.removeEventListener('storage', onStorage);
    },
  };
}
