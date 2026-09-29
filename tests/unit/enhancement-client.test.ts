import { describe, expect, it, vi } from 'vitest';
import type { EnhanceResponse, EnhanceStatusRead } from '../../src/data/enhancement';
import {
  enhanceView, lineWhenNotSent, observeEnhanceStatus, parseEnhanceStatus, type EnhanceStatus,
} from '../../src/domain/enhance-controls';
import { CLEANUP_MANIFEST, CLEANUP_NOTICE_REVISION, ENHANCE_LIMITS, ENHANCE_MODEL } from '../../src/domain/enhancement';
import { REFERENCE_HEIGHT, REFERENCE_WIDTH } from '../../src/images/background/frame';
import { FIDELITY } from '../../src/images/fidelity';
import { isPhotoInputJpeg } from '../../src/images/restore-jpeg';
import { appleLayoutJpeg } from '../fixtures/restore-jpeg-fixtures';
import {
  EXPIRY_MARGIN_MS, EnhanceSession, anchorFrom, expiryDeadline, runEnhancementStage, type DecodedFrame, type StageDeps,
  type StageInput,
} from '../../src/features/wardrobe/enhancement-stage';
import type { CleanupSource } from '../../src/images/process-jpeg';

const SERVER = Date.parse('2026-10-01T12:00:00Z');
const raw = (over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) => ({
  code: 'OK', period: '2026-10', serverTimeMs: SERVER,
  consent: { enabled: true, noticeRevision: CLEANUP_NOTICE_REVISION, consentedAt: '2026-09-30T00:00:00Z' },
  policy: { activated: true, noticeRevision: CLEANUP_NOTICE_REVISION, manifestId: CLEANUP_MANIFEST, modelId: ENHANCE_MODEL,
    maxRequestMicro: '300000', enhanceAllowanceMicro: '5000000', totalAllowanceMicro: '20000000', maxRequestsPerHour: 20,
    providerAvailable: true, ...policy },
  usage: { enhanceMicro: '0', totalMicro: '0', enhanceLastHour: 0, warning: false }, ...over,
});
const status = (over?: Record<string, unknown>, policy?: Record<string, unknown>): EnhanceStatus => {
  const parsed = parseEnhanceStatus(raw(over, policy));
  if (!parsed) throw new Error('fixture');
  return parsed;
};
const off = () => status({ consent: { enabled: false, noticeRevision: null, consentedAt: null } });

describe('typed availability (M1)', () => {
  it('parses only the closed status shapes', () => {
    expect(parseEnhanceStatus({ code: 'UNAVAILABLE' })?.code).toBe('UNAVAILABLE');
    expect(parseEnhanceStatus({ code: 'OK' })).toBeNull();
    expect(parseEnhanceStatus({ ...raw(), extra: 1 })).toBeNull();
    expect(parseEnhanceStatus(raw({ code: 'OK', policy: null }))).toBeNull();
  });
  it('separates never enabled or not activated from operational unavailability', () => {
    expect(observeEnhanceStatus(status(), false)).toBe('ready');
    expect(observeEnhanceStatus(off(), false)).toBe('off');
    expect(observeEnhanceStatus(status({}, { activated: false }), false)).toBe('off');
    expect(observeEnhanceStatus(status({}, { providerAvailable: false }), false)).toBe('paused');
    expect(observeEnhanceStatus(status({}, { modelId: 'other' }), false)).toBe('paused');
    // BG2c-2: the client supports only the clean-up manifest and notice revision 2; the v1 policy reads as paused.
    expect(observeEnhanceStatus(status({}, { manifestId: 'azure-global-image25-sunburst-enhance-v1' }), false)).toBe('paused');
    expect(observeEnhanceStatus(status({ consent: { enabled: true, noticeRevision: 1, consentedAt: '2026-09-30T00:00:00Z' } },
      { noticeRevision: 1 }), false)).toBe('paused');
    // A revision-1 consent never counts for the revision-2 policy.
    expect(observeEnhanceStatus(status({ consent: { enabled: true, noticeRevision: 1, consentedAt: '2026-09-30T00:00:00Z' } }), false))
      .toBe('off');
    const bare = parseEnhanceStatus({ code: 'UNAVAILABLE' })!;
    expect(observeEnhanceStatus(bare, false)).toBe('off');
    expect(observeEnhanceStatus(bare, true)).toBe('paused');
  });
  it('keeps Turn off available whenever consent is on, and offers Turn on only when activated', () => {
    expect(enhanceView({ kind: 'ready', status: off() }, false, false, false)).toEqual({ kind: 'off', turnOn: true, turnOff: false });
    expect(enhanceView({ kind: 'ready', status: status({ consent: { enabled: false, noticeRevision: null, consentedAt: null } },
      { activated: false }) }, false, false, false).turnOn).toBe(false);
    expect(enhanceView({ kind: 'ready', status: status({}, { activated: false }) }, false, false, true)).toEqual({ kind: 'paused', turnOn: false, turnOff: true });
    expect(enhanceView({ kind: 'ready', status: status({}, { providerAvailable: false }) }, false, false, true).turnOff).toBe(true);
    expect(enhanceView({ kind: 'failed' }, false, true, true)).toEqual({ kind: 'loadFailed', turnOn: false, turnOff: true });
    expect(enhanceView({ kind: 'ready', status: status() }, true, true, true)).toEqual({ kind: 'unresolved', turnOn: false, turnOff: true });
  });
});

describe('the latest-observation memory (A5)', () => {
  it('stays silent only for a recent verified off', () => {
    const session = new EnhanceSession(() => 1000);
    session.observe('off');
    expect(lineWhenNotSent('unknown', session.memory, 1000 + 599_999)).toBe('none');
    expect(lineWhenNotSent('unknown', session.memory, 1000 + 600_000)).toBe('generic');
  });
  it('off → ready → failed read shows the line', () => {
    const session = new EnhanceSession(() => 1000);
    session.observe('off'); session.observe('ready');
    expect(lineWhenNotSent('unknown', session.memory, 1001)).toBe('generic');
  });
  it('off → uncertain consent write → failed read shows the line, and an older read cannot restore off', () => {
    const session = new EnhanceSession(() => 1000);
    session.observe('off');
    const since = session.writes;
    session.consentChanging();
    session.observe('off', since);
    expect(session.memory.last).toBeNull();
    expect(lineWhenNotSent('unknown', session.memory, 1001)).toBe('generic');
  });
  it('a known-enabled feature stopped offline or by the failure flag shows the line', async () => {
    const session = new EnhanceSession(() => 0);
    session.observe('ready');
    const { deps, calls } = harness(session);
    expect(await runEnhancementStage(input({ online: false }), deps)).toEqual({ kind: 'skipped', line: 'generic', requestId: null });
    session.failed(); session.failed();
    expect(session.paused()).toBe(true);
    expect(await runEnhancementStage(input(), deps)).toEqual({ kind: 'skipped', line: 'generic', requestId: null });
    expect(calls.status + calls.enhance).toBe(0);
  });
});

describe('server-time anchor (A4)', () => {
  it('discards samples with a round trip over 5 s', () => {
    expect(anchorFrom({ serverTimeMs: SERVER, t0: 0, t1: 5001 })).toBeNull();
    expect(anchorFrom({ serverTimeMs: SERVER, t0: 10, t1: 5 })).toBeNull();
    expect(anchorFrom({ serverTimeMs: SERVER, t0: 0, t1: 5000 })).toEqual({ serverTimeMs: SERVER, mid: 2500, at: 5000 });
  });
  it('uses only monotonic elapsed time, so device skew and wall-clock jumps do not move the deadline', () => {
    const anchor = anchorFrom({ serverTimeMs: SERVER, t0: 0, t1: 200 })!;
    const usable = SERVER + 20 * 60_000;
    const baseline = expiryDeadline(anchor, usable, 60_000);
    for (const skew of [-2 * 3600_000, 2 * 3600_000, 10 * 86_400_000]) {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(SERVER + skew);
      expect(expiryDeadline(anchor, usable, 60_000)).toBe(baseline);
      spy.mockRestore();
    }
    expect(baseline).toBe(60_000 + (usable - (SERVER + 60_000 - 100)) - EXPIRY_MARGIN_MS);
    expect(expiryDeadline(anchor, SERVER + EXPIRY_MARGIN_MS, 100)).toBeNull();
  });
  it('sends nothing without a usable sample', async () => {
    const session = new EnhanceSession(() => 0);
    const { deps, calls } = harness(session, { sample: null });
    expect(await runEnhancementStage(input(), deps)).toMatchObject({ kind: 'skipped', line: 'generic' });
    expect(calls.enhance).toBe(0);
  });
});

type Frame = DecodedFrame & { closed: boolean; id: string };
/** R with one rectangle, or with a second one of `second` times its area (two garments side by side). */
function reference(second = 0): Uint8Array {
  const mask = new Uint8Array(REFERENCE_WIDTH * REFERENCE_HEIGHT);
  const fill = (left: number, top: number, width: number, height: number) => {
    for (let y = top; y < top + height; y++) mask.fill(1, y * REFERENCE_WIDTH + left, y * REFERENCE_WIDTH + left + width);
  };
  fill(20, 60, 100, 200);
  if (second) fill(150, 60, 100 * second, 200);
  return mask;
}
const source = (over: Partial<CleanupSource> = {}): CleanupSource => ({ main: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
  width: 1024, height: 1280, sha256: 'a'.repeat(64), reference: reference(),
  geometry: { edit: { rotation: 0, crop: null } as never, source: {} as never, dest: {} as never, canvas: {} as never }, ...over });
function input(over: Partial<StageInput> = {}): StageInput {
  return { source: source(), cutOut: true, online: true, current: () => true, signal: new AbortController().signal,
    skip: new AbortController().signal, ...over };
}
const metrics = { ringDeltaE: 1, ringP95: 2, containment: 1, retention: 1, largestShare: 1, centroid: { x: 0, y: 0 }, support: 1,
  meanDeltaE: 0, p95DeltaE: 0, ssim: 1, windows: 1, workingBytes: 1 };
function harness(session: EnhanceSession, options: {
  read?: EnhanceStatusRead | Error; sample?: { serverTimeMs: number; t0: number; t1: number } | null;
  response?: (body: Uint8Array<ArrayBuffer>) => EnhanceResponse; accept?: boolean; stripped?: boolean; admitBytes?: Uint8Array<ArrayBuffer>;
} = {}) {
  const body = new Uint8Array(new ArrayBuffer(64)).fill(7);
  const calls = { status: 0, enhance: 0, decode: 0, order: [] as string[], decoded: [] as Blob[],
    compared: [] as Parameters<StageDeps['compare']>[] };
  const frames: Frame[] = [];
  const sample = options.sample === undefined ? { serverTimeMs: SERVER, t0: 0, t1: 10 } : options.sample;
  const deps: StageDeps = {
    session,
    client: {
      status: async () => {
        calls.status++;
        if (options.read instanceof Error) throw options.read;
        return options.read ?? { kind: 'ready', status: status(), sample };
      },
      enhance: async () => {
        calls.enhance++;
        return options.response ? options.response(body)
          : { kind: 'image', body, sha256: 'c'.repeat(64), length: body.byteLength, usableUntilMs: SERVER + 3600_000 };
      },
    },
    imaging: {
      sha256: async () => 'c'.repeat(64),
      validate: () => undefined,
      decode: async (blob) => {
        calls.decode++;
        calls.decoded.push(blob);
        const frame: Frame = { id: `f${calls.decode}`, width: 1024, height: 1280, closed: false,
          close() { frame.closed = true; calls.order.push(`close:${frame.id}`); } };
        calls.order.push(`decode:${frame.id}`);
        frames.push(frame);
        return frame;
      },
      downsample: () => new Uint8ClampedArray(FIDELITY.width * FIDELITY.height * 4),
      thumbnail: async () => ({ blob: new Blob([new Uint8Array([3])]), sha256: 'd'.repeat(64) }),
    },
    admit: (bytes) => ({ bytes: options.admitBytes ?? (bytes as Uint8Array<ArrayBuffer>), width: 1024, height: 1280, stripped: options.stripped ?? false }),
    compare: (...args) => {
      calls.compared.push(args);
      return options.accept === false ? { accepted: false, reason: 'colour', metrics: {} } : { accepted: true, metrics };
    },
    newId: () => '11111111-1111-4111-8111-111111111111',
  };
  return { deps, calls, frames, body };
}

describe('the stage core', () => {
  it('accepts an admitted, faithful result and closes each decode before the next', async () => {
    const session = new EnhanceSession(() => 100);
    const { deps, calls, frames } = harness(session);
    const result = await runEnhancementStage(input(), deps);
    expect(result).toMatchObject({ kind: 'enhanced', requestId: '11111111-1111-4111-8111-111111111111' });
    if (result.kind === 'enhanced') expect(result.photo).toMatchObject({ width: 1024, height: 1280, mainSha256: 'c'.repeat(64), thumbSha256: 'd'.repeat(64) });
    expect(calls.order).toEqual(['decode:f1', 'close:f1', 'decode:f2', 'close:f2']);
    expect(frames.every((frame) => frame.closed)).toBe(true);
  });
  it('sends an iPhone-style restart-interval photo unchanged', async () => {
    const bytes = appleLayoutJpeg({ width: 1024, height: 1280, restartInterval: 4 });
    expect(isPhotoInputJpeg(bytes, 1024, 1280)).toBe(true);
    const { deps, calls } = harness(new EnhanceSession(() => 100));
    const sent: Blob[] = [];
    const client = deps.client;
    deps.client = { ...client, enhance: (photo, requestId, signal) => { sent.push(photo.main); return client.enhance(photo, requestId, signal); } };
    const result = await runEnhancementStage(input({ source: source({ main: new Blob([bytes], { type: 'image/jpeg' }) }) }), deps);
    expect(result.kind).toBe('enhanced');
    expect(calls.enhance).toBe(1);
    expect(new Uint8Array(await sent[0]!.arrayBuffer())).toEqual(bytes);
  });
  it('sends H0, never H1, and checks H2 against the decoded H0 and R', async () => {
    const { deps, calls } = harness(new EnhanceSession(() => 100));
    const sent: Blob[] = [];
    const client = deps.client;
    deps.client = { ...client, enhance: (photo, requestId, signal) => { sent.push(photo.main); return client.enhance(photo, requestId, signal); } };
    const h0 = source();
    expect(await runEnhancementStage(input({ source: h0 }), deps)).toMatchObject({ kind: 'enhanced', metrics });
    expect(sent).toEqual([h0.main]);
    expect(calls.decoded[1]).toBe(h0.main);
    expect(calls.compared).toHaveLength(1);
    expect(calls.compared[0]![1]).toBe(h0.reference);
  });
  it('the pre-upload check stops at "available" with no request and no request ID', async () => {
    const ids = vi.fn(() => '11111111-1111-4111-8111-111111111111');
    const { deps, calls } = harness(new EnhanceSession(() => 100));
    deps.newId = ids;
    expect(await runEnhancementStage(input({ preflight: true }), deps)).toEqual({ kind: 'available' });
    expect(calls.status).toBe(1);
    expect(calls.enhance).toBe(0);
    expect(ids).not.toHaveBeenCalled();
    // Not ready, no source or an ambiguous crop never opens the review.
    expect(await runEnhancementStage(input({ preflight: true, source: null }), deps)).toMatchObject({ kind: 'skipped', line: 'generic' });
    const off0 = harness(new EnhanceSession(() => 100), { read: { kind: 'ready', status: off(), sample: null } });
    expect(await runEnhancementStage(input({ preflight: true }), off0.deps)).toMatchObject({ kind: 'skipped', line: 'none' });
  });
  it('an ambiguous crop sends nothing and says why; a small second region does not count', async () => {
    const { deps, calls } = harness(new EnhanceSession(() => 100));
    for (const preflight of [false, true]) {
      expect(await runEnhancementStage(input({ preflight, source: source({ reference: reference(0.5) }) }), deps))
        .toEqual({ kind: 'skipped', line: 'ambiguous', requestId: null });
    }
    expect(await runEnhancementStage(input({ source: source({ reference: new Uint8Array(REFERENCE_WIDTH * REFERENCE_HEIGHT) }) }), deps))
      .toMatchObject({ kind: 'skipped', line: 'ambiguous' });
    expect(calls.enhance).toBe(0);
    expect(await runEnhancementStage(input({ source: source({ reference: reference(0.2) }) }), deps)).toMatchObject({ kind: 'enhanced' });
    // Only when clean-up would have been sent: off says nothing about the crop.
    const off0 = harness(new EnhanceSession(() => 100), { read: { kind: 'ready', status: off(), sample: null } });
    expect(await runEnhancementStage(input({ source: source({ reference: reference(0.5) }) }), off0.deps)).toMatchObject({ line: 'none' });
  });
  it('a missing H0 keeps H1 with the generic line when clean-up was ready', async () => {
    const { deps, calls } = harness(new EnhanceSession(() => 100));
    expect(await runEnhancementStage(input({ source: null }), deps)).toEqual({ kind: 'skipped', line: 'generic', requestId: null });
    expect(calls.enhance).toBe(0);
  });
  it('sends nothing for an uncut photo, off, a missing function or a failed read', async () => {
    for (const [over, options, line] of [
      [{ cutOut: false }, {}, 'none'],
      [{}, { read: { kind: 'ready', status: off(), sample: null } }, 'none'],
      [{}, { read: { kind: 'missing' } }, 'none'],
      [{}, { read: new Error('offline') }, 'generic'],
      [{}, { read: { kind: 'ready', status: status({}, { providerAvailable: false }), sample: null } }, 'generic'],
    ] as const) {
      const { deps, calls } = harness(new EnhanceSession(() => 0), options as never);
      expect(await runEnhancementStage(input(over), deps)).toMatchObject({ kind: 'skipped', line });
      expect(calls.enhance).toBe(0);
    }
  });
  it('rejects each admission failure and keeps H1', async () => {
    const cases: Parameters<typeof harness>[1][] = [
      { response: (body) => ({ kind: 'image', body, sha256: 'c'.repeat(64), length: body.byteLength + 1, usableUntilMs: SERVER + 3600_000 }) },
      { response: (body) => ({ kind: 'image', body, sha256: 'e'.repeat(64), length: body.byteLength, usableUntilMs: SERVER + 3600_000 }) },
      { response: () => { const big = new Uint8Array(new ArrayBuffer(ENHANCE_LIMITS.outputBytes + 1)); return { kind: 'image', body: big, sha256: 'c'.repeat(64), length: big.byteLength, usableUntilMs: SERVER + 3600_000 }; } },
      { stripped: true },
      { admitBytes: new Uint8Array(new ArrayBuffer(64)).fill(8) },
      { accept: false },
      { response: (body) => ({ kind: 'image', body, sha256: 'c'.repeat(64), length: body.byteLength, usableUntilMs: SERVER + 30_000 }) },
    ];
    for (const options of cases) {
      const { deps, frames } = harness(new EnhanceSession(() => 100), options);
      expect(await runEnhancementStage(input(), deps)).toMatchObject({ kind: 'skipped', line: 'generic' });
      expect(frames.every((frame) => frame.closed)).toBe(true);
    }
  });
  it('maps provider codes and trips the failure flag after two failures', async () => {
    const session = new EnhanceSession(() => 100);
    const { deps } = harness(session, { response: () => ({ kind: 'code', code: 'ALLOWANCE' }) });
    expect(await runEnhancementStage(input(), deps)).toMatchObject({ kind: 'skipped', line: 'allowance' });
    const failing = harness(session, { response: () => ({ kind: 'code', code: 'FAILED' }) });
    await runEnhancementStage(input(), failing.deps);
    expect(session.paused()).toBe(false);
    await runEnhancementStage(input(), failing.deps);
    expect(session.paused()).toBe(true);
  });
  it('stops without a state change when the token goes stale after an await', async () => {
    let live = true;
    const { deps } = harness(new EnhanceSession(() => 0));
    const status0 = deps.client.status;
    deps.client.status = async (signal) => { const value = await status0(signal); live = false; return value; };
    expect(await runEnhancementStage(input({ current: () => live }), deps)).toEqual({ kind: 'aborted' });
  });
  it('Skip keeps H1 with no line', async () => {
    const skip = new AbortController();
    const { deps } = harness(new EnhanceSession(() => 100));
    deps.client.enhance = async () => { skip.abort(); return { kind: 'code', code: 'FAILED' }; };
    expect(await runEnhancementStage(input({ skip: skip.signal }), deps)).toMatchObject({ kind: 'skipped', line: 'none' });
  });
});
