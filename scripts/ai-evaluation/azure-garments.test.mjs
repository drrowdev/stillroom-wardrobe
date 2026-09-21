import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, mkdir, rm, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  POLICY, PilotError, digest, schema, validFacts, requestBody, validateApproval,
  controlsDigest, initialize, readLedger, abandon, summary, inspectResponse, executeSlot,
  initializeSingle, validateSingleAuthorization, parseArguments,
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

test('legacy halted journal preserves its bytes, binding and review token', async (t) => {
  const directory = await fixture(t);
  const observation = {
    state: 'HALTED', reason: 'USAGE_INVALID', confirmedResponse: true, httpStatus: 200,
    returnedModel: 'gpt-5.6-terra', usage: null, facts: null, elapsedMs: 100,
  };
  const time = '2026-09-20T00:00:00.000Z';
  const journal = [
    { type: 'init', approval: approval(), controls: 'b368446355aad1bfa7132ee63d281e4e88a0f952cf8992abd282796d5928f3af', time },
    { type: 'intent', arm: 'terra', reservationCentsEur: 250, photoSha256: digest(SYNTHETIC), reviewFirst: null, time },
    { type: 'result', arm: 'terra', observation, time },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';
  const filename = path.join(directory, 'pilot.jsonl');
  await writeFile(filename, journal);
  const state = await readLedger(directory);
  const report = summary(state);
  assert.equal(controlsDigest(), 'b368446355aad1bfa7132ee63d281e4e88a0f952cf8992abd282796d5928f3af');
  assert.equal(report.slots.terra.reviewToken, '90095db49ea4bda0d8a2e8ab4f985e2c421e047a1bc26a74efb988d5eb661c05');
  const journalHash = digest(journal);
  assert.deepEqual(state.slots.terra.result, observation);
  assert.equal(report.slots.terra.state, 'HALTED');
  assert.equal(report.slots.terra.reservationCentsEur, 250);
  assert.equal(report.slots.terra.estimatedMicroUsd, null);
  assert.equal(report.slots.terra.usageDiagnostic, null);
  assert.equal(report.slots.terra.candidateStatus, null);
  await assert.rejects(executeSlot(options(directory, {
    arm: 'sol', reviewFirst: report.slots.terra.reviewToken,
  })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
  assert.equal(await readFile(filename, 'utf8'), journal);
  assert.equal(digest(await readFile(filename)), journalHash);
  assert.equal(summary(await readLedger(directory)).slots.terra.reviewToken, '90095db49ea4bda0d8a2e8ab4f985e2c421e047a1bc26a74efb988d5eb661c05');
});

test('frozen A1 pair observation retains its token and journal bytes', async (t) => {
  const directory = await fixture(t);
  const observation = {
    state: 'HALTED', reason: 'USAGE_INVALID', confirmedResponse: true, httpStatus: 200,
    returnedModel: 'gpt-5.6-terra', usage: null, facts: null, elapsedMs: 100,
    usageDiagnostic: { field: 'USAGE', condition: 'UNEXPECTED_KEY' },
    unacceptedCandidate: { status: 'UNACCEPTED_METERING', facts: facts() },
  };
  const time = '2026-09-21T00:00:00.000Z';
  const filename = path.join(directory, 'pilot.jsonl');
  await appendFile(filename, [
    { type: 'intent', arm: 'terra', reservationCentsEur: 250, photoSha256: digest(SYNTHETIC), reviewFirst: null, time },
    { type: 'result', arm: 'terra', observation, time },
    { type: 'abandon', time },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const original = await readFile(filename);
  const state = await readLedger(directory);
  assert.deepEqual(state.slots.terra.result, observation);
  const report = summary(state);
  assert.equal(report.slots.terra.reviewToken, 'a5b91948a0e2766aba0e7d821185c8885ef8e501d8d13918069cc1e7ca19ec8f');
  assert.equal(report.slots.terra.state, 'HALTED');
  assert.equal(report.abandoned, true);
  await assert.rejects(executeSlot(options(directory, {
    arm: 'sol', reviewFirst: report.slots.terra.reviewToken,
  })), /ABANDONED/);
  assert.deepEqual(await readFile(filename), original);
  assert.equal(summary(await readLedger(directory)).slots.terra.reviewToken, 'a5b91948a0e2766aba0e7d821185c8885ef8e501d8d13918069cc1e7ca19ec8f');
});

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

test('only the current arm deployment alias is accepted verbatim', () => {
  for (const arm of ['terra', 'sol']) {
    const data = envelope(arm);
    data.model = `eval-${arm}-20260709`;
    const result = inspectResponse(reply(data), arm);
    assert.equal(result.state, 'SUCCESS');
    assert.equal(result.returnedModel, data.model);
    for (const model of [`eval-${arm === 'terra' ? 'sol' : 'terra'}-20260709`, 'arbitrary-alias']) {
      data.model = model;
      const rejected = inspectResponse(reply(data), arm);
      assert.equal(rejected.state, 'HALTED');
      assert.equal(rejected.reason, 'MODEL_ANOMALY');
      assert.equal(rejected.returnedModel, model);
    }
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
    data.usage.new_meter = { synthetic_ignored: 1 };
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

test('malformed completed responses retain safe HTTP receipt without inference or usage claims', async (t) => {
  for (const response of [
    { ...reply(), status: 'invalid' },
    { ...reply(), body: Buffer.from('{') },
    reply(null),
    reply({}),
  ]) {
    const directory = await fixture(t);
    const result = await executeSlot(options(directory, { sender: async () => response }));
    assert.equal(result.state, 'HALTED');
    assert.equal(result.confirmedResponse, true);
    assert.equal(result.httpStatus, response.status === 200 ? 200 : null);
    assert.equal(result.usage, null);
    assert.equal(result.facts, null);
    const state = summary(await readLedger(directory));
    assert.equal(state.slots.terra.confirmedResponse, true);
    assert.equal(state.slots.terra.reservationCentsEur, 250);
    assert.equal(state.slots.terra.estimatedMicroUsd, null);
    await assert.rejects(executeSlot(options(directory, {
      arm: 'sol', reviewFirst: state.slots.terra.reviewToken,
    })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
  }
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
    assert.equal(state.slots[arm].intent.reservationCentsEur, 250);
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
  assert.equal(last.slots.terra.reservationCentsEur + last.slots.sol.reservationCentsEur, 500);
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
    assert.equal(state.slots.terra.reservationCentsEur, 250);
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

test('primary failure and lock-cleanup diagnostic survive together without raw details', async (t) => {
  const directory = await fixture(t);
  let calls = 0;
  await assert.rejects(executeSlot(options(directory, {
    readPhoto: async () => {
      await writeFile(path.join(directory, 'pilot.lock', 'synthetic-blocker.txt'), 'synthetic text');
      return Buffer.from('different synthetic text');
    },
    sender: async () => { calls++; return reply(); },
  })), (error) => {
    assert.ok(error instanceof PilotError);
    assert.equal(error.code, 'PHOTO_CHANGED');
    assert.equal(error.cleanupCode, 'LOCK_RELEASE_FAILED');
    assert.equal(error.message, 'PHOTO_CHANGED; LOCK_RELEASE_FAILED');
    assert.doesNotMatch(error.message, /synthetic-blocker|ENOTEMPTY|EPERM/);
    return true;
  });
  assert.equal(calls, 0);
  assert.equal((await readLedger(directory)).slots.terra, null);
  assert.equal((await stat(path.join(directory, 'pilot.lock'))).isDirectory(), true);
  await assert.rejects(executeSlot(options(directory)), /LOCKED_NO_AUTOMATIC_RECOVERY/);
});

test('unexpected falsy failures propagate and retain the lock without dispatch', async (t) => {
  for (const failure of [undefined, null, false, 0, '']) {
    const directory = await fixture(t);
    let calls = 0;
    let rejected = false;
    try {
      await executeSlot(options(directory, {
        readPhoto: async () => { throw failure; },
        sender: async () => { calls++; return reply(); },
      }));
    } catch (error) {
      rejected = true;
      assert.equal(error, failure);
    }
    assert.equal(rejected, true);
    assert.equal(calls, 0);
    assert.equal((await readLedger(directory)).slots.terra, null);
    assert.equal((await stat(path.join(directory, 'pilot.lock'))).isDirectory(), true);
    await assert.rejects(executeSlot(options(directory)), /LOCKED_NO_AUTOMATIC_RECOVERY/);
  }
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
    type: 'intent', arm: 'terra', reservationCentsEur: 250, photoSha256: digest(SYNTHETIC), reviewFirst: null, time: new Date().toISOString(),
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
  assert.equal(state.slots.terra.reservationCentsEur, 250);
  assert.equal(state.slots.sol.state, 'NOT_ATTEMPTED');
  assert.equal(state.slots.sol.consumedIntent, false);
  await assert.rejects(executeSlot(options(directory, { arm: 'sol' })), /ABANDONED/);
  await assert.rejects(abandon(directory), /ALREADY_ABANDONED/);
});

test('current usage diagnostics preserve deterministic presence and check order', () => {
  const cases = [];
  for (const [key, field] of [
    ['usage', 'USAGE'], ['prompt_tokens_details', 'PROMPT_DETAILS'], ['completion_tokens_details', 'COMPLETION_DETAILS'],
  ]) {
    const container = (d) => key === 'usage' ? d : d.usage;
    cases.push([(d) => { delete container(d)[key]; }, field, 'MISSING']);
    for (const value of [null, [], 0, 'private-value']) {
      cases.push([(d) => { container(d)[key] = value; }, field, 'NOT_OBJECT']);
    }
  }
  for (const [section, key, field] of [
    [null, 'prompt_tokens', 'INPUT'], [null, 'completion_tokens', 'OUTPUT'], [null, 'total_tokens', 'TOTAL'],
    ['completion_tokens_details', 'reasoning_tokens', 'REASONING'],
    ['prompt_tokens_details', 'cached_tokens', 'CACHE_READ'],
    ['prompt_tokens_details', 'cache_write_tokens', 'CACHE_WRITE'],
  ]) {
    const container = (d) => section ? d.usage[section] : d.usage;
    cases.push([(d) => { delete container(d)[key]; }, field, 'MISSING']);
    for (const value of [null, '0', false, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, {}, []]) {
      cases.push([(d) => { container(d)[key] = value; }, field, 'NOT_NONNEGATIVE_SAFE_INTEGER']);
    }
  }
  cases.push(
    [(d) => { d.usage.prompt_tokens = Number.MAX_SAFE_INTEGER; }, 'TOTAL', 'SUM_UNSAFE'],
    [(d) => { d.usage.total_tokens++; }, 'TOTAL', 'TOTAL_MISMATCH'],
    [(d) => { d.usage.completion_tokens_details.reasoning_tokens = 501; }, 'REASONING', 'REASONING_EXCEEDS_OUTPUT'],
    [(d) => { d.usage.prompt_tokens_details.cached_tokens = 3001; }, 'CACHE_READ', 'CACHE_READ_EXCEEDS_INPUT'],
    [(d) => { d.usage.prompt_tokens_details.audio_tokens = 'private-value'; }, 'PROMPT_DETAILS', 'UNEXPECTED_COMPONENT'],
    [(d) => { d.usage.completion_tokens_details.audio_tokens = 'private-value'; }, 'COMPLETION_DETAILS', 'UNEXPECTED_COMPONENT'],
    [(d) => {
      delete d.usage.prompt_tokens;
      delete d.usage.prompt_tokens_details;
    }, 'PROMPT_DETAILS', 'MISSING'],
    [(d) => {
      delete d.usage.prompt_tokens;
      delete d.usage.prompt_tokens_details.cache_write_tokens;
    }, 'INPUT', 'MISSING'],
  );
  for (const [change, field, condition] of cases) {
    const data = envelope(); change(data);
    if (data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)) {
      data.usage.private_key_name = 'private-value';
    }
    const result = inspectResponse(reply(data), 'terra');
    assert.equal(result.state, 'HALTED');
    assert.equal(result.reason, 'USAGE_INVALID');
    assert.equal(result.usage, null);
    assert.equal(result.facts, null);
    assert.deepEqual(result.usageDiagnostic, { field, condition });
    assert.doesNotMatch(JSON.stringify(result), /private_key_name|private-value/);
  }
  const tolerated = envelope();
  tolerated.usage.prompt_tokens_details.extra = 0;
  tolerated.usage.completion_tokens_details.extra = null;
  assert.equal(inspectResponse(reply(tolerated), 'terra').state, 'SUCCESS');
});

test('metering-only candidates stay private, unaccepted, fully reserved and unable to continue', async (t) => {
  for (const outcome of ['ready', 'unclear']) {
    const directory = await fixture(t);
    const data = envelope();
    delete data.usage;
    const expected = facts();
    expected.outcome = outcome;
    if (outcome === 'unclear') {
      for (const key of Object.keys(expected.fields)) {
        expected.fields[key] = ['colours', 'seasons', 'style_tags'].includes(key) ? [] : null;
      }
    }
    data.choices[0].message.content = JSON.stringify(expected);
    const result = await executeSlot(options(directory, { sender: async () => reply(data) }));
    assert.equal(result.state, 'HALTED');
    assert.equal(result.reason, 'USAGE_INVALID');
    assert.equal(result.facts, null);
    assert.equal(result.usage, null);
    assert.deepEqual(result.usageDiagnostic, { field: 'USAGE', condition: 'MISSING' });
    assert.deepEqual(result.unacceptedCandidate, { status: 'UNACCEPTED_METERING', facts: expected });
    const state = await readLedger(directory);
    assert.deepEqual(state.slots.terra.result, result);
    const report = summary(state);
    assert.equal(report.slots.terra.candidateStatus, 'UNACCEPTED_METERING');
    assert.equal(report.slots.terra.estimatedMicroUsd, null);
    assert.equal(report.slots.terra.reservationCentsEur, 250);
    assert.equal(report.slots.terra.state, 'HALTED');
    assert.doesNotMatch(JSON.stringify(report), /"facts"|"fields"|unacceptedCandidate|knitted fabric|navy/);
    const file = path.join(directory, 'pilot.jsonl');
    const before = await readFile(file);
    await assert.rejects(executeSlot(options(directory, {
      arm: 'sol', reviewFirst: report.slots.terra.reviewToken,
    })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
    assert.deepEqual(await readFile(file), before);
  }
});

test('invalid usage cannot bypass any answer gate or change its halt reason', async (t) => {
  const changes = [
    (d) => { d.model = 'eval-sol-20260709'; },
    (d) => { d.model = 'unrecognized'; },
    (d) => { d.store = true; },
    (d) => { d.stream = true; },
    (d) => { d.n = 2; },
    (d) => { d.reasoning_effort = 'high'; },
    (d) => { d.max_completion_tokens = 4096; },
    (d) => { d.service_tier = 'priority'; },
    (d) => { d.prompt_cache_options = { mode: 'implicit' }; },
    (d) => { d.tools = [{}]; },
    (d) => { d.choices = []; },
    (d) => { d.choices.push(d.choices[0]); },
    (d) => { d.choices[0].index = 1; },
    (d) => { d.choices[0].message = null; },
    (d) => { d.choices[0].message.role = 'user'; },
    (d) => { d.choices[0].message.tool_calls = [{}]; },
    (d) => { d.choices[0].message.function_call = {}; },
    (d) => { d.choices[0].message.audio = {}; },
    (d) => { d.choices[0].message.refusal = 'private-refusal'; },
    (d) => { d.choices[0].message.refusal = {}; },
    (d) => { d.choices[0].finish_reason = 'length'; },
    (d) => { d.choices[0].finish_reason = 'content_filter'; },
    (d) => { d.choices[0].finish_reason = 'unknown'; },
    (d) => { d.choices[0].message.content = null; },
    (d) => { d.choices[0].message.content = '{'; },
    (d) => { d.choices[0].message.content = '{}'; },
    (d) => { d.choices[0].message.content = 'x'.repeat(8193); },
    (d) => {
      const invalid = facts(); invalid.fields.warmth = 'private-value';
      d.choices[0].message.content = JSON.stringify(invalid);
    },
  ];
  for (const change of changes) {
    const data = envelope();
    delete data.usage.prompt_tokens_details.cache_write_tokens;
    change(data);
    const result = inspectResponse(reply(data), 'terra');
    assert.equal(result.state, 'HALTED');
    assert.equal(result.reason, 'USAGE_INVALID');
    assert.equal(result.usage, null);
    assert.equal(result.facts, null);
    assert.equal(result.unacceptedCandidate, null);
    assert.deepEqual(result.usageDiagnostic, { field: 'CACHE_WRITE', condition: 'MISSING' });
    assert.doesNotMatch(JSON.stringify(result), /private-refusal|private-value/);
  }
  const directory = await fixture(t);
  const data = envelope(); delete data.usage; data.store = true;
  await executeSlot(options(directory, { sender: async () => reply(data) }));
  const report = summary(await readLedger(directory));
  assert.equal(report.slots.terra.candidateStatus, null);
  assert.equal(report.slots.terra.reservationCentsEur, 250);
  assert.equal(report.slots.terra.estimatedMicroUsd, null);
  await assert.rejects(executeSlot(options(directory, {
    arm: 'sol', reviewFirst: report.slots.terra.reviewToken,
  })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
});

test('transport and response bounds never retain candidates', () => {
  for (const response of [
    null, { ...reply(), status: 500 }, { ...reply(), contentType: 'text/html' },
    { ...reply(), body: Buffer.from([255]) }, { ...reply(), body: Buffer.from('{') },
    { ...reply(), body: Buffer.alloc(262145, 32) }, reply(null),
  ]) {
    const result = inspectResponse(response, 'terra');
    assert.equal(result.state, 'HALTED');
    assert.equal(result.unacceptedCandidate, null);
    assert.equal(result.usageDiagnostic, null);
  }
});

test('independently known limit and cache violations suppress candidates without defaulting unknowns', () => {
  for (const [section, key, limit] of [
    [null, 'prompt_tokens', 8192], [null, 'completion_tokens', 2048],
    ['prompt_tokens_details', 'cached_tokens', 0], ['prompt_tokens_details', 'cache_write_tokens', 0],
  ]) {
    for (const value of [limit + 1, undefined, null, -1, NaN, Infinity, '99999', {}, 0.5]) {
      const data = envelope();
      delete data.usage.total_tokens;
      const container = section ? data.usage[section] : data.usage;
      container[key] = value;
      const result = inspectResponse(reply(data), 'terra');
      assert.equal(result.reason, 'USAGE_INVALID');
      assert.equal(result.usage, null);
      assert.equal(result.facts, null);
      assert.equal(result.unacceptedCandidate?.status ?? null, value === limit + 1 ? null : 'UNACCEPTED_METERING');
    }
  }
  const mixed = envelope();
  mixed.usage.prompt_tokens = 'unknown';
  mixed.usage.prompt_tokens_details.cache_write_tokens = 1;
  assert.equal(inspectResponse(reply(mixed), 'terra').unacceptedCandidate, null);
});

test('ignored metering names and values never enter accepted observations or summaries', async (t) => {
  const directory = await fixture(t);
  const data = envelope();
  data.usage['PRIVATE-SENTINEL-KEY'] = { value: 'PRIVATE-SENTINEL-VALUE' };
  await executeSlot(options(directory, { sender: async () => reply(data) }));
  const state = await readLedger(directory);
  assert.equal(state.slots.terra.result.state, 'SUCCESS');
  assert.equal(state.slots.terra.result.usageDiagnostic, null);
  assert.deepEqual(state.slots.terra.result.usage, inspectResponse(reply(), 'terra').usage);
  assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /PRIVATE-SENTINEL/);
  assert.doesNotMatch(JSON.stringify(summary(state)), /PRIVATE-SENTINEL|"facts"|"fields"/);
});

test('replay accepts only legacy or complete strict extensions with arm-bound candidates', async (t) => {
  const directory = await fixture(t);
  const data = envelope(); delete data.usage;
  await executeSlot(options(directory, { sender: async () => reply(data) }));
  const filename = path.join(directory, 'pilot.jsonl');
  const original = await readFile(filename, 'utf8');
  const changes = [
    (o) => { delete o.usageDiagnostic; },
    (o) => { delete o.unacceptedCandidate; },
    (o) => { o.extra = null; },
    (o) => { o.usageDiagnostic = null; },
    (o) => { o.usageDiagnostic.extra = null; },
    (o) => { o.usageDiagnostic.field = 'UNRECOGNIZED'; },
    (o) => { o.usageDiagnostic.field = { toString: null }; },
    (o) => { o.usageDiagnostic.condition = 'UNKNOWN'; },
    (o) => { o.usageDiagnostic = { field: 'INPUT', condition: 'TOTAL_MISMATCH' }; },
    (o) => { o.state = 'SUCCESS'; },
    (o) => { o.reason = 'OK'; },
    (o) => { o.confirmedResponse = false; },
    (o) => { o.httpStatus = 500; },
    (o) => { o.usage = { input: 0, output: 0, total: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }; },
    (o) => { o.facts = facts(); },
    (o) => { o.returnedModel = 'eval-sol-20260709'; },
    (o) => { o.returnedModel = null; },
    (o) => { o.unacceptedCandidate.status = 'SUCCESS'; },
    (o) => { o.unacceptedCandidate.extra = null; },
    (o) => { o.unacceptedCandidate.facts = null; },
    (o) => { o.unacceptedCandidate.facts.fields.brand = 'x'.repeat(101); },
  ];
  for (const change of changes) {
    const events = original.trimEnd().split('\n').map((line) => JSON.parse(line));
    change(events[2].observation);
    await writeFile(filename, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await assert.rejects(readLedger(directory), /LEDGER_INVALID/);
  }
  await writeFile(filename, original);
  assert.equal((await readLedger(directory)).slots.terra.result.unacceptedCandidate.status, 'UNACCEPTED_METERING');
});

test('maximum-length domain candidate and boundary content fit measured complete journal bounds', async (t) => {
  const directory = await fixture(t);
  const candidate = facts();
  Object.assign(candidate.fields, {
    category: 'accessory', subcategory: '\u0001'.repeat(60), colours: ['yellow', 'orange', 'purple'],
    pattern: 'abstract', sleeve_length: 'three_quarter', garment_length: 'regular',
    brand: '\u0001'.repeat(100), size_label: '\u0001'.repeat(50), material: '\u0001'.repeat(200),
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    style_tags: Array.from({ length: 8 }, (_, i) => '\u0001'.repeat(39) + i),
  });
  assert.equal(validFacts(candidate), true);
  const data = envelope(); delete data.usage;
  data.choices[0].message.content = JSON.stringify(candidate).padEnd(8192);
  const response = reply(data);
  assert.equal(Buffer.byteLength(data.choices[0].message.content), 8192);
  assert.ok(response.body.length <= POLICY.responseBytes);
  await executeSlot(options(directory, { sender: async () => response }));
  const journal = await readFile(path.join(directory, 'pilot.jsonl'));
  const state = await readLedger(directory);
  const result = state.slots.terra.result;
  assert.deepEqual(result.unacceptedCandidate.facts, candidate);
  const record = journal.toString().trimEnd().split('\n').at(-1) + '\n';
  assert.ok(Buffer.byteLength(record) < 131072);
  assert.ok(journal.length < 131072);
  assert.equal(journal.toString().trimEnd().split('\n').length, 3);
  t.diagnostic(`Synthetic complete result record: ${Buffer.byteLength(record)} bytes; journal: ${journal.length} bytes; response: ${response.body.length} bytes.`);
});

function authorization(overrides = {}) {
  return { mode: 'single', selectedArm: 'sol', authorizationRef: 'synthetic-a2-approval',
    priorCommittedCentsEur: 500, aggregateLimitCentsEur: 750, shapeCapture: 'private-names-types-v1', ...overrides };
}
async function singleFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stillroom-p2-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initializeSingle(directory, { approval: approval(), authorization: authorization(overrides) });
  return directory;
}
function shapeEnvelope(entries = [['extra_meter', 123]], arm = 'sol') {
  const data = envelope(arm);
  for (const [name, value] of entries) {
    Object.defineProperty(data.usage, name, { value, enumerable: true, configurable: true });
  }
  return data;
}
function singleOptions(directory, overrides = {}) {
  return options(directory, { arm: 'sol', sender: async () => reply(envelope('sol')), ...overrides });
}

function historicalA2Observation(usageShape) {
  return {
    state: 'HALTED', reason: 'USAGE_INVALID', confirmedResponse: true, httpStatus: 200,
    returnedModel: 'gpt-5.6-sol', usage: null, facts: null, elapsedMs: 0,
    usageDiagnostic: { field: 'USAGE', condition: 'UNEXPECTED_KEY' },
    unacceptedCandidate: { status: 'UNACCEPTED_METERING', facts: facts() }, usageShape,
  };
}
const A2_CAPTURED = historicalA2Observation({ status: 'CAPTURED', entries: [
  { name: '__proto__', type: 'object' }, { name: 'constructor', type: 'array' },
  { name: 'toString', type: 'string' }, { name: 'unknown_null', type: 'null' },
  { name: 'unknown_boolean', type: 'boolean' }, { name: 'unknown_number', type: 'number' },
] });
const A2_SUPPRESSED = historicalA2Observation({ status: 'SUPPRESSED', entries: [] });
function historicalA2Record(observation) {
  return JSON.stringify({ type: 'result', arm: 'sol', observation, time: '2026-09-21T00:00:00.000Z' }) + '\n';
}

async function historicalA2Fixture(t, observation) {
  const directory = await singleFixture(t);
  const state = await readLedger(directory);
  await appendFile(path.join(directory, 'pilot.jsonl'), JSON.stringify({
    type: 'intent', arm: 'sol', reservationCentsEur: 250, photoSha256: digest(SYNTHETIC),
    reviewFirst: null, time: '2026-09-21T00:00:00.000Z', runBinding: state.runBinding,
  }) + '\n' + historicalA2Record(observation));
  return directory;
}

// Produced with unchanged 0b50 helper blob 2ef8b6018c2dcefc4142d785725e19de3fe4528c;
// synthetic byte definitions and digests were published in PR28 comment5758425825 before refactoring.
test('frozen A2 captured and suppressed records preserve bytes, holds and stops', async (t) => {
  for (const [expected, bytes, hash] of [
    [A2_CAPTURED, 941, '2f60e2eb3fd671ad7d1003e9d3527340eef8aa7909cd7bb84f22a2118731ff5e'],
    [A2_SUPPRESSED, 709, '0787f9f77b4c5977949b733fc76320cf2344c10232dbc750603c6688e8671d57'],
  ]) {
    const record = historicalA2Record(expected);
    assert.equal(Buffer.byteLength(record), bytes);
    assert.equal(digest(record), hash);
    const directory = await historicalA2Fixture(t, expected);
    const filename = path.join(directory, 'pilot.jsonl');
    const before = await readFile(filename);
    assert.ok(before.toString().endsWith(record));
    const state = await readLedger(directory);
    assert.deepEqual(state.slots.sol.result, expected);
    const report = summary(state);
    assert.equal(report.slots.sol.state, 'HALTED');
    assert.equal(report.slots.sol.estimatedMicroUsd, null);
    assert.equal(report.slots.sol.reservationCentsEur, 250);
    assert.equal(report.slots.sol.reviewToken, null);
    assert.equal(report.slots.sol.captureStatus, expected.usageShape.status);
    let calls = 0;
    const sender = async () => { calls++; return reply(); };
    await assert.rejects(executeSlot(singleOptions(directory, { sender })), /SLOT_CONSUMED/);
    await assert.rejects(executeSlot(singleOptions(directory, { arm: 'terra', sender })), /PRIOR_UNCERTAINTY_OR_ANOMALY/);
    assert.equal(calls, 0);
    assert.deepEqual(await readFile(filename), before);
    assert.doesNotMatch(JSON.stringify(report), /__proto__|constructor|toString|unknown_null|"entries"|"usageShape"|"facts"/);
  }
});

test('single authorization and CLI grammar are explicit, bounded and credential-free', () => {
  assert.deepEqual(validateSingleAuthorization(authorization()), authorization());
  for (const change of [
    (a) => { delete a.shapeCapture; }, (a) => { a.shapeConsent = true; },
    (a) => { a.maxIntents = 1; }, (a) => { a.additionalAllowanceCentsEur = 250; },
    (a) => { a.mode = 'pair'; }, (a) => { a.selectedArm = 'eval-sol-20260709'; },
    (a) => { a.authorizationRef = 'https://example.test/private'; },
    (a) => { a.authorizationRef = 'x'.repeat(161); },
    (a) => { a.shapeCapture = 'histogram'; }, (a) => { a.priorCommittedCentsEur = -1; },
    (a) => { a.priorCommittedCentsEur = Number.MAX_SAFE_INTEGER; },
    (a) => { a.aggregateLimitCentsEur = 749; }, (a) => { a.aggregateLimitCentsEur = Infinity; },
    (a) => { a.aggregateLimitCentsEur = '750'; }, (a) => { a.priorCommittedCentsEur = 500.5; },
  ]) {
    const a = authorization(); change(a);
    assert.throws(() => validateSingleAuthorization(a), /SINGLE_AUTHORIZATION_INVALID/);
  }
  for (const args of [
    ['init', 'private-location', 'approval.json'], ['init-single', 'private-location', 'input.json'],
    ['send', 'private-location', 'sol'], ['send', 'private-location', 'sol', 'a'.repeat(64)],
    ['send', 'private-location', 'terra'], ['status', 'private-location'], ['abandon', 'private-location'],
  ]) assert.equal(parseArguments(args).command, args[0]);
  for (const args of [
    ['init-single', 'private-location'], ['init-single', 'private-location', 'input.json', 'sol'],
    ['send', 'private-location', 'sol', 'invalid'], ['send', 'private-location', 'terra', 'a'.repeat(64)],
    ['send', 'private-location', 'sol', 'a'.repeat(64), 'extra'], ['status', 'private-location', 'extra'],
    ['send', 'private-location', 'other'], ['reset', 'private-location'],
  ]) assert.throws(() => parseArguments(args), /USAGE/);
});

test('selected single arm sends once without a prior opposite-arm result or token', async (t) => {
  for (const arm of ['terra', 'sol']) {
    const directory = await singleFixture(t, { selectedArm: arm, shapeCapture: 'off' });
    const opposite = arm === 'terra' ? 'sol' : 'terra';
    let calls = 0;
    const sender = async () => {
      calls++;
      const state = await readLedger(directory);
      assert.equal(state.slots[opposite], null);
      assert.equal(state.slots[arm].intent.runBinding, state.runBinding);
      assert.equal(state.slots[arm].intent.reservationCentsEur, 250);
      return reply(envelope(arm));
    };
    await assert.rejects(executeSlot(singleOptions(directory, { arm: opposite, sender })), /SINGLE_ARM_OR_TOKEN_INVALID/);
    await assert.rejects(executeSlot(singleOptions(directory, { arm, sender, reviewFirst: 'a'.repeat(64) })), /SINGLE_ARM_OR_TOKEN_INVALID/);
    assert.equal(calls, 0);
    const result = await executeSlot(singleOptions(directory, { arm, sender }));
    assert.equal(result.state, 'SUCCESS');
    assert.equal(result.usageShape, null);
    assert.equal(Object.keys(result).length, 11);
    const report = summary(await readLedger(directory));
    assert.equal(report.mode, 'single');
    assert.equal(report.authorizationRef, 'synthetic-a2-approval');
    assert.deepEqual(report.operatorAttestedAccounting, { priorCommittedCentsEur: 500, aggregateLimitCentsEur: 750 });
    assert.equal(report.slots[arm].reviewToken, null);
    assert.equal(report.slots[opposite].state, 'NOT_PLANNED');
    await assert.rejects(executeSlot(singleOptions(directory, { arm, sender })), /SLOT_CONSUMED/);
    await assert.rejects(executeSlot(singleOptions(directory, { arm: opposite, sender })), /SINGLE_ARM_OR_TOKEN_INVALID/);
    assert.equal(calls, 1);
  }
});

test('single initialization cannot overwrite pair history or accept ambiguous input', async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, 'pilot.jsonl');
  const before = await readFile(file);
  for (const input of [
    { approval: approval() }, { approval: approval(), authorization: authorization(), extra: true },
  ]) await assert.rejects(initializeSingle(directory, input), /SINGLE_INPUT_INVALID/);
  await assert.rejects(initializeSingle(directory, { approval: approval(), authorization: authorization() }), /LEDGER_WRITE_UNCERTAIN/);
  assert.deepEqual(await readFile(file), before);
});

test('single mode preserves abandonment, stale locks, intent-only and failure stops', async (t) => {
  const unused = await singleFixture(t);
  await abandon(unused);
  const unusedReport = summary(await readLedger(unused));
  assert.equal(unusedReport.slots.sol.state, 'NOT_ATTEMPTED');
  assert.equal(unusedReport.slots.terra.state, 'NOT_PLANNED');
  await assert.rejects(executeSlot(singleOptions(unused)), /ABANDONED/);
  const stale = await singleFixture(t);
  await mkdir(path.join(stale, 'pilot.lock'));
  await assert.rejects(executeSlot(singleOptions(stale)), /LOCKED_NO_AUTOMATIC_RECOVERY/);
  for (const sender of [
    async () => { throw new Error('synthetic private network detail'); },
    async () => reply({}),
    async () => { const d = envelope('sol'); d.choices[0].message.refusal = 'refused'; return reply(d); },
  ]) {
    const directory = await singleFixture(t);
    const result = await executeSlot(singleOptions(directory, { sender }));
    assert.equal(result.usageShape, null);
    assert.equal(Object.keys(result).length, 11);
    const state = await readLedger(directory);
    assert.equal(state.slots.sol.intent.reservationCentsEur, 250);
    await assert.rejects(executeSlot(singleOptions(directory)), /SLOT_CONSUMED/);
    const file = path.join(directory, 'pilot.jsonl');
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    await writeFile(file, lines.slice(0, 2).join('\n') + '\n');
    assert.equal(summary(await readLedger(directory)).slots.sol.state, 'UNCERTAIN_INTENT');
    await assert.rejects(executeSlot(singleOptions(directory)), /SLOT_CONSUMED/);
  }
});

test('locked single authorization is reloaded rather than taken from outer state', async (t) => {
  const directory = await singleFixture(t);
  const outer = await readLedger(directory);
  assert.equal(outer.authorization.selectedArm, 'sol');
  await abandon(directory);
  let calls = 0;
  await assert.rejects(executeSlot(singleOptions(directory, {
    sender: async () => { calls++; return reply(); },
  })), /ABANDONED/);
  assert.equal(calls, 0);
});

test('single header and intent bindings reject changed mode, arm, photo and control associations', async (t) => {
  const directory = await singleFixture(t);
  await executeSlot(singleOptions(directory));
  const filename = path.join(directory, 'pilot.jsonl');
  const original = await readFile(filename, 'utf8');
  for (const change of [
    (e) => { delete e[0].authorization; }, (e) => { delete e[0].runBinding; },
    (e) => { e[0].extra = true; }, (e) => { e[0].controlsDigest = e[0].controls; delete e[0].controls; },
    (e) => { e[0].authorization.selectedArm = 'terra'; },
    (e) => { e[0].authorization.shapeCapture = 'off'; },
    (e) => { e[0].approval.photo.sha256 = 'a'.repeat(64); },
    (e) => { e[0].runBinding = 'a'.repeat(64); },
    (e) => { e[1].runBinding = 'a'.repeat(64); }, (e) => { delete e[1].runBinding; },
    (e) => { e[1].arm = 'terra'; }, (e) => { e[1].reviewFirst = 'a'.repeat(64); },
    (e) => { e.push({ ...e[1], arm: 'terra' }); },
    (e) => { delete e[2].observation.usageShape; },
  ]) {
    const events = original.trimEnd().split('\n').map((line) => JSON.parse(line));
    change(events);
    await writeFile(filename, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await assert.rejects(readLedger(directory), PilotError);
  }
});

test('usage extensions and unconsumed public breakdowns do not change acceptance or estimates', async (t) => {
  for (const arm of ['terra', 'sol']) {
    const baseline = inspectResponse(reply(envelope(arm)), arm);
    const data = envelope(arm);
    const entries = [
      ['__proto__', { nested_secret: 'PRIVATE_VALUE' }], ['constructor', ['PRIVATE_VALUE']],
      ['toString', 'PRIVATE_VALUE'], ['unknown_null', null], ['unknown_boolean', true], ['unknown_number', 12345],
    ];
    for (const container of [data.usage, data.usage.prompt_tokens_details, data.usage.completion_tokens_details]) {
      for (const [name, value] of entries) {
        Object.defineProperty(container, name, { value, enumerable: true });
      }
    }
    data.usage.prompt_tokens_details.text_tokens = 1000;
    data.usage.prompt_tokens_details.image_tokens = 2000;
    data.usage.completion_tokens_details.text_tokens = 300;
    assert.deepEqual(inspectResponse(reply(data), arm), baseline);
    const directory = await singleFixture(t, { selectedArm: arm });
    const result = await executeSlot(singleOptions(directory, { arm, sender: async () => reply(data) }));
    assert.deepEqual({ ...result, elapsedMs: 0 }, { ...baseline, usageShape: null });
    const state = await readLedger(directory);
    assert.deepEqual(state.slots[arm].result, result);
    const report = summary(state);
    assert.equal(report.slots[arm].captureStatus, null);
    assert.equal(report.slots[arm].reviewToken, null);
    assert.equal(report.slots[arm].estimatedMicroUsd, arm === 'terra' ? '13200' : '24200');
    assert.equal(report.slots[arm].reservationCentsEur, 250);
    assert.doesNotMatch(JSON.stringify(report), /__proto__|constructor|toString|unknown_null|"entries"|"usageShape"/);
    assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /PRIVATE_VALUE|nested_secret|12345|text_tokens|image_tokens/);
    await assert.rejects(executeSlot(singleOptions(directory, { arm })), /SLOT_CONSUMED/);
    for (const value of [null, 'not-a-count', -1, {}, [], 999999]) {
      data.usage.prompt_tokens_details.text_tokens = value;
      data.usage.prompt_tokens_details.image_tokens = value;
      data.usage.completion_tokens_details.text_tokens = value;
      assert.deepEqual(inspectResponse(reply(data), arm), baseline);
    }
  }
});

test('only the known audio and prediction detail names require absent, zero or null', () => {
  for (const [section, field, names] of [
    ['prompt_tokens_details', 'PROMPT_DETAILS', ['audio_tokens']],
    ['completion_tokens_details', 'COMPLETION_DETAILS', ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ]) {
    for (const name of names) {
      for (const value of [undefined, null, 0]) {
        const data = envelope();
        if (value === undefined) delete data.usage[section][name];
        else data.usage[section][name] = value;
        assert.equal(inspectResponse(reply(data), 'terra').state, 'SUCCESS');
      }
      for (const value of [1, -1, 0.5, '0', false, true, {}, []]) {
        const data = envelope();
        data.usage[section][name] = value;
        data.usage.synthetic_extension = { ignored: 'PRIVATE_VALUE' };
        const result = inspectResponse(reply(data), 'terra');
        assert.equal(result.state, 'HALTED');
        assert.equal(result.reason, 'USAGE_INVALID');
        assert.equal(result.usage, null);
        assert.equal(result.facts, null);
        assert.deepEqual(result.usageDiagnostic, { field, condition: 'UNEXPECTED_COMPONENT' });
        assert.equal(result.unacceptedCandidate.status, 'UNACCEPTED_METERING');
        delete data.usage.prompt_tokens_details.cache_write_tokens;
        assert.deepEqual(inspectResponse(reply(data), 'terra').usageDiagnostic, { field: 'CACHE_WRITE', condition: 'MISSING' });
      }
    }
  }
  const data = envelope();
  data.usage.audio_tokens = 1;
  data.usage.prompt_tokens_details.accepted_prediction_tokens = 1;
  data.usage.completion_tokens_details.future_audio_tokens = 1;
  assert.equal(inspectResponse(reply(data), 'terra').state, 'SUCCESS');
});

test('both bound capture choices leave fresh single usageShape null across response branches', async (t) => {
  const off = await singleFixture(t, { shapeCapture: 'off' });
  const offResult = await executeSlot(singleOptions(off, { sender: async () => reply(shapeEnvelope()) }));
  assert.equal(offResult.usageShape, null);
  assert.equal((await readLedger(off)).slots.sol.result.usageShape, null);
  const pair = inspectResponse(reply(shapeEnvelope([['extra_meter', 123]], 'terra')), 'terra');
  assert.equal(pair.reason, 'OK');
  assert.equal(Object.keys(pair).length, 10);
  assert.equal(Object.hasOwn(pair, 'usageShape'), false);
  for (const [change, state, reason] of [
    [(d) => { d.model = 'gpt-5.6-terra'; }, 'HALTED', 'MODEL_ANOMALY'],
    [(d) => { d.store = true; }, 'HALTED', 'CONTROL_ANOMALY'],
    [(d) => { d.choices[0].message.refusal = 'refused'; }, 'FAILED', 'REFUSED'],
    [(d) => { d.choices[0].finish_reason = 'length'; }, 'FAILED', 'TRUNCATED'],
    [(d) => { d.choices[0].finish_reason = 'content_filter'; }, 'FAILED', 'FILTERED'],
    [(d) => { d.choices[0].message.content = '{}'; }, 'HALTED', 'DOMAIN_INVALID'],
    [(d) => { d.usage.prompt_tokens_details.cache_write_tokens = 1; }, 'HALTED', 'CACHE_ANOMALY'],
    [(d) => { d.usage.prompt_tokens = 8193; d.usage.total_tokens = 8693; }, 'HALTED', 'INPUT_ANOMALY'],
    [(d) => { delete d.usage.prompt_tokens_details.cache_write_tokens; }, 'HALTED', 'USAGE_INVALID'],
  ]) {
    const directory = await singleFixture(t);
    const data = shapeEnvelope(); change(data);
    const result = await executeSlot(singleOptions(directory, { sender: async () => reply(data) }));
    assert.equal(result.state, state);
    assert.equal(result.reason, reason);
    assert.equal(result.usageShape, null);
    assert.equal(Object.keys(result).length, 11);
    assert.equal((await readLedger(directory)).slots.sol.result.usageShape, null);
  }
  for (const shapeCapture of ['off', 'private-names-types-v1']) {
    for (const sender of [
      async () => { throw new Error('PRIVATE_VALUE'); },
      async () => { throw new PilotError('RESPONSE_BOUND'); },
      async () => reply(null),
      async () => ({ ...reply(), body: Buffer.from('{') }),
      async () => ({ ...reply(), status: 500 }),
    ]) {
      const directory = await singleFixture(t, { shapeCapture });
      const result = await executeSlot(singleOptions(directory, { sender }));
      assert.equal(result.state, 'HALTED');
      assert.equal(result.usageShape, null);
      assert.equal(Object.keys(result).length, 11);
      assert.deepEqual((await readLedger(directory)).slots.sol.result, result);
      assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /PRIVATE_VALUE/);
    }
  }
});

test('unconsumed names are not captured regardless of old shape bounds', async (t) => {
  for (const entries of [
    [['safe', 0], ['x'.repeat(49), 0]], [['safe', 0], ['name-with-dash', 0]],
    [['name\ncontrol', 0]], [['name\n', 0]], [['name\r', 0]], [['name\u2028', 0]],
    [['\u00e4', 0]], [['', 0]], [['3leading', 0]],
    Array.from({ length: 9 }, (_, i) => [`field_${i}`, { secret: 'PRIVATE_VALUE' }]),
  ]) {
    const directory = await singleFixture(t);
    const result = await executeSlot(singleOptions(directory, { sender: async () => reply(shapeEnvelope(entries)) }));
    assert.equal(result.state, 'SUCCESS');
    assert.equal(result.usageShape, null);
    assert.equal((await readLedger(directory)).slots.sol.result.usageShape, null);
    assert.equal(summary(await readLedger(directory)).slots.sol.captureStatus, null);
    assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /PRIVATE_VALUE|name-with-dash|field_0/);
  }
});

test('fresh results never capture synthetic key-bearing extension names in any casing', async (t) => {
  const key = 'SYNTHETIC_KEY_123456';
  const directory = await singleFixture(t);
  const data = shapeEnvelope([[`prefix_${key}_suffix`, { ignored: 'PRIVATE_VALUE' }]]);
  const parsed = inspectResponse(reply(data), 'sol');
  assert.equal(Object.hasOwn(parsed, 'usageShape'), false);
  const ordinary = { ...inspectResponse(reply(envelope('sol')), 'sol'), usageShape: null };
  const returned = await executeSlot(singleOptions(directory, { key, sender: async () => reply(data) }));
  assert.deepEqual(returned.usageShape, ordinary.usageShape);
  assert.deepEqual({ ...returned, elapsedMs: 0 }, ordinary);
  const state = await readLedger(directory);
  assert.deepEqual(state.slots.sol.result, returned);
  assert.equal(summary(state).slots.sol.reviewToken, null);
  assert.doesNotMatch(JSON.stringify(returned), /SYNTHETIC_KEY|prefix_|PRIVATE_VALUE/);
  assert.doesNotMatch(await readFile(path.join(directory, 'pilot.jsonl'), 'utf8'), /SYNTHETIC_KEY|prefix_|PRIVATE_VALUE/);
  assert.doesNotMatch(JSON.stringify(summary(state)), /SYNTHETIC_KEY|prefix_|PRIVATE_VALUE/);
  const caseDirectory = await singleFixture(t);
  const caseResult = await executeSlot(singleOptions(caseDirectory, {
    key, sender: async () => reply(shapeEnvelope([[key.toLowerCase(), 0]])),
  }));
  assert.equal(caseResult.usageShape, null);
  assert.doesNotMatch(JSON.stringify(caseResult), /synthetic_key/);
  assert.doesNotMatch(await readFile(path.join(caseDirectory, 'pilot.jsonl'), 'utf8'), /synthetic_key/);
  assert.doesNotMatch(JSON.stringify(summary(await readLedger(caseDirectory))), /synthetic_key/);
  const precondition = await singleFixture(t);
  await assert.rejects(executeSlot(singleOptions(precondition, { key: '' })), /PRIVATE_KEY_REQUIRED/);
});

test('strict single shape replay rejects partial, forged, duplicate, over-bound and ineligible entries', async (t) => {
  const directory = await historicalA2Fixture(t, A2_CAPTURED);
  const file = path.join(directory, 'pilot.jsonl');
  const original = await readFile(file, 'utf8');
  for (const change of [
    (o) => { delete o.usageShape; }, (o) => { delete o.usageDiagnostic; },
    (o) => { o.usageShape.extra = true; }, (o) => { o.usageShape.status = 'UNKNOWN'; },
    (o) => { o.usageShape.status = 'SUPPRESSED'; },
    (o) => { o.usageShape.entries = []; },
    (o) => { o.usageShape.entries.push(o.usageShape.entries[0]); },
    (o) => { o.usageShape.entries[0].name = 'prompt_tokens'; },
    (o) => { o.usageShape.entries[0].name = '__unsafe\n'; },
    (o) => { o.usageShape.entries[0].name = 'trailing\r'; },
    (o) => { o.usageShape.entries[0].name = 'trailing\u2028'; },
    (o) => { o.usageShape.entries[0].name = ''; },
    (o) => { o.usageShape.entries[0].name = '3leading'; },
    (o) => { o.usageShape.entries[0].name = 'name-with-dash'; },
    (o) => { o.usageShape.entries[0].name = '\u00e4'; },
    (o) => { o.usageShape.entries[0].name = 'x'.repeat(49); },
    (o) => { o.usageShape.entries[0].type = 'undefined'; },
    (o) => { o.usageShape.entries[0].value = 'PRIVATE_VALUE'; },
    (o) => { o.usageShape.entries = Array.from({ length: 9 }, (_, i) => ({ name: `field${i}`, type: 'null' })); },
    (o) => { o.usageShape.entries[0].name = 'x'.repeat(1100); },
    (o) => { o.unacceptedCandidate = null; },
    (o) => { o.returnedModel = 'gpt-5.6-terra'; },
    (o) => { o.usageDiagnostic = { field: 'CACHE_WRITE', condition: 'MISSING' }; },
  ]) {
    const events = original.trimEnd().split('\n').map((line) => JSON.parse(line));
    change(events[2].observation);
    await writeFile(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await assert.rejects(readLedger(directory), /LEDGER_INVALID/);
  }
  const off = await singleFixture(t, { shapeCapture: 'off' });
  await executeSlot(singleOptions(off, { sender: async () => reply(shapeEnvelope()) }));
  const offFile = path.join(off, 'pilot.jsonl');
  const offEvents = (await readFile(offFile, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  offEvents[2].observation = A2_SUPPRESSED;
  await writeFile(offFile, offEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await assert.rejects(readLedger(off), /LEDGER_INVALID/);
  const pairDirectory = await fixture(t);
  await executeSlot(options(pairDirectory));
  const pairFile = path.join(pairDirectory, 'pilot.jsonl');
  const pairEvents = (await readFile(pairFile, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  pairEvents[2].observation.usageShape = null;
  await writeFile(pairFile, pairEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await assert.rejects(readLedger(pairDirectory), /LEDGER_INVALID/);
});

test('largest historical name/type shape fits measured serialized limits and replay', async (t) => {
  const result = historicalA2Observation({ status: 'CAPTURED',
    entries: Array.from({ length: 8 }, (_, i) => ({ name: `${'x'.repeat(47)}${i}`, type: 'boolean' })) });
  const directory = await historicalA2Fixture(t, result);
  const shapeBytes = Buffer.byteLength(JSON.stringify(result.usageShape));
  assert.equal(result.usageShape.status, 'CAPTURED');
  assert.equal(shapeBytes, 649);
  assert.ok(shapeBytes <= 1024);
  const journal = await readFile(path.join(directory, 'pilot.jsonl'));
  const record = journal.toString().trimEnd().split('\n').at(-1) + '\n';
  assert.ok(Buffer.byteLength(record) < 131072);
  assert.ok(journal.length < 131072);
  assert.deepEqual((await readLedger(directory)).slots.sol.result, result);
  t.diagnostic(`Synthetic maximum name/type shape: ${shapeBytes} bytes; result record: ${Buffer.byteLength(record)}; journal: ${journal.length}. The 1024-byte cap is defensive, not reached by valid eight-entry shapes.`);
});
