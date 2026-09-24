import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const spec = readFileSync(new URL('../browser/ai-photo-first.spec.ts', import.meta.url), 'utf8');
const mock = readFileSync(new URL('../browser/mock-backend.ts', import.meta.url), 'utf8');
const parse = (text: string) => ts.createSourceFile('extracted.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function matching(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
function unique(text: string, predicate: (node: ts.Node) => boolean): ts.Node {
  const found = matching(parse(text), predicate);
  expect(found).toHaveLength(1);
  return found[0]!;
}
function floor(node: ts.Node, minimum: number) {
  expect(matching(node, () => true).length).toBeGreaterThanOrEqual(minimum);
}
function functionText(text: string, name: string, minimum: number) {
  const node = unique(text, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!ts.isFunctionDeclaration(node) || !node.body || !ts.isBlock(node.body)) throw new Error('Invalid extracted function');
  floor(node.body, minimum);
  return node.getText();
}
function declaration(text: string, name: string, minimum: number, arrow = false) {
  const node = unique(text, node => ts.isVariableDeclaration(node) && node.name.getText() === name);
  if (!ts.isVariableDeclaration(node) || !node.initializer || arrow && !ts.isArrowFunction(node.initializer)) {
    throw new Error('Invalid extracted declaration');
  }
  floor(node.initializer, minimum);
  return node;
}
function entryText() {
  const start = '      let observedPost: RawAnalysisPost | undefined;', end = '      let terminal = false;';
  expect(mock.split(start)).toHaveLength(2); expect(mock.split(end)).toHaveLength(2);
  const from = mock.indexOf(start), to = mock.indexOf(end);
  expect(from).toBeGreaterThanOrEqual(0); expect(to).toBeGreaterThan(from);
  const text = mock.slice(from, to), fragment = parse(text);
  expect(fragment.statements.length).toBeGreaterThanOrEqual(2);
  const first = fragment.statements[0]!;
  if (!ts.isVariableStatement(first)) throw new Error('Invalid receiver entry');
  expect(first.declarationList.declarations[0]!.name.getText()).toBe('observedPost');
  expect(fragment.statements.some(ts.isIfStatement)).toBe(true);
  return text;
}
const copier = functionText(spec, 'copyRawAnalysisClient', 100);
const factory = functionText(spec, 'rawAnalysisEvidence', 30);
const mapper = functionText(spec, 'snapshotRawAnalysis', 300);
const sender = functionText(spec, 'sendBrowserAnalysis', 200);
const rejection = functionText(mock, 'rawAnalysisRejection', 30);
const initializer = declaration(mock, 'rawAnalysisObservation', 15).initializer!.getText();
const reject = declaration(mock, 'reject', 60, true).getText();
const entry = entryText();
function execute(text: string, globals: Record<string, unknown> = {}): unknown {
  const output = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true,
  });
  expect(output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
  return runInNewContext(output.outputText, { Buffer, Blob, AbortSignal, ...globals }, { timeout: 1000 });
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected record');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}
const base = () => record(execute(`const options={observeRawAnalysis:true}; (${initializer});`));
const boundary = () => ({ mode: 'boundary-framing-v1', overflow: false, evidenceError: false, receivers: [] as unknown[] });
const observed = (): Record<string, unknown> & { boundaryDetail: ReturnType<typeof boundary> } => ({ ...base(), boundaryDetail: boundary() });
function request(length: unknown = '1', transfer?: unknown, readable: unknown = 0, method = 'POST') {
  return { method, headers: { 'content-length': length, 'transfer-encoding': transfer },
    readableLength: readable, complete: false, readableEnded: false, aborted: false };
}
function capture(observation: Record<string, unknown>, req: object) {
  return execute(`(() => { ${entry} return observedPost; })();`,
    { rawObservation: observation, request: req, analysisState: { forwarded: Number(observation.postCount) + 1 } });
}
const totals = () => ({ forwarded: 2, posts: 2, callbacks: 2, receivedBytes: 512001, payloadBytes: 512001, active: 0, timedOut: 0 });
function snapshot(kind: string, observation: Record<string, unknown>, clients: unknown[], counts = totals()) {
  return record(execute(`${copier}\n${factory}\n${mapper}
    const evidence=rawAnalysisEvidence(kind);
    snapshotRawAnalysis(evidence,{rawAnalysisObservation:observation,analysisWire:counts},clients);
    evidence;`, { kind, observation, clients, counts }));
}
function rejectWith(observation: Record<string, unknown>, post: unknown, req: object, status: number, guard: string, terminal = false) {
  execute(`${rejection}
    (() => { const response={destroyed:false},identity={},closing=false,analysisState={rejected:0},finish=()=>{};
    const ${reject}; reject(status,guard); })();`,
  { rawObservation: observation, observedPost: post, request: req, status, guard, terminal });
}
const canary = 'private-synthetic-observation-canary';

describe('durable raw analysis boundary observation (extracted source only)', () => {
  it('extracts unique real functions, initializer, reject arrow and non-vacuous receiver entry', () => {
    expect([copier, factory, mapper, sender, rejection, initializer, reject, entry].every(text => text.length > 50)).toBe(true);
    expect(base()).toEqual({ postCount: 0, overflow: false, evidenceError: false, posts: [], firstAttemptedPost400: null });
    expect(Object.hasOwn(base(), 'boundaryDetail')).toBe(false);
  });
  it.each([0, 1, 512000, 512001])('retains constructed size %s in boundary response and rejection snapshots', size => {
    for (const outcome of ['response', 'network-rejection']) {
      const client = { status: outcome === 'response' ? 200 : null, outcome, constructedBytes: size };
      const result = snapshot('boundaries', observed(), [client]);
      expect(result.captureError).toBe(false); expect(result.client).toEqual([client]);
    }
  });
  it.each([-1, 1.5, NaN, Infinity, 512002, undefined, canary])('refuses invalid/missing constructed size %s', size => {
    const result = snapshot('boundaries', observed(), [{ status: 200, outcome: 'response', constructedBytes: size }]);
    expect(result.captureError).toBe(true); expect(result.client).toEqual([null]);
    expect(JSON.stringify(result)).not.toContain(canary);
  });
  it('executes the actual sender with no network, preserving default shape and opt-in zero on rejection', async () => {
    for (const fail of [false, true]) for (const size of [0, 1, 512000]) for (const optIn of [false, true]) {
      const calls: Array<{ size: number; method: unknown; credentials: unknown }> = [];
      const bodies: Array<{ typed: boolean; byteLength: number }> = [];
      const result = record(await execute(`${sender}
        sendBrowserAnalysis({evaluate:(callback,args)=>callback(args)},
          {issuedWireAuthorization:()=> 'synthetic'},'valid',Buffer.alloc(size),optIn);`, {
        size, optIn, analysisIds: () => ({ requestId: 'synthetic', draftId: 'synthetic', generation: '1' }),
        analysisPath: '/synthetic', fixtureKey: 'synthetic', Uint8Array,
        fetch: async (_url: unknown, input: unknown) => {
          const options = record(input);
          if (!(options.body instanceof Uint8Array)) throw new Error('Expected constructed Uint8Array');
          bodies.push({ typed: options.body instanceof Uint8Array, byteLength: options.body.byteLength });
          calls.push({ size: options.body.byteLength, method: options.method, credentials: options.credentials });
          if (fail) throw new Error(canary);
          return { status: 200 };
        },
      }));
      expect(result).toEqual({ status: fail ? null : 200, outcome: fail ? 'network-rejection' : 'response',
        ...(optIn ? { constructedBytes: size } : {}) });
      expect(calls).toEqual([{ size, method: 'POST', credentials: 'omit' }]);
      expect(bodies).toEqual([{ typed: true, byteLength: size }]);
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });
  it('projects only closed framing/readable categories and preserves entry booleans', () => {
    const lengths: Array<[unknown, string]> = [[undefined, 'absent'], ['0', 'zero'], ['1', '1'], ['512000', '512000'],
      ['17', 'other'], ['', 'invalid'], ['-1', 'invalid'], ['1.5', 'invalid'], ['9007199254740992', 'invalid'],
      [['1'], 'invalid'], [canary, 'invalid']];
    const transfers: Array<[unknown, string]> = [[undefined, 'absent'], ['chunked', 'chunked'], [canary, 'other']];
    const readables: Array<[unknown, string]> = [[0, 'zero'], [1, '1'], [512000, '512000'], [17, 'other'],
      [-1, 'invalid'], [1.5, 'invalid'], [NaN, 'invalid'], [Infinity, 'invalid'], [undefined, 'invalid']];
    for (const [length, contentLength] of lengths) {
      const observation = observed(), req = request();
      req.headers['content-length'] = length; capture(observation, req);
      expect(observation.boundaryDetail.receivers).toEqual([{ ordinal: 1, contentLength, transferEncoding: 'absent',
        complete: false, readableEnded: false, readableLength: 'zero' }]);
    }
    for (const [transfer, transferEncoding] of transfers) for (const [readable, readableLength] of readables) {
      const observation = observed(), req = request('1', transfer);
      req.readableLength = readable; req.complete = true; req.readableEnded = true; capture(observation, req);
      expect(observation.boundaryDetail.receivers).toEqual([{ ordinal: 1, contentLength: '1', transferEncoding,
        complete: true, readableEnded: true, readableLength }]);
      expect(JSON.stringify(observation)).not.toContain(canary);
    }
  });
  it('does not add runtime detail or diagnostic request accesses without the closed POST opt-in', () => {
    let reads = 0;
    const req = { method: 'POST' };
    for (const key of ['headers', 'readableLength', 'complete', 'readableEnded']) {
      Object.defineProperty(req, key, { get() { reads++; throw new Error(canary); } });
    }
    const normal = base(); capture(normal, req);
    expect(Object.hasOwn(normal, 'boundaryDetail')).toBe(false);
    const invalid = { ...base(), boundaryDetail: { ...boundary(), mode: canary } };
    capture(invalid, req);
    const options = observed(); req.method = 'OPTIONS'; capture(options, req);
    expect(reads).toBe(0); expect(options.postCount).toBe(0); expect(options.boundaryDetail.receivers).toEqual([]);
  });
  it('bounds boundary records at two without changing max-four base posts or undefined-post behavior', () => {
    const observation = observed();
    for (let i = 0; i < 4; i++) capture(observation, request());
    expect(observation.boundaryDetail.receivers.map(value => record(value).ordinal)).toEqual([1, 2]);
    expect(observation.boundaryDetail.overflow).toBe(true); expect(observation.boundaryDetail.evidenceError).toBe(true);
    expect(array(observation.posts)).toHaveLength(4); expect(observation.overflow).toBe(false);
    const retained = JSON.stringify(observation.boundaryDetail);
    expect(capture(observation, request())).toBeUndefined();
    expect(JSON.stringify(observation.boundaryDetail)).toBe(retained);
    expect(observation.postCount).toBe(5); expect(observation.overflow).toBe(true); expect(observation.evidenceError).toBe(true);
    const invalid = observed(); invalid.postCount = -1; capture(invalid, request());
    expect(invalid.boundaryDetail.receivers).toEqual([]); expect(invalid.boundaryDetail.evidenceError).toBe(true);
  });
  it('retains the first attempted 400 on the second POST and original post-terminal accounting', () => {
    const observation = observed(), req = request();
    req.complete = true; req.readableEnded = true;
    const first = capture(observation, req); rejectWith(observation, first, req, 413, 'body-limit');
    expect(observation.firstAttemptedPost400).toBeNull();
    const second = capture(observation, req); rejectWith(observation, second, req, 400, 'end-empty');
    expect(observation.firstAttemptedPost400).toMatchObject({ ordinal: 2, guard: 'end-empty', receivedBytes: 0, acceptedBytes: 0 });
    const retained = JSON.stringify(observation.firstAttemptedPost400);
    rejectWith(observation, first, req, 400, 'request-error');
    rejectWith(observation, second, req, 400, 'aborted', true);
    rejectWith(observation, second, req, 400, 'request-error', true);
    expect(JSON.stringify(observation.firstAttemptedPost400)).toBe(retained);
    expect(record(second).postTerminalRejects).toBe(2);
    expect(record(second).firstPostTerminalReject).toMatchObject({ ordinal: 2, guard: 'aborted' });
  });
  it('copies partial boundary evidence, base posts, rejection and cumulative totals independently', () => {
    const observation = observed(), req = request(), counts = totals();
    const post = capture(observation, req); rejectWith(observation, post, req, 400, 'end-empty');
    const result = snapshot('boundaries', observation, [{ status: null, outcome: 'network-rejection', constructedBytes: 0 }, null], counts);
    expect(result.captureError).toBe(false); expect(array(result.client)[1]).toBeNull();
    expect(array(record(record(result.observation).boundaryDetail).receivers)).toHaveLength(1);
    const retained = JSON.stringify(result);
    record(observation.boundaryDetail.receivers[0]).contentLength = 'zero';
    record(post).receivedBytes = 12; record(observation.firstAttemptedPost400).guard = 'aborted'; counts.posts = 100;
    expect(JSON.stringify(result)).toBe(retained);
  });
  it('rejects invalid boundary details/records without losing copied cumulative totals or leaking inputs', () => {
    const mutations: Array<(observation: Record<string, unknown>) => void> = [
      value => { delete value.boundaryDetail; },
      ...[['mode', canary], ['overflow', 0], ['evidenceError', null], ['receivers', null], ['extra', canary]]
        .map(([key, value]) => (observation: Record<string, unknown>) => { record(observation.boundaryDetail)[String(key)] = value; }),
      ...[['ordinal', 3], ['contentLength', canary], ['transferEncoding', canary], ['readableLength', canary],
        ['complete', 0], ['readableEnded', null], ['extra', canary]]
        .map(([key, value]) => (observation: Record<string, unknown>) => {
          record(array(record(observation.boundaryDetail).receivers)[0])[String(key)] = value;
        }),
    ];
    for (const mutate of mutations) {
      const observation = observed(), counts = totals(); capture(observation, request()); mutate(observation);
      const result = snapshot('boundaries', observation, [], counts);
      expect(result.captureError).toBe(true); expect(result.cumulative).toEqual(totals());
      counts.posts = 999; expect(record(result.cumulative).posts).toBe(2);
      expect(JSON.stringify(result)).not.toContain(canary);
    }
  });
  it('flags overflow/error evidence and more-than-two records while keeping bounded snapshots', () => {
    for (const key of ['overflow', 'evidenceError']) {
      const observation = observed(); record(observation.boundaryDetail)[key] = true;
      expect(snapshot('boundaries', observation, []).captureError).toBe(true);
    }
    const observation = observed(); capture(observation, request()); capture(observation, request());
    observation.boundaryDetail.receivers.push({ ...record(observation.boundaryDetail.receivers[1]) });
    const result = snapshot('boundaries', observation, []);
    expect(result.captureError).toBe(true);
    expect(array(record(record(result.observation).boundaryDetail).receivers)).toHaveLength(2);
  });
  it.each(['oversized', 'response-sequence'])('preserves exact %s serialization and deep copy', kind => {
    const observation = base();
    const detail = { routePosts: 4, receiverPosts: 4, overflow: false, evidenceError: false,
      routes: Array.from({ length: 4 }, (_, i) => ({ ordinal: i + 1, body: '4096' })),
      receivers: Array.from({ length: 4 }, (_, i) => ({ ordinal: i + 1, contentLength: '4096', transferEncoding: 'absent',
        complete: false, readableEnded: false, readableLength: 'zero' })) };
    if (kind === 'response-sequence') observation.detail = detail;
    const clients = Array.from({ length: kind === 'response-sequence' ? 4 : 1 },
      () => ({ status: 200, outcome: 'response', constructedBytes: 4096 }));
    const expected = { case: kind, project: null, retry: null, repeat: null, fixturePresent: true,
      snapshotPhase: 'before-cleanup', cleanupStarted: false, cleanupCompleted: false, captureError: false,
      client: clients,
      observation: { postCount: 0, overflow: false, evidenceError: false, posts: [], firstAttemptedPost400: null,
        ...(kind === 'response-sequence' ? { detail } : {}) }, cumulative: totals() };
    expect(JSON.stringify(snapshot(kind, observation, clients))).toBe(JSON.stringify(expected));
    if (kind === 'response-sequence') {
      const copied = snapshot(kind, observation, clients); detail.routes[0]!.body = 'other';
      expect(JSON.stringify(copied)).not.toContain('"body":"other"');
      detail.receivers.push({ ...detail.receivers[0]! });
      expect(snapshot(kind, observation, clients).captureError).toBe(true);
    }
  });
  it('omits even an injected boundary property from all non-boundary snapshots', () => {
    for (const kind of ['oversized', 'response-sequence']) {
      const observation = base();
      if (kind === 'response-sequence') observation.detail = {
        routePosts: 0, receiverPosts: 0, overflow: false, evidenceError: false, routes: [], receivers: [],
      };
      const expected = JSON.stringify(snapshot(kind, observation, []));
      observation.boundaryDetail = { mode: canary };
      const result = snapshot(kind, observation, []);
      expect(JSON.stringify(result)).toBe(expected);
      expect(Object.hasOwn(record(result.observation), 'boundaryDetail')).toBe(false);
    }
  });
  it('wires only the existing two boundary sends and preserves assignment/assertion/finally order', () => {
    const title = 'analysis browser wire admits exactly the one-byte and 512000-byte boundaries';
    const testCall = unique(spec, node => ts.isCallExpression(node) && node.expression.getText() === 'test'
      && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title);
    if (!ts.isCallExpression(testCall) || !testCall.arguments[1] || !ts.isArrowFunction(testCall.arguments[1])) throw new Error('Invalid boundary case');
    const body = testCall.arguments[1].body;
    const optIns = matching(parse(spec), node => ts.isBinaryExpression(node)
      && node.left.getText() === 'api.rawAnalysisObservation.boundaryDetail');
    expect(optIns).toHaveLength(1);
    expect(optIns[0]!.pos).toBeGreaterThan(body.pos); expect(optIns[0]!.end).toBeLessThan(body.end);
    const loops = matching(body, ts.isForOfStatement);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    if (!ts.isForOfStatement(loop)) throw new Error('Invalid boundary loop');
    expect(loop.expression.getText()).toBe('[1, 512000]');
    const calls = matching(loop, node => ts.isCallExpression(node) && node.expression.getText() === 'sendBrowserAnalysis');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    if (!ts.isCallExpression(call)) throw new Error('Invalid boundary sender');
    expect(call.arguments.map(arg => arg.getText())).toEqual(['page', 'api', "'valid'", 'sent', 'true']);
    const text = body.getText();
    const assignment = text.indexOf("results[index] = await sendBrowserAnalysis(page, api, 'valid', sent, true);");
    const combined = text.indexOf("expect(results[index]).toEqual({ status: 200, outcome: 'response', constructedBytes: size });");
    expect(assignment).toBeGreaterThanOrEqual(0); expect(combined).toBeGreaterThan(assignment);
    expect(text).toContain('Buffer.alloc(size, 197)');
    expect(text).toContain('assertAnalysisBytes(api.inputs.at(-1)!, sent)');
    const finalizers = matching(body, ts.isTryStatement).filter(node => ts.isTryStatement(node) && node.finallyBlock);
    expect(finalizers.some(node => ts.isTryStatement(node) && node.finallyBlock!.getText().includes('snapshotRawAnalysis(evidence, api, results)')
      && node.finallyBlock!.getText().includes('await assertAnalysisClosed(page, api)'))).toBe(true);
    expect(finalizers.some(node => ts.isTryStatement(node) && node.finallyBlock!.getText().includes('emitRawAnalysis(evidence, testInfo)'))).toBe(true);
  });
});
