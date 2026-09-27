import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rm, appendFile, writeFile, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROBE, SLOTS, allocationId, assertRuntime, controlsDigest, executeSlot, fixture, initialize, main, operatorRoot, parseArguments,
  readRecord, reconcile, recover, summary, validateReceipt, verdict,
} from '../../scripts/ai-evaluation/stylist-probe.mjs';
import {
  AZURE_FIXED, AZURE_TARGET, azureCommands, azureEnvironment, launch, parseLauncherArguments, probeEnvironment, runAzure, runChild,
} from '../../scripts/ai-evaluation/stylist-probe-launch.mjs';
import {
  STYLIST_BODY_CONTROLS, STYLIST_ENDPOINT, STYLIST_LIMITS, STYLIST_RESERVATION_MICRO, buildStylistRequest, parseStylistBody, utf8Bytes,
} from '../../src/domain/stylist.ts';

const COMMIT = 'a'.repeat(40);
const RUNTIME = { versions: { node: readFileSync('.node-version', 'utf8').trim() }, execArgv: [] };
const source = () => COMMIT;
const KEY = 'probe-key-SENTINEL-0123456789abcdef';
const OCTOBER = Date.parse('2026-10-05T10:00:00.000Z');
const NOVEMBER = Date.parse('2026-11-01T00:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const receipt = (overrides: Record<string, unknown> = {}) => ({
  kind: 'stylist-probe-allocation-v1', ownerRef: 'b'.repeat(64), allocationMicro: '260000',
  reply: { code: 'OK', previousTotalMicro: '20000000', newTotalMicro: '19740000' },
  readBack: { monthlyAllowanceMicro: '19740000', stylistMonthlyAllowanceMicro: '5000000' },
  allocatedAt: '2026-10-05T09:00:00.000Z',
  approvalRef: 'https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-5858903412', ...overrides,
});
type Reply = { input?: number; output?: number; reasoning?: number; cacheRead?: number; model?: string; content?: string;
  message?: Record<string, unknown>; choice?: Record<string, unknown>; extra?: Record<string, unknown>; usage?: unknown; contentType?: string };
function response(reply: Reply = {}) {
  const input = reply.input ?? 900, output = reply.output ?? 120;
  const usage = reply.usage !== undefined ? reply.usage : { prompt_tokens: input, completion_tokens: output, total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: reply.cacheRead ?? 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: reply.reasoning ?? 40 } };
  const content = reply.content ?? JSON.stringify({ reply: 'Try these.', outfits: [{ refs: ['i1', 'i2', 'i3'], note: '' }] });
  return new Response(JSON.stringify({ model: reply.model ?? 'gpt-5.6-terra-2026-07-09',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null, ...reply.message }, ...reply.choice }],
    ...(usage === null ? {} : { usage }), ...reply.extra }), { status: 200, headers: { 'content-type': reply.contentType ?? 'application/json' } });
}
type Call = { url: string; init: RequestInit };
function provider(replies: Array<Reply | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return response(next);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'st-op-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const init = (overrides: Record<string, unknown> = {}, now = OCTOBER) => initialize({ root, receipt: receipt(overrides), now: () => now, source });
const send = (id: string, slot: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  executeSlot({ root, id, slot, key: KEY, fetchImpl, now: () => OCTOBER, source, ...extra });
const ledger = (id: string) => readFile(path.join(root, id, 'probe.jsonl'), 'utf8');
const record = (id: string) => readRecord({ root, id, source });

describe('ST-OP fixtures are valid production inputs', () => {
  it('pass the closed body, ingress, conversation, item and eligibility checks and match the production builder', () => {
    for (const slot of SLOTS) {
      const { input, built, ingressBytes, conversationBytes } = fixture(slot);
      expect(parseStylistBody(JSON.parse(JSON.stringify(input)))).toEqual(input);
      expect(ingressBytes).toBeLessThanOrEqual(STYLIST_LIMITS.bodyBytes);
      expect(conversationBytes).toBeLessThanOrEqual(STYLIST_LIMITS.conversationBytes);
      expect(Object.keys(built.body).sort()).toEqual([...Object.keys(STYLIST_BODY_CONTROLS), 'messages', 'response_format'].sort());
      expect(built.body.prompt_cache_options).toEqual({ mode: 'explicit' });
      expect((built.body.messages as unknown[]).length).toBeLessThanOrEqual(STYLIST_LIMITS.messageCount);
      expect(built.messagesBytes).toBe(utf8Bytes(JSON.stringify(built.body.messages)));
      expect(built.trimmedOutfits).toBe(0);
      expect(JSON.stringify(fixture(slot).built.body)).toBe(JSON.stringify(built.body));
      // Field minimisation: no request ID and no item ID reaches the provider, only aliases.
      expect(JSON.stringify(built.body)).not.toMatch(UUID);
    }
  });

  it('tunes the max request offline to 19,950–20,000 message bytes at the message, history and reference limits', () => {
    const { input, built } = fixture('max');
    expect(built.messagesBytes).toBeGreaterThanOrEqual(19950);
    expect(built.messagesBytes).toBeLessThanOrEqual(STYLIST_LIMITS.messagesBytes);
    expect((built.body.messages as unknown[]).length).toBe(STYLIST_LIMITS.messageCount);
    expect([...input.message].length).toBe(STYLIST_LIMITS.message);
    expect(input.message).toMatch(/["\\\n]/);
    expect(utf8Bytes(input.message)).toBeGreaterThan(3 * STYLIST_LIMITS.message);
    expect(input.history).toHaveLength(STYLIST_LIMITS.historyTurns);
    const refs = input.history.flatMap((turn) => (turn.role === 'assistant' ? turn.outfits ?? [] : []).flat());
    expect(refs).toHaveLength(STYLIST_LIMITS.historyOutfitRefs);
    expect(new Set(refs).size).toBeLessThan(refs.length);
    expect(built.included + built.omitted).toBe(STYLIST_LIMITS.items);
    expect(buildStylistRequest(input, [])).toBeTruthy();
  });

  it('keeps the minimum request small, with no history or weather', () => {
    const { input, built } = fixture('min');
    expect(input.history).toEqual([]);
    expect(input.weather).toBeNull();
    expect(built.included).toBe(3);
    expect(built.messagesBytes).toBeLessThan(5000);
  });
});

describe('ST-OP allocation receipt', () => {
  it('accepts the D1 reply and read-back, and binds USD 0.26 to exactly two reservations', () => {
    expect(validateReceipt(receipt())).toBeTruthy();
    expect(PROBE.minAllocationMicro).toBe(2 * Number(STYLIST_RESERVATION_MICRO));
    expect(validateReceipt(receipt({ allocationMicro: '258720', reply: { code: 'OK', previousTotalMicro: '20000000', newTotalMicro: '19741280' },
      readBack: { monthlyAllowanceMicro: '19741280', stylistMonthlyAllowanceMicro: '5000000' } }))).toBeTruthy();
  });
  it.each([
    ['arithmetic', { reply: { code: 'OK', previousTotalMicro: '20000000', newTotalMicro: '19700000' } }, 'RECEIPT_ARITHMETIC'],
    ['over USD 0.26', { allocationMicro: '260001', reply: { code: 'OK', previousTotalMicro: '20000001', newTotalMicro: '19740000' } }, 'RECEIPT_ARITHMETIC'],
    ['under two reservations', { allocationMicro: '258719', reply: { code: 'OK', previousTotalMicro: '19998719', newTotalMicro: '19740000' } }, 'RECEIPT_ARITHMETIC'],
    ['read-back', { readBack: { monthlyAllowanceMicro: '20000000', stylistMonthlyAllowanceMicro: '5000000' } }, 'RECEIPT_ARITHMETIC'],
    ['DEFER', { reply: { code: 'DEFER', previousTotalMicro: '20000000', newTotalMicro: '19740000' } }, 'RECEIPT_INVALID'],
    ['raw owner', { ownerRef: '30000000-0000-4000-8000-000000000000' }, 'RECEIPT_INVALID'],
    ['approval', { approvalRef: 'https://example.com/84' }, 'RECEIPT_INVALID'],
    ['time', { allocatedAt: '2026-10-05' }, 'RECEIPT_INVALID'],
  ])('refuses %s', (_, overrides, code) => {
    expect(() => validateReceipt(receipt(overrides))).toThrow(code);
  });
  it('refuses an extra field', () => {
    expect(() => validateReceipt({ ...receipt(), note: 'x' })).toThrow('RECEIPT_INVALID');
  });
});

describe('ST-OP canonical run record (H1)', () => {
  it('creates one record per allocation and refuses the same receipt again', async () => {
    const id = await init();
    expect(id).toBe(allocationId(validateReceipt(receipt())));
    await expect(init()).rejects.toThrow('ALLOCATION_ALREADY_RECORDED');
    // A copy with another approval link or time in the same month is the same hosted transition.
    await expect(init({ approvalRef: 'https://github.com/drrowdev/stillroom-wardrobe/pull/90#issuecomment-1', allocatedAt: '2026-10-05T09:30:00.000Z' }))
      .rejects.toThrow('ALLOCATION_ALREADY_RECORDED');
  });

  it('lets exactly one of several simultaneous inits win', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => init()));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') expect(String(result.reason)).toMatch(/ALLOCATION_ALREADY_RECORDED|LOCKED/);
  });

  it('refuses a second init from another process and working directory', async () => {
    const module = path.resolve('scripts/ai-evaluation/stylist-probe.mjs');
    const other = await mkdtemp(path.join(tmpdir(), 'st-op-cwd-'));
    const program = `import(${JSON.stringify(new URL(`file:///${module.replace(/\\/g, '/')}`).href)}).then((m) => m.initialize({ root: ${JSON.stringify(root)},
      receipt: ${JSON.stringify(receipt())}, now: () => ${OCTOBER}, source: () => '${COMMIT}' })).then(() => console.log('OK'), (e) => console.log(e.code))`;
    const run = (cwd: string) => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('exit', () => resolve(out.trim()));
    });
    try {
      const outputs = await Promise.all([run(process.cwd()), run(other)]);
      expect(outputs.sort()).toEqual(['ALLOCATION_ALREADY_RECORDED', 'OK']);
      expect(await run(tmpdir())).toBe('ALLOCATION_ALREADY_RECORDED');
    } finally { await rm(other, { recursive: true, force: true }); }
  }, 30000);

  it('uses one fixed operator root, independent of the working directory', () => {
    expect(path.isAbsolute(operatorRoot())).toBe(true);
    expect(operatorRoot()).toMatch(/[\\/]\.stillroom-operator[\\/]stylist-probe$/);
  });

  it('refuses a root inside the repository or an agent session folder', async () => {
    await expect(initialize({ root: path.resolve('test-results', 'st-op-root'), receipt: receipt(), now: () => OCTOBER, source }))
      .rejects.toThrow('PRIVATE_PATH_IN_REPOSITORY');
    await expect(initialize({ root: path.join(root, '.copilot', 'session-state', 'x'), receipt: receipt(), now: () => OCTOBER, source }))
      .rejects.toThrow('PRIVATE_PATH_IN_AGENT_SESSION');
    await rm(path.resolve('test-results', 'st-op-root'), { recursive: true, force: true });
  });

  it('refuses a symlinked record', async () => {
    const id = await init();
    const real = path.join(root, 'real');
    await mkdir(real);
    const linked = path.join(root, 'linked');
    try { await symlink(real, linked, 'junction'); } catch { return; }
    await rmdir(linked).catch(() => {});
    await rm(path.join(root, id), { recursive: true });
    await symlink(real, path.join(root, id), 'junction');
    await expect(record(id)).rejects.toThrow('PRIVATE_PATH_INVALID');
  });

  it('refuses init outside the allocation month, with a future receipt or after the review expiry', async () => {
    await expect(init({}, NOVEMBER)).rejects.toThrow('ALLOCATION_MONTH_ENDED');
    await expect(init({}, Date.parse('2026-10-05T08:00:00.000Z'))).rejects.toThrow('RECEIPT_INVALID');
    await expect(init({ allocatedAt: '2026-12-01T00:00:00.000Z' }, Date.parse('2026-12-01T00:00:01.000Z'))).rejects.toThrow('REVIEW_EXPIRED');
  });
});

describe('ST-OP dispatch', () => {
  it('sends the exact production body with the key only in the header, then min and max, and passes calibration', async () => {
    const id = await init();
    const { calls, fetchImpl } = provider([{}, { input: 20000, output: 200 }]);
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('VALID_MIN_REQUIRED');
    expect((await send(id, 'min', fetchImpl)).state).toBe('OK');
    expect((await send(id, 'max', fetchImpl)).state).toBe('OK');
    expect(calls.map((call) => call.url)).toEqual([STYLIST_ENDPOINT, STYLIST_ENDPOINT]);
    for (const [index, slot] of SLOTS.entries()) {
      const call = calls[index]!;
      expect(call.init.method).toBe('POST');
      expect(call.init.redirect).toBe('error');
      expect(call.init.body).toBe(JSON.stringify(fixture(slot).built.body));
      expect((call.init.headers as Record<string, string>)['api-key']).toBe(KEY);
    }
    const state = await record(id);
    expect(verdict(state)).toBe('PASS');
    const out = summary(state);
    expect(out.consumedMicro).toBe('258720');
    expect(out.slots.max.messagesBytes).toBe(fixture('max').built.messagesBytes);
    expect(out.slots.min.estimateMicro).toBe(String(Math.ceil((900 * 220 + 120 * 1320) / 100)));
    expect(out.notes.meaning).toMatch(/Not a token-bound proof, a quality evaluation, an RLS test or a hosted Edge test/);
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('SLOT_CONSUMED');
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('SLOT_CONSUMED');
    expect(calls).toHaveLength(2);
  });

  it('reports REVISE_ENVELOPE when the max request used more than 20,000 input tokens', async () => {
    const id = await init();
    const { fetchImpl } = provider([{}, { input: 20001 }]);
    await send(id, 'min', fetchImpl);
    await send(id, 'max', fetchImpl);
    expect(verdict(await record(id))).toBe('REVISE_ENVELOPE');
  });

  it('keeps tool-shaped text in the reply as inert text', async () => {
    const id = await init();
    const content = JSON.stringify({ reply: '{"tool_calls":[{"function":{"name":"save_outfit"}}]}', outfits: [] });
    const { fetchImpl } = provider([{ content }]);
    expect((await send(id, 'min', fetchImpl)).state).toBe('OK');
  });

  it.each<[string, Reply, string, string]>([
    ['a genuine refusal', { message: { refusal: 'I cannot help with that.', content: null } }, 'FAILED', 'FILTERED'],
    ['a content filter', { choice: { finish_reason: 'content_filter' } }, 'FAILED', 'FILTERED'],
    ['tool calls', { message: { tool_calls: [{ id: 'x', type: 'function' }] }, choice: { finish_reason: 'tool_calls' } }, 'FAILED', 'RESPONSE_FAILED'],
    ['an invalid reply', { content: 'not json' }, 'FAILED', 'REPLY_INVALID'],
    ['missing usage', { usage: null }, 'HALTED', 'USAGE_INVALID'],
    ['a total mismatch', { usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 1 } } }, 'HALTED', 'USAGE_INVALID'],
    ['reasoning above output', { reasoning: 121 }, 'HALTED', 'USAGE_INVALID'],
    ['a cache read', { cacheRead: 10 }, 'HALTED', 'CONTROL_ANOMALY'],
    ['a contradictory control', { extra: { service_tier: 'priority' } }, 'HALTED', 'CONTROL_ANOMALY'],
    ['an unrecognised model', { model: 'gpt-5.6-sol-2026-07-09' }, 'HALTED', 'MODEL_ANOMALY'],
    ['input above the envelope', { input: 24001 }, 'HALTED', 'INPUT_ENVELOPE'],
    ['output above the envelope', { output: 1201, reasoning: 0 }, 'HALTED', 'OUTPUT_ENVELOPE'],
    ['a non-JSON response', { contentType: 'text/html' }, 'HALTED', 'RESPONSE_UNUSABLE'],
  ])('records %s and then refuses max', async (_, reply, state, reason) => {
    const id = await init();
    const { calls, fetchImpl } = provider([reply]);
    const observation = await send(id, 'min', fetchImpl);
    expect([observation.state, observation.reason]).toEqual([state, reason]);
    if (reason === 'USAGE_INVALID') expect(observation.estimateMicro).toBeNull();
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('VALID_MIN_REQUIRED');
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('SLOT_CONSUMED');
    expect(calls).toHaveLength(1);
    expect(verdict(await record(id))).toBe('HALTED');
  });

  it('records a transport failure or timeout as counted uncertainty, never retried', async () => {
    const id = await init();
    const { calls, fetchImpl } = provider([new Error('reset')]);
    expect((await send(id, 'min', fetchImpl)).reason).toBe('NETWORK_UNCERTAIN');
    expect(calls).toHaveLength(1);
    await expect(reconcile({ root, id, slot: 'min', source })).rejects.toThrow('NOTHING_TO_RECONCILE');
    expect(summary(await record(id)).consumedMicro).toBe(STYLIST_RESERVATION_MICRO);

    const other = await init({ ownerRef: 'c'.repeat(64) });
    const hanging = ((_url: string, request: RequestInit) => new Promise((_, reject) => {
      request.signal!.addEventListener('abort', () => reject(request.signal!.reason));
    })) as unknown as typeof fetch;
    expect((await send(other, 'min', hanging, { requestMs: 30 })).reason).toBe('NETWORK_UNCERTAIN');
  });
});

describe('ST-OP month, review and persistence (M3)', () => {
  it('refuses before the intent in the next month, spending nothing', async () => {
    const id = await init();
    const { calls, fetchImpl } = provider([{}]);
    await expect(send(id, 'min', fetchImpl, { now: () => NOVEMBER })).rejects.toThrow('ALLOCATION_MONTH_ENDED');
    expect(calls).toHaveLength(0);
    expect(summary(await record(id)).slots.min.state).toBe('UNUSED');
  });

  it.each([
    ['a month rollover', '2026-10-31T23:59:59.999Z', '2026-11-01T00:00:00.000Z', 'ALLOCATION_MONTH_ENDED', '2026-10-05T09:00:00.000Z'],
    ['the review expiry', '2026-11-30T23:59:59.999Z', '2026-12-01T00:00:00.000Z', 'REVIEW_EXPIRED', '2026-11-02T09:00:00.000Z'],
  ])('rechecks after the durable intent: %s records NOT_SENT and consumes the slot', async (_, before, after, reason, allocatedAt) => {
    const id = await init({ allocatedAt }, Date.parse(before));
    const { calls, fetchImpl } = provider([{}]);
    let n = 0;
    const now = () => (n++ < 2 ? Date.parse(before) : Date.parse(after));
    const observation = await send(id, 'min', fetchImpl, { now });
    expect([observation.state, observation.reason]).toEqual(['NOT_SENT', reason]);
    expect(calls).toHaveLength(0);
    await expect(send(id, 'min', fetchImpl, { now: () => Date.parse(before) })).rejects.toThrow('SLOT_CONSUMED');
    await expect(send(id, 'max', fetchImpl, { now: () => Date.parse(before) })).rejects.toThrow('VALID_MIN_REQUIRED');
    expect(verdict(await record(id))).toBe('HALTED');
  });

  /** Fails the Nth ledger open's sync or close; the bytes are still written, so the line looks complete. */
  const failingLedger = (failOn: number, stage: 'sync' | 'close' = 'sync') => {
    let opens = 0;
    return { open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (!String(args[0]).endsWith('probe.jsonl') || ++opens !== failOn) return handle;
      return { writeFile: handle.writeFile.bind(handle), truncate: handle.truncate.bind(handle),
        sync: stage === 'sync' ? async () => { throw new Error('EIO'); } : handle.sync.bind(handle),
        close: stage === 'close' ? async () => { await handle.close(); throw new Error('EIO'); } : handle.close.bind(handle) };
    } };
  };
  const lock = (id: string) => path.join(root, id, 'probe.lock');
  const pending = (id: string) => path.join(root, id, 'probe.pending');

  it('does not dispatch when the intent sync fails, and only an explicit recovery counts the slot', async () => {
    const id = await init();
    const { calls, fetchImpl } = provider([{}]);
    await expect(send(id, 'min', fetchImpl, { fs: failingLedger(1) })).rejects.toThrow('LEDGER_WRITE_UNCERTAIN');
    expect(calls).toHaveLength(0);
    expect(verdict(await record(id))).toBe('UNRESOLVED');
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await rmdir(lock(id));
    expect(summary(await record(id)).persistence).toEqual({ pending: true, locked: false });
    expect(verdict(await record(id))).toBe('UNRESOLVED');
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await expect(reconcile({ root, id, slot: 'min', source })).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await expect(recover({ root, id, slot: 'max', source })).rejects.toThrow('RECOVERY_SLOT_MISMATCH');
    await recover({ root, id, slot: 'min', source });
    const state = await record(id);
    expect(state.persistence).toEqual({ pending: false, locked: false });
    expect(summary(state).slots.min).toMatchObject({ state: 'COUNTED', recovered: true });
    expect(summary(state).consumedMicro).toBe(STYLIST_RESERVATION_MICRO);
    expect(verdict(state)).toBe('HALTED');
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('SLOT_CONSUMED');
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('VALID_MIN_REQUIRED');
    await expect(reconcile({ root, id, slot: 'min', source })).rejects.toThrow('NOTHING_TO_RECONCILE');
    await expect(recover({ root, id, slot: 'min', source })).rejects.toThrow('NOTHING_TO_RECOVER');
    expect(calls).toHaveLength(0);
  });

  it.each(['sync', 'close'] as const)('never shows PASS for a complete-looking max result after a failed %s', async (stage) => {
    const id = await init();
    const { calls, fetchImpl } = provider([{}, {}]);
    await send(id, 'min', fetchImpl);
    // The max call's ledger opens are the intent (1) and the result (2).
    await expect(send(id, 'max', fetchImpl, { fs: failingLedger(2, stage) })).rejects.toThrow('LEDGER_WRITE_UNCERTAIN');
    expect(calls).toHaveLength(2);
    expect(await ledger(id)).toContain('"type":"result","slot":"max"');
    // Status, then a restart with the lock removed by hand: still unresolved, and nothing can continue.
    expect(summary(await record(id)).verdict).toBe('UNRESOLVED');
    await rmdir(lock(id));
    const restarted = await readRecord({ root, id, source });
    expect(restarted.persistence).toEqual({ pending: true, locked: false });
    expect(verdict(restarted)).toBe('UNRESOLVED');
    await expect(reconcile({ root, id, slot: 'max', source })).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await expect(send(id, 'min', fetchImpl)).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await recover({ root, id, slot: 'max', source });
    const state = await record(id);
    expect(summary(state).slots.max).toMatchObject({ state: 'COUNTED', recovered: true });
    expect(summary(state).slots.min.state).toBe('OK');
    expect(verdict(state)).toBe('HALTED');
    await expect(reconcile({ root, id, slot: 'max', source })).rejects.toThrow('NOTHING_TO_RECONCILE');
    await expect(send(id, 'max', fetchImpl)).rejects.toThrow('SLOT_CONSUMED');
    expect(calls).toHaveLength(2);
  });

  it('recovers from a torn final line and re-syncs a recovery line whose own sync failed', async () => {
    const id = await init();
    const { fetchImpl } = provider([{}]);
    await expect(send(id, 'min', fetchImpl, { fs: failingLedger(2) })).rejects.toThrow('LEDGER_WRITE_UNCERTAIN');
    await appendFile(path.join(root, id, 'probe.jsonl'), '{"type":"res');
    await expect(record(id)).rejects.toThrow('PERSISTENCE_UNCERTAIN');
    await expect(recover({ root, id, slot: 'min', source, fs: failingLedger(2) })).rejects.toThrow('LEDGER_WRITE_UNCERTAIN');
    expect((await record(id)).slots.min?.recovered).toBe(true);
    expect(verdict(await record(id))).toBe('UNRESOLVED');
    await recover({ root, id, slot: 'min', source });
    const state = await record(id);
    expect(state.persistence).toEqual({ pending: false, locked: false });
    expect((await ledger(id)).match(/"type":"recover"/g)).toHaveLength(1);
    expect(verdict(state)).toBe('HALTED');
  });

  it('treats an unconfirmed init as an unusable allocation', async () => {
    const id = await init();
    await writeFile(pending(id), '{"type":"init","slot":null}\n');
    await expect(record(id)).rejects.toThrow('ALLOCATION_UNUSABLE');
    await expect(recover({ root, id, slot: 'min', source })).rejects.toThrow('ALLOCATION_UNUSABLE');
  });

  it('refuses a torn line, changed controls, a changed source commit and a tampered intent', async () => {
    const id = await init();
    const file = path.join(root, id, 'probe.jsonl');
    const original = await readFile(file, 'utf8');
    await expect(readRecord({ root, id, source: () => 'b'.repeat(40) })).rejects.toThrow('SOURCE_CHANGED');
    await appendFile(file, '{"type":"intent"');
    await expect(record(id)).rejects.toThrow('LEDGER_TORN');
    await writeFile(file, original.replace(/"controls":"[a-f0-9]{64}"/, `"controls":"${'0'.repeat(64)}"`));
    await expect(record(id)).rejects.toThrow('LEDGER_CONFIG_CHANGED');
    const intent = { type: 'intent', slot: 'min', bodyDigest: JSON.parse(original).bodies.min, valuationMicro: PROBE.valuationMicro,
      cumulativeMicro: 2 * PROBE.valuationMicro, time: '2026-10-05T10:00:00.000Z' };
    await writeFile(file, `${original}${JSON.stringify(intent)}\n`);
    await expect(record(id)).rejects.toThrow('LEDGER_INVALID');
    expect(JSON.parse(original).controls).toBe(controlsDigest());
  });
});

describe('ST-OP key and privacy', () => {
  it('refuses a missing or malformed key before any intent', async () => {
    const id = await init();
    const { calls, fetchImpl } = provider([{}]);
    for (const key of [undefined, '', 'short', `${KEY}\n`, `${KEY} x`]) {
      await expect(executeSlot({ root, id, slot: 'min', key, fetchImpl, now: () => OCTOBER, source })).rejects.toThrow('PRIVATE_KEY_REQUIRED');
    }
    expect(calls).toHaveLength(0);
    expect(summary(await record(id)).slots.min.state).toBe('UNUSED');
  });

  it('never stores or prints the key or the reply text', async () => {
    const id = await init();
    const content = JSON.stringify({ reply: `Echo ${KEY} private reply text`, outfits: [] });
    const { fetchImpl } = provider([{ content }, new Error(KEY)]);
    await send(id, 'min', fetchImpl);
    await send(id, 'max', fetchImpl);
    const text = `${await ledger(id)}${JSON.stringify(summary(await record(id)))}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('private reply text');
    expect(summary(await record(id)).slots.min.reply).toMatchObject({ bytes: utf8Bytes(content), valid: true });
  });

  it('has no Supabase client, hosted URL or database access', async () => {
    for (const file of ['scripts/ai-evaluation/stylist-probe.mjs', 'scripts/ai-evaluation/stylist-probe-launch.mjs']) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toMatch(/@supabase\/|createClient|\.supabase\.co|\/rest\/v1|SERVICE_ROLE|postgres/i);
    }
  });

  it('refuses extra arguments, unknown commands and ST0-style arms', () => {
    const id = 'd'.repeat(32);
    expect(parseArguments(['send', id, 'max'])).toEqual({ command: 'send', first: id, second: 'max' });
    for (const args of [['send', id, 'sol'], ['send', id, 'min', 'extra'], ['st0', id], ['send', 'x', 'min'], ['reconcile', id, 'min', 'known_not_sent']]) {
      expect(() => parseArguments(args)).toThrow('USAGE');
    }
  });

  it('requires the pinned Node without preload or tracing', async () => {
    const pinned = (await readFile('.node-version', 'utf8')).trim();
    expect(() => assertRuntime({ versions: { node: pinned }, execArgv: [], env: {} })).not.toThrow();
    expect(() => assertRuntime({ versions: { node: '24.0.0' }, execArgv: [], env: {} })).toThrow('PINNED_NODE_REQUIRED');
    expect(() => assertRuntime({ versions: { node: pinned }, execArgv: ['--inspect'], env: {} })).toThrow('TRACING_OR_PRELOAD_REFUSED');
    expect(() => assertRuntime({ versions: { node: pinned }, execArgv: [], env: { NODE_OPTIONS: '--require x' } })).toThrow('TRACING_OR_PRELOAD_REFUSED');
  });

  it.each([{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { TF_BUILD: 'True' }, { tf_build: 'True' }, { CI: '' }, { JENKINS_URL: 'x' }])(
    'refuses a recognised CI environment %o', (env) => {
      expect(() => assertRuntime({ ...RUNTIME, env })).toThrow('CI_ENVIRONMENT_REFUSED');
    });

  it('refuses CI in the probe entrypoint before any record, key or provider access', async () => {
    const id = await init();
    const before = await ledger(id);
    const { calls, fetchImpl } = provider([{}]);
    for (const command of [['send', id, 'min'], ['reconcile', id, 'min'], ['recover', id, 'min'], ['status', id]]) {
      const env: Record<string, string> = { GITHUB_ACTIONS: 'true', [PROBE.keyVariable]: KEY };
      await expect(main(command, { env, runtime: RUNTIME, root, fetchImpl, log: () => { throw new Error('no output'); } }))
        .rejects.toThrow('CI_ENVIRONMENT_REFUSED');
    }
    expect(calls).toHaveLength(0);
    expect(await ledger(id)).toBe(before);
  });

  it('loads the production modules under plain Node', async () => {
    const program = "import('./scripts/ai-evaluation/stylist-probe.mjs').then((m) => console.log(m.controlsDigest()))";
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { text += chunk; });
      child.on('exit', () => resolve(text.trim()));
    });
    expect(out).toBe(controlsDigest());
  }, 30000);
});

describe('ST-OP launcher (Q3)', () => {
  const SUBSCRIPTION = '01234567-89ab-cdef-0123-456789abcdef';
  const id = 'e'.repeat(32);
  const args = ['--subscription', SUBSCRIPTION, 'send', id, 'min'];
  const azure = (endpoint: string, key: string | Error) => {
    const calls: string[][] = [];
    const envs: Record<string, string>[] = [];
    return { calls, envs, run: async (command: string[], env: Record<string, string>) => {
      calls.push(command);
      envs.push(env);
      if (command.includes('show')) return JSON.stringify(endpoint);
      if (key instanceof Error) throw key;
      return JSON.stringify(key);
    } };
  };
  const ENDPOINT = 'https://stillroom-ai-eval.openai.azure.com/';
  const HOSTILE = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', AZURE_LOGGING_ENABLE_LOG_FILE: 'true', azure_logging_log_dir: 'C:\\logs',
    AZURE_CORE_ONLY_SHOW_ERRORS: 'false', AZURE_CORE_COLLECT_TELEMETRY: 'true', GIT_DIR: 'elsewhere', EDITOR: 'vi',
    AZURE_CONFIG_DIR: 'C:\\az', [PROBE.keyVariable]: 'inherited-old-key-value' };
  const noChild = async () => { throw new Error('child must not start'); };

  it('pins the resource and uses only a read of the endpoint and the key list', () => {
    const commands = azureCommands(SUBSCRIPTION);
    for (const command of Object.values(commands)) {
      expect(command).toEqual(expect.arrayContaining(['--subscription', SUBSCRIPTION, '--resource-group', AZURE_TARGET.resourceGroup,
        '--name', AZURE_TARGET.resource, '--only-show-errors']));
      expect(command.join(' ')).not.toMatch(/regenerate|role|assignment|--debug|--verbose|create|update|delete/);
    }
    expect(commands.keys.slice(0, 4)).toEqual(['cognitiveservices', 'account', 'keys', 'list']);
    expect(AZURE_TARGET).toEqual({ resourceGroup: 'rg-stillroom-ai-eval', resource: 'stillroom-ai-eval', keyName: 'key1' });
  });

  it('refuses malformed arguments, shell metacharacters and an az environment without the logging override', async () => {
    for (const bad of [['send', id, 'min'], ['--subscription', 'x', 'send', id, 'min'], [...args, 'extra'], ['--subscription', SUBSCRIPTION, 'init', id, 'min']]) {
      expect(() => parseLauncherArguments(bad)).toThrow('USAGE');
    }
    await expect(runAzure(['account', 'show', '&', 'calc'], azureEnvironment({}))).rejects.toThrow('USAGE');
    await expect(runAzure(['account', 'show'], {})).rejects.toThrow('UNSAFE_ENVIRONMENT');
  });

  it('builds narrow child environments that override hostile inherited logging settings', () => {
    const az = azureEnvironment(HOSTILE);
    expect(az).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', AZURE_CONFIG_DIR: 'C:\\az', ...AZURE_FIXED });
    expect(az.AZURE_LOGGING_ENABLE_LOG_FILE).toBe('false');
    expect(az.AZURE_CORE_ONLY_SHOW_ERRORS).toBe('true');
    expect(probeEnvironment(HOSTILE, KEY)).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', [PROBE.keyVariable]: KEY });
  });

  it.each(['AZURE_CLI_DISABLE_CONNECTION_VERIFICATION', 'requests_ca_bundle', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'ADAL_PYTHON_SSL_NO_VERIFY',
    'PYTHONHTTPSVERIFY', 'SSLKEYLOGFILE', 'PYTHONPATH', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED'])(
    'refuses an inherited %s with a fixed code before either Azure CLI call', async (name) => {
      const fake = azure(ENDPOINT, KEY);
      await expect(launch(args, { azure: fake.run, child: noChild, baseEnv: { PATH: 'x', [name]: '0' }, runtime: RUNTIME }))
        .rejects.toThrow(/^(UNSAFE_ENVIRONMENT|TRACING_OR_PRELOAD_REFUSED)$/);
      expect(fake.calls).toHaveLength(0);
    });

  it.each([{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { TF_BUILD: 'True' }])('refuses CI %o before key retrieval', async (env) => {
    const fake = azure(ENDPOINT, KEY);
    await expect(launch(args, { azure: fake.run, child: noChild, baseEnv: { PATH: 'x', ...env }, runtime: RUNTIME }))
      .rejects.toThrow('CI_ENVIRONMENT_REFUSED');
    expect(fake.calls).toHaveLength(0);
  });

  it('passes the key only in the child environment and clears it afterwards', async () => {
    const fake = azure(ENDPOINT, KEY);
    const seen: { env?: Record<string, string | undefined>; args?: string[]; snapshot?: Record<string, string | undefined> } = {};
    const code = await launch(args, { azure: fake.run, baseEnv: HOSTILE, runtime: RUNTIME, child: async (env, childArgs) => {
      Object.assign(seen, { env, args: childArgs, snapshot: { ...env } });
      return 0;
    } });
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(2);
    for (const env of fake.envs) expect(env).toEqual(azureEnvironment(HOSTILE));
    expect(seen.snapshot).toEqual(probeEnvironment(HOSTILE, KEY));
    expect(seen.args).toEqual(['send', id, 'min']);
    expect(seen.args!.join(' ')).not.toContain(KEY);
    expect(seen.env![PROBE.keyVariable]).toBeUndefined();
    expect(HOSTILE[PROBE.keyVariable]).toBe('inherited-old-key-value');
  });

  const osBase = () => Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT })
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

  it('runs az as a real subprocess with exactly the narrow environment', async () => {
    const hostile = { ...osBase(), AZURE_LOGGING_ENABLE_LOG_FILE: 'true', AZURE_CORE_ONLY_SHOW_ERRORS: 'false', NODE_DEBUG: 'x', GIT_DIR: 'y' };
    const script = 'process.stdout.write(JSON.stringify({ env: process.env, args: process.argv.slice(1) }))';
    const out = JSON.parse(await runAzure(['account', 'show'], azureEnvironment(hostile), { file: process.execPath, prefix: ['-e', script] }));
    expect(out.args).toEqual(['account', 'show']);
    expect(out.env.AZURE_LOGGING_ENABLE_LOG_FILE).toBe('false');
    expect(out.env.AZURE_CORE_ONLY_SHOW_ERRORS).toBe('true');
    for (const name of ['NODE_DEBUG', 'GIT_DIR', PROBE.keyVariable]) expect(out.env[name]).toBeUndefined();
    await expect(runAzure(['account', 'show'], azureEnvironment(osBase()), { file: process.execPath, prefix: ['-e', 'process.exit(2)'] }))
      .rejects.toThrow(/^AZURE_CLI_FAILED$/);
  }, 30000);

  it('reports the real child exit code, maps a start failure to 1, and clears the key after a child failure', async () => {
    const check = `process.exit(process.env.${PROBE.keyVariable} === ${JSON.stringify(KEY)} && !process.env.GIT_DIR ? 3 : 9)`;
    const fake = azure(ENDPOINT, KEY);
    let passed: Record<string, string | undefined> | undefined;
    const code = await launch(args, { azure: fake.run, baseEnv: { ...osBase(), GIT_DIR: 'y' }, runtime: RUNTIME, child: (env, childArgs) => {
      passed = env;
      return runChild(env, childArgs, { file: process.execPath, prefix: ['-e', check] });
    } });
    expect(code).toBe(3);
    expect(passed![PROBE.keyVariable]).toBeUndefined();
    expect(await runChild(probeEnvironment(osBase(), KEY), ['send', id, 'min'], { file: path.join(root, 'missing-node'), prefix: [] })).toBe(1);
  }, 30000);

  it('stops with fixed errors on another resource or a failed key retrieval, never trying anything else', async () => {
    const other = azure('https://another.openai.azure.com/', KEY);
    await expect(launch(args, { azure: other.run, child: noChild, baseEnv: {}, runtime: RUNTIME })).rejects.toThrow(/^RESOURCE_MISMATCH$/);
    expect(other.calls).toHaveLength(1);
    const failed = azure(ENDPOINT, new Error(`az leaked ${KEY}`));
    const error = await launch(args, { azure: failed.run, child: noChild, baseEnv: {}, runtime: RUNTIME }).catch((e: Error) => e);
    expect((error as Error).message).toBe('KEY_RETRIEVAL_FAILED');
    expect(failed.calls).toHaveLength(2);
    const malformed = azure(ENDPOINT, `${KEY} with space`);
    const bad = await launch(args, { azure: malformed.run, child: noChild, baseEnv: {}, runtime: RUNTIME }).catch((e: Error) => e);
    expect((bad as Error).message).toBe('KEY_RETRIEVAL_FAILED');
  });
});
