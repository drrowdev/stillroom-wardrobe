import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, mkdir, rm, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  POLICY, PilotError, digest, schema, validFacts, requestBody, validateApproval,
  controlsDigest, initialize, readLedger, abandon, summary, inspectResponse, executeSlot,
} from './azure-garments.mjs';

const SYNTHETIC = Buffer.from('synthetic text only; not a JPEG or private input');
const FAKE_KEY = 'synthetic-test-value-not-a-credential';
function facts() {
  return { outcome: 'ready', fields: {
    category: 'top', subcategory: null, colours: ['navy'], pattern: 'solid',
    sleeve_length: 'long', garment_length: 'regular', brand: null, size_label: null,
    upper_coverage: 0, lower_coverage: null, material: 'knitted fabric',
    seasons: [], formality: 0, style_tags: [],
  } };
}
function approval() {
  return {
    policy: POLICY.id, endpoint: POLICY.endpoint,
    photo: { path: path.join(tmpdir(), 'synthetic-unused-path.txt'), sha256: digest(SYNTHETIC), bytes: SYNTHETIC.length, width: 1, height: 1 },
    approvals: { privateLocalDirectory: true, preparedPhotoAndPixels: true, azurePrivacyNotice: true,
      resourceAndDeployments: true, operationalBudgetRisk: true, ownerOnlyExecution: true },
  };
}
function envelope(arm = 'terra') {
  return {
    model: `gpt-5.6-${arm}`, choices: [{
      index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(facts()), refusal: null },
    }],
    usage: { prompt_tokens: 3000, completion_tokens: 500, total_tokens: 3500,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 200, audio_tokens: null, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } },
  };
}
function reply(data = envelope()) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(data)) };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stillroom-p2-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initialize(directory, approval());
  return directory;
}
function options(directory, overrides = {}) {
  return { directory, arm: 'terra', key: FAKE_KEY,
    readPhoto: async () => SYNTHETIC, sender: async () => reply(), ...overrides };
}

test('fixed requests are independent and contain only the reviewed controls', () => {
  for (const arm of ['terra', 'sol']) {
    const body = requestBody(arm, '[synthetic inline marker]');
    assert.equal(body.model, `eval-${arm}-20260709`);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[1].content.length, 1);
    assert.equal(body.messages[1].content[0].image_url.detail, 'high');
    assert.equal(body.n, 1);
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.max_completion_tokens, 2048);
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit' });
    for (const absent of ['tools', 'previous_response_id', 'temperature', 'top_p', 'prompt_cache_key']) {
      assert.equal(Object.hasOwn(body, absent), false);
    }
    assert.match(body.messages[0].content, /Material, seasons, formality and style are estimates/);
    assert.match(body.messages[0].content, /dominant colour first/);
    assert.equal(body.response_format.json_schema.strict, true);
  }
  assert.equal(controlsDigest().length, 64);
  assert.throws(() => requestBody('other', ''), /INVALID_ARM/);
});

test('Azure schema requires all fourteen fields and uses supported constraints', () => {
  const s = schema();
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.fields.additionalProperties, false);
  assert.equal(s.properties.fields.required.length, 14);
  assert.deepEqual(s.properties.fields.required, Object.keys(s.properties.fields.properties));
  assert.doesNotMatch(JSON.stringify(s), /maxLength|maxItems|minimum|maximum|uniqueItems/);
  assert.ok(s.properties.fields.properties.formality.enum.includes(0));
  assert.ok(s.properties.fields.properties.category.enum.includes(null));
});

test('domain checks preserve unknown, zero, estimates and exact field boundaries', () => {
  assert.equal(validFacts(facts()), true);
  const unknown = facts();
  unknown.outcome = 'unclear';
  for (const key of Object.keys(unknown.fields)) unknown.fields[key] = ['colours', 'seasons', 'style_tags'].includes(key) ? [] : null;
  assert.equal(validFacts(unknown), true);
  unknown.fields.formality = 0;
  assert.equal(validFacts(unknown), false);
  for (const change of [
    (f) => { delete f.fields.brand; },
    (f) => { f.fields.warmth = 3; },
    (f) => { f.fields.brand = ''; },
    (f) => { f.fields.brand = 'x'.repeat(101); },
    (f) => { f.fields.size_label = '\0'; },
    (f) => { f.fields.category = 'shirt'; },
    (f) => { f.fields.colours = ['navy', 'navy']; },
    (f) => { f.fields.colours = ['black', 'white', 'navy', 'blue']; },
    (f) => { f.fields.seasons = ['monsoon']; },
    (f) => { f.fields.style_tags = ['x'.repeat(41)]; },
    (f) => { f.fields.style_tags = Array.from({ length: 9 }, (_, i) => `${i}`); },
    (f) => { f.fields.formality = 5; },
    (f) => { f.fields.upper_coverage = -1; },
    (f) => { f.fields.lower_coverage = 1.5; },
  ]) {
    const value = facts(); change(value);
    assert.equal(validFacts(value), false);
  }
  const unicode = facts();
  unicode.fields.brand = '\u00e5'.repeat(100);
  assert.equal(validFacts(unicode), true);
});

test('approval has a fixed endpoint and explicit operator gates', () => {
  assert.equal(validateApproval(approval()).policy, POLICY.id);
  for (const change of [
    (a) => { a.endpoint = 'https://example.test'; },
    (a) => { a.approvals.operationalBudgetRisk = false; },
    (a) => { delete a.approvals.preparedPhotoAndPixels; },
    (a) => { a.photo.width = 1601; },
    (a) => { a.photo.bytes = 512001; },
    (a) => { a.photo.sha256 = 'missing'; },
    (a) => { a.photo.path = 'relative.txt'; },
  ]) {
    const a = approval(); change(a);
    assert.throws(() => validateApproval(a), PilotError);
  }
});

test('response reports configured-family identity without asserting snapshot equivalence', () => {
  const result = inspectResponse(reply(), 'terra');
  assert.equal(result.state, 'SUCCESS');
  assert.equal(result.returnedModel, 'gpt-5.6-terra');
  assert.equal(result.usage.reasoning, 200);
  assert.equal(result.usage.output, 500);
  assert.equal(result.usage.total, 3500);
  assert.deepEqual(result.facts, facts());
  const dated = envelope(); dated.model = 'gpt-5.6-terra-2026-07-09';
  dated.choices[0].message.tool_calls = null;
  dated.choices[0].message.function_call = null;
  assert.equal(inspectResponse(reply(dated), 'terra').state, 'SUCCESS');
});

test('refusal/truncation/filtering remain failures, not wrong semantic labels', () => {
  for (const [finish, refusal, reason] of [
    ['length', null, 'TRUNCATED'], ['content_filter', null, 'FILTERED'], ['stop', 'synthetic refusal', 'REFUSED'],
  ]) {
    const data = envelope();
    data.choices[0].finish_reason = finish;
    data.choices[0].message.refusal = refusal;
    data.choices[0].message.content = 'not a valid fact response';
    const result = inspectResponse(reply(data), 'terra');
    assert.equal(result.state, 'FAILED');
    assert.equal(result.reason, reason);
    assert.equal(result.facts, null);
  }
});

test('metering, identity, controls and schema anomalies fail closed', () => {
  const cases = [
    [(d) => { d.usage.prompt_tokens = 8193; d.usage.total_tokens = 8693; }, 'INPUT_ANOMALY'],
    [(d) => { d.usage.completion_tokens = 2049; d.usage.total_tokens = 5049; }, 'OUTPUT_ANOMALY'],
    [(d) => { d.usage.prompt_tokens_details.cache_write_tokens = 1; }, 'CACHE_ANOMALY'],
    [(d) => { d.usage.prompt_tokens_details.cached_tokens = 1; }, 'CACHE_ANOMALY'],
    [(d) => { delete d.usage.prompt_tokens_details.cache_write_tokens; }, 'USAGE_INVALID'],
    [(d) => { d.usage.total_tokens++; }, 'USAGE_INVALID'],
    [(d) => { d.usage.prompt_tokens = Number.MAX_SAFE_INTEGER + 1; }, 'USAGE_INVALID'],
    [(d) => { d.usage.completion_tokens_details.reasoning_tokens = 501; }, 'USAGE_INVALID'],
    [(d) => { d.usage.completion_tokens_details.audio_tokens = 1; }, 'USAGE_INVALID'],
    [(d) => { d.usage.new_meter = 1; }, 'USAGE_INVALID'],
    [(d) => { d.model = 'gpt-5.6-sol'; }, 'MODEL_ANOMALY'],
    [(d) => { d.store = true; }, 'CONTROL_ANOMALY'],
    [(d) => { d.service_tier = 'priority'; }, 'CONTROL_ANOMALY'],
    [(d) => { d.prompt_cache_options = { mode: 'implicit' }; }, 'CONTROL_ANOMALY'],
    [(d) => { d.choices[0].message.tool_calls = [{}]; }, 'CONTROL_ANOMALY'],
    [(d) => { d.choices[0].message.audio = {}; }, 'CONTROL_ANOMALY'],
    [(d) => { d.tools = [{}]; }, 'CONTROL_ANOMALY'],
    [(d) => { d.choices.push(d.choices[0]); }, 'ENVELOPE_INVALID'],
    [(d) => { d.choices[0].message.content = '{}'; }, 'DOMAIN_INVALID'],
    [(d) => { d.choices[0].message.content = 'x'.repeat(8193); }, 'DOMAIN_INVALID'],
  ];
  for (const [change, reason] of cases) {
    const data = envelope(); change(data);
    const result = inspectResponse(reply(data), 'terra');
    assert.equal(result.state, 'HALTED', reason);
    assert.equal(result.reason, reason);
    assert.equal(result.facts, null);
  }
  const excessive = envelope();
  excessive.usage.prompt_tokens = 1000000;
  excessive.usage.total_tokens = 1000500;
  assert.equal(inspectResponse(reply(excessive), 'terra').usage.input, 1000000);
});

test('bad HTTP, media type, UTF8 and response size do not become success', () => {
  assert.equal(inspectResponse({ ...reply(), status: 302 }, 'terra').reason, 'HTTP_FAILURE');
  assert.equal(inspectResponse({ ...reply(), status: 500 }, 'terra').reason, 'HTTP_FAILURE');
  assert.equal(inspectResponse({ ...reply(), contentType: 'text/html' }, 'terra').reason, 'ENVELOPE_INVALID');
  assert.equal(inspectResponse({ ...reply(), body: Buffer.from([255]) }, 'terra').reason, 'INVALID_JSON');
  assert.equal(inspectResponse({ ...reply(), body: Buffer.alloc(262145, 32) }, 'terra').reason, 'RESPONSE_BOUND');
});

test('two slots require separate sends/review; intents are durable before the fake sender', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const sender = async ({ body, key, signal }) => {
    calls++;
    assert.equal(key, FAKE_KEY);
    assert.equal(signal.aborted, false);
    const state = await readLedger(directory);
    const arm = body.model.includes('terra') ? 'terra' : 'sol';
    assert.equal(state.slots[arm].intent.reservationCents, 250);
    assert.equal(state.slots[arm].result, null);
    return reply(envelope(arm));
  };
  await assert.rejects(executeSlot(options(directory, { arm: 'sol', sender })), /FIRST_RESULT_REVIEW_REQUIRED/);
  assert.equal(calls, 0);
  await executeSlot(options(directory, { sender }));
  assert.equal(calls, 1);
  await assert.rejects(executeSlot(options(directory, { sender })), /SLOT_CONSUMED/);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol', sender, reviewFirst: '0'.repeat(64) })), /FIRST_RESULT_REVIEW_REQUIRED/);
  const first = summary(await readLedger(directory));
  assert.equal(first.slots.terra.estimatedMicroUsd, '13200');
  assert.equal(first.slots.sol.state, 'UNUSED');
  await executeSlot(options(directory, { arm: 'sol', sender, reviewFirst: first.slots.terra.reviewToken }));
  assert.equal(calls, 2);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol', sender })), /SLOT_CONSUMED/);
  const last = summary(await readLedger(directory));
  assert.equal(last.slots.terra.reservationCents + last.slots.sol.reservationCents, 500);
  assert.equal(last.slots.terra.configuredSnapshot, '2026-07-09');
  assert.equal(last.slots.terra.returnedModel, 'gpt-5.6-terra');
  assert.equal(last.slots.sol.estimatedMicroUsd, '24200');
  assert.doesNotMatch(JSON.stringify(last), /knitted fabric|navy|synthetic-test-value/);
  const journal = await readFile(path.join(directory, 'pilot.jsonl'), 'utf8');
  assert.ok(!journal.includes(FAKE_KEY));
  assert.ok(!journal.includes(SYNTHETIC.toString('base64')));
});

test('photo mismatch and missing key do not consume a slot', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  const sender = async () => { calls++; return reply(); };
  await assert.rejects(executeSlot(options(directory, { key: '', sender })), /PRIVATE_KEY_REQUIRED/);
  await assert.rejects(executeSlot(options(directory, { readPhoto: async () => Buffer.from('different text'), sender })), /PHOTO_CHANGED/);
  assert.equal(calls, 0);
  assert.equal((await readLedger(directory)).slots.terra, null);
});

test('ordinary refusal with valid metering may be reviewed, never retried', async (t) => {
  const directory = await fixture(t);
  const data = envelope(); data.choices[0].message.refusal = 'synthetic refusal';
  await executeSlot(options(directory, { sender: async () => reply(data) }));
  const state = summary(await readLedger(directory));
  assert.equal(state.slots.terra.state, 'FAILED');
  await executeSlot(options(directory, { arm: 'sol', reviewFirst: state.slots.terra.reviewToken, sender: async () => reply(envelope('sol')) }));
  assert.equal((await readLedger(directory)).slots.sol.result.state, 'SUCCESS');
});

test('network loss, oversized response and input anomaly hold full reservation and block second call', async (t) => {
  for (const sender of [
    async () => { throw new Error('private raw error must not be saved'); },
    async () => { throw new PilotError('RESPONSE_BOUND'); },
    async () => {
      const data = envelope(); data.usage.prompt_tokens = 8193; data.usage.total_tokens = 8693;
      return reply(data);
    },
  ]) {
    const directory = await fixture(t);
    await executeSlot(options(directory, { sender }));
    const state = summary(await readLedger(directory));
    assert.equal(state.slots.terra.state, 'HALTED');
    assert.equal(state.slots.terra.reservationCents, 250);
    await assert.rejects(executeSlot(options(directory, { arm: 'sol', reviewFirst: state.slots.terra.reviewToken })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
    assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /private raw error/);
  }
});

test('timeout aborts locally without retry or claiming provider cancellation', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  let sentSignal;
  const result = await executeSlot(options(directory, {
    timeoutMs: 5, sender: ({ signal }) => { calls++; sentSignal = signal; return new Promise(() => {}); },
  }));
  assert.equal(calls, 1);
  assert.equal(sentSignal.aborted, true);
  assert.equal(result.reason, 'NETWORK_UNCERTAIN');
  assert.equal(result.confirmedResponse, false);
  assert.equal(summary(await readLedger(directory)).slots.terra.consumedIntent, true);
});

test('concurrent and crash-stale locks never auto-expire', async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'pilot.lock'));
  await assert.rejects(executeSlot(options(directory)), /LOCKED_NO_AUTOMATIC_RECOVERY/);
  assert.equal((await readLedger(directory)).slots.terra, null);
});

test('another invocation cannot enter while the first fake request is pending', async (t) => {
  const directory = await fixture(t);
  let release;
  let entered;
  const pending = new Promise((resolve) => { entered = resolve; });
  const first = executeSlot(options(directory, { sender: () => {
    entered();
    return new Promise((resolve) => { release = () => resolve(reply()); });
  } }));
  await pending;
  try {
    await assert.rejects(executeSlot(options(directory, { arm: 'sol' })), /LOCKED_NO_AUTOMATIC_RECOVERY/);
  } finally { release(); }
  assert.equal((await first).state, 'SUCCESS');
});

test('durable intent without result survives restart as uncertainty', async (t) => {
  const directory = await fixture(t);
  await appendFile(path.join(directory, 'pilot.jsonl'), `${JSON.stringify({
    type: 'intent', arm: 'terra', reservationCents: 250, photoSha256: digest(SYNTHETIC), reviewFirst: null, time: new Date().toISOString(),
  })}\n`);
  const state = summary(await readLedger(directory));
  assert.equal(state.slots.terra.state, 'UNCERTAIN_INTENT');
  assert.equal(state.slots.terra.confirmedResponse, false);
  await assert.rejects(executeSlot(options(directory)), /SLOT_CONSUMED/);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol' })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
});

test('torn/config-changed/oversized journals and duplicate initialization refuse', async (t) => {
  const directory = await fixture(t);
  await assert.rejects(initialize(directory, approval()), /LEDGER_WRITE_UNCERTAIN/);
  const file = path.join(directory, 'pilot.jsonl');
  const original = await readFile(file);
  await appendFile(file, '{"type":');
  await assert.rejects(readLedger(directory), /LEDGER_TORN/);
  await writeFile(file, original.toString().replace(controlsDigest(), '0'.repeat(64)));
  await assert.rejects(readLedger(directory), /LEDGER_CONFIG_CHANGED/);
  await writeFile(file, 'x'.repeat(131073));
  await assert.rejects(readLedger(directory), /FILE_BOUND/);
});

test('result persistence failure cannot recreate a missing journal as successful state', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  await assert.rejects(executeSlot(options(directory, { sender: async () => {
    calls++;
    await unlink(path.join(directory, 'pilot.jsonl'));
    return reply();
  } })), /LEDGER_WRITE_UNCERTAIN/);
  assert.equal(calls, 1);
  assert.equal((await stat(path.join(directory, 'pilot.lock'))).isDirectory(), true);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol' })), /LOCKED_NO_AUTOMATIC_RECOVERY/);
});

test('explicit abandonment marks only unused slots NOT_ATTEMPTED and preserves holds', async (t) => {
  const directory = await fixture(t);
  await executeSlot(options(directory, { sender: async () => { throw new Error('lost'); } }));
  await abandon(directory);
  const state = summary(await readLedger(directory));
  assert.equal(state.slots.terra.state, 'HALTED');
  assert.equal(state.slots.terra.reservationCents, 250);
  assert.equal(state.slots.sol.state, 'NOT_ATTEMPTED');
  assert.equal(state.slots.sol.consumedIntent, false);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol' })), /ABANDONED/);
  await assert.rejects(abandon(directory), /ALREADY_ABANDONED/);
});
