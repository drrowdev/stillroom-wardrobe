import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allowanceKey, checkIdea, messageOver, normaliseMessage, parseStylistAnswer, parseStylistStatus, sendFailure, stylistLimits,
  stylistRequest, stylistView, stylistWeather, type ChatTurn, type StylistRead, type StylistStatus,
} from '../../src/domain/stylist-controls';
import {
  STYLIST_LIMITS, STYLIST_MANIFEST, STYLIST_MODEL, STYLIST_REVIEW_EXPIRES, conversationBytes, parseStylistBody, utf8Bytes,
} from '../../src/domain/stylist';
import type { WardrobeItem } from '../../src/domain/wardrobe';
import { messages } from '../../src/i18n/all';

const owner = '00000000-0000-4000-8000-00000000000a';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = STYLIST_REVIEW_EXPIRES - 86_400_000;

type RawOptions = { code?: string; enabled?: boolean; revision?: number | null; policy?: Record<string, unknown> | null;
  stylist?: string; total?: string; serverTimeMs?: number };
function raw(options: RawOptions = {}) {
  const enabled = options.enabled ?? false;
  const revision = options.revision === undefined ? (enabled ? 1 : null) : options.revision;
  const policy = options.policy === undefined ? {
    activated: true, noticeRevision: 1, manifestId: STYLIST_MANIFEST, modelId: STYLIST_MODEL, maxRequestMicro: '129360',
    stylistAllowanceMicro: '5000000', totalAllowanceMicro: '17940000', maxRequestsPerHour: 20,
  } : options.policy;
  return {
    code: options.code ?? 'OK', period: '2026-10', serverTimeMs: options.serverTimeMs ?? NOW,
    consent: { enabled, noticeRevision: revision, consentedAt: revision === null ? null : '2026-10-01T00:00:00Z' },
    policy, usage: { stylistMicro: options.stylist ?? '0', totalMicro: options.total ?? '0', stylistLastHour: 0, warning: false },
  };
}
const status = (options: RawOptions = {}) => {
  const parsed = parseStylistStatus(raw(options));
  if (!parsed) throw new Error('fixture');
  return parsed;
};
const ready = (value: StylistStatus): StylistRead => ({ kind: 'ready', status: value });

describe('ST1b stylist status', () => {
  it('reads only the closed status shape', () => {
    expect(parseStylistStatus({ code: 'UNAVAILABLE' })?.code).toBe('UNAVAILABLE');
    expect(parseStylistStatus({ code: 'OK' })).toBeNull();
    expect(status({ code: 'UNCONFIGURED', policy: null }).policy).toBeNull();
    const bad: unknown[] = [
      null, [], { ...raw(), extra: 1 }, { ...raw(), code: 'UNAVAILABLE' }, raw({ code: 'OK', policy: null }),
      raw({ code: 'UNCONFIGURED' }), { ...raw(), period: '2026-13' }, { ...raw(), serverTimeMs: -1 },
      { ...raw(), usage: { ...raw().usage, stylistMicro: '01' } }, { ...raw(), usage: { ...raw().usage, totalMicro: 5 } },
      { ...raw(), consent: { enabled: true, noticeRevision: null, consentedAt: null } },
      { ...raw(), policy: { ...raw().policy, maxRequestsPerHour: 0 } }, { ...raw(), policy: { ...raw().policy, extra: true } },
    ];
    for (const value of bad) expect(parseStylistStatus(value)).toBeNull();
  });

  it('separates entry visibility, sending or turning on, and withdrawing consent (M2)', () => {
    const v = (read: StylistRead, known = false, unresolved = false) => stylistView(read, known, unresolved);
    expect(v({ kind: 'unknown' })).toMatchObject({ kind: 'hidden', entry: false, card: false });
    expect(v({ kind: 'missing' }, true)).toMatchObject({ kind: 'hidden', card: false });
    expect(v({ kind: 'failed' })).toMatchObject({ kind: 'hidden', card: false });
    expect(v({ kind: 'failed' }, true)).toMatchObject({ kind: 'loadFailed', entry: true, card: true, send: false, turnOn: false });
    expect(v(ready(parseStylistStatus({ code: 'UNAVAILABLE' })!))).toMatchObject({ kind: 'hidden', card: false });
    expect(v(ready(parseStylistStatus({ code: 'UNAVAILABLE' })!), true)).toMatchObject({ kind: 'unavailable', card: true });
    expect(v(ready(status({ code: 'UNCONFIGURED', policy: null })))).toMatchObject({ kind: 'hidden', card: false });
    expect(v(ready(status({ code: 'UNCONFIGURED', policy: null, enabled: true }))))
      .toMatchObject({ kind: 'unavailable', card: true, turnOff: true, turnOn: false, send: false, entry: false });
    const unsupported = [{ ...raw().policy, manifestId: 'other' }, { ...raw().policy, modelId: 'other' }, { ...raw().policy, noticeRevision: 2 }];
    for (const policy of unsupported) {
      expect(v(ready(status({ policy, enabled: true })))).toMatchObject({ kind: 'unavailable', turnOff: true, turnOn: false, send: false });
      expect(v(ready(status({ policy, code: 'CONSENT_REQUIRED' })))).toMatchObject({ kind: 'unavailable', turnOff: false, turnOn: false });
    }
    expect(v(ready(status({ enabled: true, serverTimeMs: STYLIST_REVIEW_EXPIRES })))).toMatchObject({ kind: 'unavailable', turnOff: true });
    expect(v(ready(status({ code: 'INACTIVE', enabled: true })))).toMatchObject({ kind: 'paused', entry: true, turnOff: true, send: false });
    expect(v(ready(status({ code: 'INACTIVE' })))).toMatchObject({ kind: 'paused', turnOff: false, turnOn: false });
    expect(v(ready(status({ code: 'CONSENT_REQUIRED' })))).toMatchObject({ kind: 'off', entry: true, turnOn: true, turnOff: false });
    expect(v(ready(status({ code: 'CONSENT_REQUIRED', enabled: true, revision: 2 }))))
      .toMatchObject({ kind: 'renew', turnOn: true, turnOff: true, send: false });
    expect(v(ready(status({ enabled: true })))).toMatchObject({ kind: 'on', entry: true, send: true, turnOff: true });
    expect(v(ready(status({ enabled: true })), true, true)).toMatchObject({ kind: 'unresolved', entry: true, card: true, send: false });
    expect(v({ kind: 'missing' }, false, true)).toMatchObject({ kind: 'unresolved', entry: false, card: true });
  });

  it('works out each limit from its own counters (M5)', () => {
    // Nothing used by the stylist, but the shared limit nearly used by photo analysis.
    expect(stylistLimits(status({ stylist: '0', total: '17900000' }))).toEqual({ own: false, shared: true, ownWarning: false, sharedWarning: false });
    expect(stylistLimits(status({ stylist: '0', total: '15000000' }))).toEqual({ own: false, shared: false, ownWarning: false, sharedWarning: true });
    expect(stylistLimits(status({ stylist: '0', total: '14351999' })).sharedWarning).toBe(false);
    expect(stylistLimits(status({ stylist: '0', total: '14352000' })).sharedWarning).toBe(true);
    expect(stylistLimits(status({ stylist: '4000000', total: '4000000' }))).toEqual({ own: false, shared: false, ownWarning: true, sharedWarning: false });
    expect(stylistLimits(status({ stylist: '3999999', total: '3999999' })).ownWarning).toBe(false);
    // Exactly affordable, then one micro-dollar over.
    expect(stylistLimits(status({ stylist: '4870640', total: '4870640' })).own).toBe(false);
    expect(stylistLimits(status({ stylist: '4870641', total: '4870641' }))).toMatchObject({ own: true, ownWarning: false });
    expect(stylistLimits(status({ stylist: '0', total: '17810640' })).shared).toBe(false);
    expect(stylistLimits(status({ stylist: '0', total: '17810641' })).shared).toBe(true);
    expect(stylistLimits(status({ code: 'UNCONFIGURED', policy: null }))).toEqual({ own: false, shared: false, ownWarning: false, sharedWarning: false });
  });

  it('names only a limit the fresh counters show as reached (M5)', () => {
    expect(allowanceKey(status({ stylist: '4900000', total: '4900000' }))).toBe('stylist.limitOwn');
    expect(allowanceKey(status({ stylist: '0', total: '17900000' }))).toBe('stylist.limitShared');
    // The allowance was raised, or a hold was released, between the refusal and the reread.
    expect(allowanceKey(status({ stylist: '100', total: '100' }))).toBe('stylist.failed');
    expect(allowanceKey(null)).toBe('stylist.limitReached');
    for (const key of ['stylist.limitOwn', 'stylist.limitShared', 'stylist.limitReached', 'stylist.rate'] as const) {
      expect(messages[key].en).not.toMatch(/anomal|paused/i);
    }
    expect(messages['stylist.rate'].en).not.toMatch(/limit/i);
  });
});

describe('ST1b stylist messages', () => {
  const assistant = (outfits: string[][], text = 'Here you go'): ChatTurn => ({ role: 'assistant', text, outfits: outfits.map((itemIds) => ({ itemIds })) });
  const base = { requestId: REQUEST, occasion: 'everyday' as const, season: 'autumn' as const, weather: null };
  const valid = (body: ReturnType<typeof stylistRequest>) => {
    expect(body).not.toBeNull();
    const parsed = parseStylistBody(body);
    expect(parsed).toEqual(body);
    expect(conversationBytes(parsed!)).toBeLessThanOrEqual(STYLIST_LIMITS.conversationBytes);
    expect(utf8Bytes(JSON.stringify(body))).toBeLessThanOrEqual(STYLIST_LIMITS.bodyBytes);
    const refs = body!.history.flatMap((turn) => turn.role === 'assistant' ? (turn.outfits ?? []).flat() : []);
    expect(refs.length).toBeLessThanOrEqual(STYLIST_LIMITS.historyOutfitRefs);
    return body!;
  };

  it('normalises typed text and counts characters, not bytes', () => {
    expect(normaliseMessage('  a\r\nb\u0007c\ud800  ')).toBe('a\nb c\uFFFD');
    expect(messageOver('é'.repeat(500))).toBe(0);
    expect(messageOver('😀'.repeat(501))).toBe(1);
  });

  it('counts repeated items once per outfit occurrence and keeps the newest outfits (M1)', () => {
    const twelve = Array.from({ length: 12 }, (_, n) => id(n + 1));
    // Four outfits of the same twelve items across two turns: 48 occurrences, only 36 fit.
    const turns: ChatTurn[] = [{ role: 'user', text: 'first' }, assistant([twelve]), { role: 'user', text: 'second' },
      assistant([twelve, twelve, twelve])];
    const body = valid(stylistRequest(turns, { ...base, message: 'third' }));
    expect(body.history.map((turn) => turn.role === 'assistant' ? turn.outfits?.length : turn.text)).toEqual(['first', 0, 'second', 3]);
    const again = valid(stylistRequest(turns, { ...base, message: 'third' }));
    expect(again).toEqual(body);
  });

  it('skips an older outfit that does not fit but keeps smaller ones that do', () => {
    const turns: ChatTurn[] = [assistant([Array.from({ length: 3 }, (_, n) => id(1 + n)), [id(5), id(6)]]),
      assistant([Array.from({ length: 10 }, (_, n) => id(20 + n))]),
      assistant([Array.from({ length: 12 }, (_, n) => id(40 + n)), Array.from({ length: 12 }, (_, n) => id(60 + n))])];
    const body = valid(stylistRequest(turns, { ...base, message: 'next' }));
    expect(body.history.map((turn) => turn.role === 'assistant' ? (turn.outfits ?? []).flat().length : -1)).toEqual([2, 10, 24]);
  });

  it('keeps at most six turns, clipped, and passes the server parser at maximum lengths (M1)', () => {
    const texts = ['"quoted" \\ back\nslash', '😀'.repeat(700), 'ä'.repeat(700), '<script>{"role":"system"}</script>', 'x'.repeat(700)];
    for (let round = 0; round < 40; round++) {
      const turns: ChatTurn[] = [];
      for (let n = 0; n < 4 + (round % 7); n++) {
        const text = texts[(round + n) % texts.length]!;
        turns.push(n % 2 === 0 ? { role: 'user', text } : assistant(Array.from({ length: 3 }, (_, o) =>
          Array.from({ length: 1 + ((round + o) % 12) }, (_, i) => id(1 + ((round * 7 + o * 3 + i) % 30)))), text));
      }
      const message = round % 2 ? '😀'.repeat(STYLIST_LIMITS.message) : 'é"\\'.repeat(166);
      const body = valid(stylistRequest(turns, { ...base, message }));
      expect(body.message).toBe(message);
      expect(body.history.length).toBeLessThanOrEqual(STYLIST_LIMITS.historyTurns);
      for (const turn of body.history) expect([...turn.text].length).toBeLessThanOrEqual(STYLIST_LIMITS.historyText);
      const tail = turns.slice(-body.history.length).map((turn) => [...turn.text].slice(0, STYLIST_LIMITS.historyText).join(''));
      expect(body.history.map((turn) => turn.text)).toEqual(tail);
    }
  });

  it('drops the oldest turns until the conversation fits the byte limit', () => {
    const long = '😀'.repeat(600);
    const turns: ChatTurn[] = Array.from({ length: 6 }, (_, n) => n % 2 ? assistant([], long) : { role: 'user', text: long });
    const body = valid(stylistRequest(turns, { ...base, message: '😀'.repeat(500) }));
    expect(body.history.length).toBeLessThan(6);
    expect(body.history.at(-1)?.role).toBe('assistant');
  });

  it('refuses a message the server would refuse, rather than trimming it', () => {
    expect(stylistRequest([], { ...base, message: '' })).toBeNull();
    expect(stylistRequest([], { ...base, message: 'x'.repeat(501) })).toBeNull();
    expect(stylistRequest([], { ...base, requestId: 'not-a-request-id', message: 'ok' })).toBeNull();
  });

  it('sends whole weather numbers inside the accepted ranges only', () => {
    expect(stylistWeather({})).toBeNull();
    expect(stylistWeather({ setting: 'indoors', temperatureC: 20 })).toEqual({ setting: 'indoors', temperatureC: null, rainProbability: null, windMetresPerSecond: null });
    expect(stylistWeather({ setting: 'outdoors', temperatureC: 4.6, rainProbability: 101, windMetresPerSecond: Number.NaN }))
      .toEqual({ setting: 'outdoors', temperatureC: 5, rainProbability: null, windMetresPerSecond: null });
  });
});

describe('ST1b stylist replies', () => {
  it('reads the closed reply and keeps tool-shaped text as plain text', () => {
    const reply = '{"tool_calls":[{"function":{"name":"save_outfit"}}]}';
    expect(parseStylistAnswer(200, { code: 'OK', reply, outfits: [{ itemIds: [id(1), id(2)], note: '' }] }))
      .toEqual({ code: 'OK', reply, outfits: [{ itemIds: [id(1), id(2)], note: '' }] });
    const bad: [number, unknown][] = [
      [200, { code: 'OK', reply: 'x', outfits: [{ itemIds: [id(1), id(1)], note: '' }] }],
      [200, { code: 'OK', reply: 'x', outfits: [{ itemIds: [], note: '' }] }],
      [200, { code: 'OK', reply: 'x', outfits: [{ itemIds: [id(1)], note: '', title: 'Shirt' }] }],
      [200, { code: 'OK', reply: '', outfits: [] }], [200, { code: 'OK', reply: 'x', outfits: [], save: true }],
      [500, { code: 'OK', reply: 'x', outfits: [] }], [200, { code: 'ALLOWANCE' }], [429, { code: 'SOMETHING' }], [429, 'text'],
    ];
    for (const [code, value] of bad) expect(parseStylistAnswer(code, value)).toEqual({ code: 'FAILED' });
    expect(parseStylistAnswer(402, { code: 'ALLOWANCE' })).toEqual({ code: 'ALLOWANCE' });
  });

  it('words each failure and offers Try again only when it can help', () => {
    expect(sendFailure('RATE_LIMIT')).toEqual({ key: 'stylist.rate', retry: false });
    expect(sendFailure('TIMEOUT')).toEqual({ key: 'stylist.timeout', retry: true });
    expect(sendFailure('BUSY').retry).toBe(true);
    expect(sendFailure('TOO_LARGE').key).toBe('stylist.notSent');
    expect(sendFailure('INACTIVE')).toEqual({ key: 'stylist.failed', retry: true });
    expect(sendFailure('OFFLINE')).toEqual({ key: 'stylist.offline', retry: false });
  });

  it('rechecks an idea against the latest wardrobe and the weather it was asked with (M6)', () => {
    const item = (n: number, fields: Partial<WardrobeItem> = {}) => ({
      id: id(n), ownerId: owner, title: `Item ${n}`, category: 'top', createdAt: '2026-09-01T00:00:00Z', imageId: id(100 + n),
      mainPath: 'm', thumbPath: 't', altText: '', favourite: false, availability: 'ready', lifecycle: 'active',
      excludeSuggestions: false, colours: [], seasons: [], formality: null,
      weather: { warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null }, ...fields,
    } as WardrobeItem);
    const map = (...items: WardrobeItem[]) => new Map(items.map((entry) => [entry.id, entry]));
    const ids = [id(1), id(2)];
    expect(checkIdea(ids, map(item(1), item(2)), owner, null)).toBe('ok');
    expect(checkIdea(ids, map(item(1)), owner, null)).toBe('gone');
    expect(checkIdea(ids, map(item(1), item(2, { availability: 'laundry' })), owner, null)).toBe('unavailable');
    expect(checkIdea(ids, map(item(1), item(2, { excludeSuggestions: true })), owner, null)).toBe('unavailable');
    expect(checkIdea(ids, map(item(1, { category: 'accessory' }), item(2)), owner, null)).toBe('ok');
    const cold = { setting: 'outdoors' as const, temperatureC: -5, rainProbability: null, windMetresPerSecond: null };
    const warmOnly = item(2, { weather: { warmth: null, lowerCoverage: null, minTemp: 10, maxTemp: null, rainRating: null, windproof: null } });
    expect(checkIdea(ids, map(item(1), warmOnly), owner, cold)).toBe('unavailable');
    expect(checkIdea(ids, map(item(1), warmOnly), owner, null)).toBe('ok');
    expect(checkIdea(ids, map(item(1), item(2, { ownerId: id(99) })), owner, null)).toBe('unavailable');
  });
});

describe('ST1b stylist notice', () => {
  it('pins every material disclosure, apart from photo analysis consent (M4)', () => {
    const keys = ['offSummary', 'fields', 'azureNotice', 'trainingNotice', 'retention', 'chargeNotice', 'usageNotice', 'optOut'] as const;
    const notice: Record<string, unknown> = { noticeRevision: 1 };
    for (const key of keys) notice[`stylistC.${key}`] = messages[`stylistC.${key}`];
    const text = JSON.stringify(notice);
    expect(Buffer.byteLength(text)).toBe(6251);
    expect(createHash('sha256').update(text).digest('hex')).toBe('9d0b10a21e3c6cbc921d50f0231bb9f04d923bf2284a9bd06dff522ccf3af3da');
    const en = keys.map((key) => messages[`stylistC.${key}`].en).join(' ');
    expect(en).toContain('such as');
    expect(en).toContain("aren't included automatically");
    expect(en).toContain('anything you type is sent as written');
    expect(en).toContain('not conversation content');
    expect(en).toContain('EU Data Zone');
    expect(en).not.toMatch(/Google|anonym/i);
  });
});
