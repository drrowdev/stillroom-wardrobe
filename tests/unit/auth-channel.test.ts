import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authChannelName, legacyChannelName, markedLegacyMessage, openAuthChannels, type AuthCommand } from '../../src/auth/auth-channel';

// Node's BroadcastChannel delivers between instances in one process, like tabs of one origin.
let storageListeners: Set<(event: StorageEvent) => void>;
let localValues: Map<string, string>;
let opened: { close(): void }[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  storageListeners = new Set();
  localValues = new Map();
  opened = [];
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === 'storage') storageListeners.add(listener); },
    removeEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === 'storage') storageListeners.delete(listener); },
    localStorage: {
      setItem: (key: string, value: string) => { localValues.set(key, value); },
      removeItem: (key: string) => { localValues.delete(key); },
    },
  });
});
afterEach(() => {
  for (const channel of opened) channel.close();
  vi.unstubAllGlobals();
});

function tab() {
  const received: AuthCommand[] = [];
  const channels = openAuthChannels((command) => received.push(command));
  opened.push(channels);
  return { received, channels };
}
function raw(name: string) {
  const messages: unknown[] = [];
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event: MessageEvent) => messages.push(event.data);
  opened.push(channel);
  return { messages, channel };
}
const storageEvent = (newValue: string | null, key = legacyChannelName) => {
  for (const listener of storageListeners) listener({ key, newValue } as StorageEvent);
};

describe('auth channels', () => {
  it('sends a sign-out once to other tabs, never to itself, with a marked legacy twin for older releases', async () => {
    const sender = tab(), other = tab();
    const legacy = raw(legacyChannelName), v2 = raw(authChannelName);
    sender.channels.send('sign-out');
    await settle();
    expect(other.received).toEqual(['sign-out']);
    expect(sender.received).toEqual([]);
    expect(legacy.messages).toEqual([markedLegacyMessage]);
    expect(v2.messages).toEqual([{ v: 2, type: 'sign-out', nonce: expect.any(String) }]);
  });

  it('drops a replayed v2 message and acts on each distinct one', async () => {
    const receiver = tab();
    const v2 = raw(authChannelName);
    const message = { v: 2, type: 'sign-out', nonce: crypto.randomUUID() };
    v2.channel.postMessage(message);
    v2.channel.postMessage(message);
    await settle();
    v2.channel.postMessage(message);
    v2.channel.postMessage({ ...message, nonce: crypto.randomUUID() });
    await settle();
    expect(receiver.received).toEqual(['sign-out', 'sign-out']);
  });

  it.each([
    null, 'sign-out', {}, { v: 1, type: 'sign-out', nonce: 'abcdefgh-1' }, { v: 2, type: 'reset', nonce: 'abcdefgh-1' },
    { v: 2, type: 'sign-out' }, { v: 2, type: 'sign-out', nonce: 'short' }, { v: 2, type: 'sign-out', nonce: 'x'.repeat(65) },
  ])('ignores a malformed v2 message: %j', async (message) => {
    const receiver = tab();
    raw(authChannelName).channel.postMessage(message);
    await settle();
    expect(receiver.received).toEqual([]);
  });

  it('ignores the marked legacy twin, but treats any unmarked legacy message as a sign-out from an older release', async () => {
    const receiver = tab();
    const legacy = raw(legacyChannelName);
    legacy.channel.postMessage(markedLegacyMessage);
    await settle();
    expect(receiver.received).toEqual([]);
    legacy.channel.postMessage('logout');
    legacy.channel.postMessage(null);
    await settle();
    expect(receiver.received).toEqual(['sign-out', 'sign-out']);
  });

  it('sends end-remembered only on the v2 channel, never as a legacy sign-out', async () => {
    const sender = tab(), other = tab();
    const legacy = raw(legacyChannelName);
    sender.channels.send('end-remembered');
    await settle();
    expect(other.received).toEqual(['end-remembered']);
    expect(legacy.messages).toEqual([]);
  });

  it('reads the storage fallback: unmarked values are sign-outs, marked ones once each, removals nothing', () => {
    const receiver = tab();
    storageEvent(null);
    storageEvent('x', 'stillroom.other');
    expect(receiver.received).toEqual([]);
    storageEvent('1700000000000');
    storageEvent('v2:abcdefgh-1');
    storageEvent('v2:abcdefgh-1');
    expect(receiver.received).toEqual(['sign-out', 'sign-out']);
  });

  it('stops receiving once closed', async () => {
    const receiver = tab();
    receiver.channels.close();
    raw(legacyChannelName).channel.postMessage('logout');
    storageEvent('1700000000000');
    await settle();
    expect(receiver.received).toEqual([]);
  });
});

describe('auth channels without BroadcastChannel', () => {
  it('writes and removes a marked storage value for a sign-out only', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const writes: [string, string][] = [];
    const store = (window as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
    const setItem = store.setItem.bind(store);
    store.setItem = (key, value) => { writes.push([key, value]); setItem(key, value); };
    const sender = tab();
    sender.channels.send('end-remembered');
    expect(writes).toEqual([]);
    sender.channels.send('sign-out');
    expect(writes).toEqual([[legacyChannelName, expect.stringMatching(/^v2:[0-9a-f-]{36}$/)]]);
    expect(localValues.has(legacyChannelName)).toBe(false);
    // Its own value, echoed back, is not acted on.
    storageEvent(writes[0]?.[1] ?? null);
    expect(sender.received).toEqual([]);
  });
});
