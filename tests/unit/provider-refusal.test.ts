// FILT1 (plan rev3 §2–3, §7): the bounded refusal kind, the metering state and the finish arguments, driven by the shared
// fixture table through both real adapters.
import { describe, expect, it } from 'vitest';
import cases from '../edge-fixtures/provider-refusal-cases.json';
import { ENHANCE_MODEL } from '../../src/domain/enhancement';
import {
  FILTER_FAILURE_PATHS, metering, providerRefusal, QUALIFYING_REFUSALS, refusalFinishArgs,
} from '../../src/domain/provider-refusal';
import { TRYON_MODEL } from '../../src/domain/tryon';
import { classifyEnhanceResponse } from '../../supabase/functions/enhance-photo/azure';
import { classifyTryOnResponse } from '../../supabase/functions/try-on/azure';

type Case = (typeof cases.cases)[number];
const INPUT = 'Your task failed as a result of our safety system.';
const OUTPUT = 'Generated image was filtered as a result of our safety system.';
const usage = { input_tokens: 1400, output_tokens: 2000, total_tokens: 3400, input_tokens_details: { text_tokens: 150, image_tokens: 1250 } };
const substitute = (value: unknown, model: string): unknown => {
  if (value === '$USAGE') return usage;
  if (value === '$MODEL') return model;
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, model));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, model)]));
  }
  return value;
};
const features = [
  ['try-on', TRYON_MODEL, classifyTryOnResponse],
  ['enhance-photo', ENHANCE_MODEL, classifyEnhanceResponse],
] as const;
const setPath = (steps: readonly string[], leaf: unknown) => {
  const root: Record<string, unknown> = {};
  let node = root;
  steps.slice(0, -1).forEach((step) => { node = (node[step] = {}) as Record<string, unknown>; });
  node[steps.at(-1)!] = leaf;
  return root;
};
const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object'
      ? merge(out[key] as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return out;
};

describe('provider refusal kind (rules and precedence)', () => {
  it('keeps the bounded enum and the qualifying subset', () => {
    expect(QUALIFYING_REFUSALS).toEqual(['rai_input', 'rai_output', 'unknown_filter']);
    expect(new Set(cases.cases.map((row) => row.refusal))).toEqual(new Set([null, 'rai_input', 'rai_output', 'unknown_filter', 'unverified_filter']));
  });
  it('reads the documented contentFilter messages exactly', () => {
    expect(providerRefusal(400, { error: { code: 'contentFilter', message: INPUT } })).toBe('rai_input');
    expect(providerRefusal(400, { error: { code: 'contentFilter', message: OUTPUT } })).toBe('rai_output');
    for (const near of [INPUT.toUpperCase(), ` ${INPUT}`, `${OUTPUT}.`, '', null, 7]) {
      expect(providerRefusal(400, { error: { code: 'contentFilter', message: near } })).toBe('unknown_filter');
    }
  });
  it('needs an exact outer code at status 400 to qualify', () => {
    for (const code of ['contentFilter', 'content_policy_violation', 'content_filter']) {
      expect(QUALIFYING_REFUSALS).toContain(providerRefusal(400, { error: { code } }));
      for (const status of [401, 403, 404, 422, 429, 500, 503]) expect(providerRefusal(status, { error: { code } })).toBe('unverified_filter');
      expect(providerRefusal(200, { error: { code } })).toBeNull();
      expect(providerRefusal(400, { error: { code: code.toUpperCase() } })).toBeNull();
    }
    for (const body of [null, [], 'x', {}, { error: null }, { error: [] }, { error: { code: 7 } }, { error: { message: INPUT } },
      { error: { code: 'InvalidPayload', message: INPUT } }, { code: 'contentFilter' }]) {
      expect(providerRefusal(400, body)).toBeNull();
    }
  });
  it('never qualifies moderation_blocked, the outer RAI code or an inner-only filter code', () => {
    expect(providerRefusal(400, { error: { code: 'moderation_blocked' } })).toBe('unverified_filter');
    expect(providerRefusal(400, { error: { code: 'ResponsibleAIPolicyViolation' } })).toBe('unverified_filter');
    for (const wrapper of ['innererror', 'inner_error']) {
      for (const code of ['contentFilter', 'content_policy_violation', 'content_filter', 'moderation_blocked', 'ResponsibleAIPolicyViolation']) {
        expect(providerRefusal(400, { error: { code: 'BadRequest', [wrapper]: { code } } })).toBe('unverified_filter');
      }
    }
    expect(providerRefusal(400, { error: { code: 'BadRequest', innererror: { code: 'other' } } })).toBeNull();
  });
  it('treats a filtering-system failure as no refusal at all', () => {
    expect(providerRefusal(400, { error: { code: 'content_filter_error' } })).toBeNull();
    expect(providerRefusal(500, { error: { code: 'content_filter_error', innererror: { code: 'ResponsibleAIPolicyViolation' } } })).toBeNull();
  });
  it('enumerates the bounded filter-failure paths explicitly', () => {
    expect(FILTER_FAILURE_PATHS).toHaveLength(2 + 6 + 54);
    expect(FILTER_FAILURE_PATHS.slice(0, 8).map((path) => path.join('.'))).toEqual([
      'innererror.code', 'inner_error.code',
      'content_filter_results.error.code', 'content_filter_result.error.code',
      'innererror.content_filter_results.error.code', 'innererror.content_filter_result.error.code',
      'inner_error.content_filter_results.error.code', 'inner_error.content_filter_result.error.code']);
    expect(new Set(FILTER_FAILURE_PATHS.map((path) => path.join('.'))).size).toBe(FILTER_FAILURE_PATHS.length);
    for (const path of FILTER_FAILURE_PATHS) expect(path.length).toBeLessThanOrEqual(5);
  });
  it('downgrades every qualifying outer code combined with any nested content_filter_error signal', () => {
    const outers = [{ code: 'contentFilter', message: INPUT }, { code: 'contentFilter', message: OUTPUT },
      { code: 'contentFilter', message: 'other' }, { code: 'content_policy_violation' }, { code: 'content_filter' }];
    for (const outer of outers) {
      expect(QUALIFYING_REFUSALS).toContain(providerRefusal(400, { error: outer }));
      for (const path of FILTER_FAILURE_PATHS) {
        expect(providerRefusal(400, { error: merge(outer, setPath(path, 'content_filter_error')) })).toBe('unverified_filter');
        // Exact: a different leaf, or a non-object step, leaves the qualifying kind.
        expect(providerRefusal(400, { error: merge(outer, setPath(path, 'content_filter_errors')) }))
          .toBe(providerRefusal(400, { error: outer }));
      }
    }
    expect(providerRefusal(400, { error: { code: 'contentFilter', message: INPUT,
      content_filter_results: [{ error: { code: 'content_filter_error' } }] } })).toBe('rai_input');
    expect(providerRefusal(400, { error: { code: 'contentFilter', message: INPUT,
      content_filter_results: { error: { code: 'content_filter_error' }, extra: { deeper: { error: { code: 'x' } } } } } })).toBe('unverified_filter');
  });
});

describe('metering state', () => {
  it('is absent only with no usage key, no stray counters and an absent or recognised model', () => {
    expect(metering({ error: {} }, null, [TRYON_MODEL])).toBe('absent');
    expect(metering({ error: {}, model: TRYON_MODEL }, null, [TRYON_MODEL])).toBe('absent');
    expect(metering({ error: {} }, { input: 1 }, [TRYON_MODEL])).toBe('observed');
    for (const body of [{ usage: null }, { usage: {} }, { usage: undefined }, { input_tokens: 1 }, { output_tokens: 1 },
      { total_tokens: 1 }, { model: 'other' }, { model: null }, null, []]) {
      expect(metering(body, null, [TRYON_MODEL])).toBe('faulty');
    }
  });
  it('sends the kind only for FILTERED, and absence only when usage is null', () => {
    expect(refusalFinishArgs({ code: 'FAILED', usage: null, refusal: null, metering: 'absent' })).toEqual({ p_refusal_kind: null, p_usage_absent: null });
    expect(refusalFinishArgs({ code: 'OK', usage: null, refusal: 'rai_input', metering: 'absent' })).toEqual({ p_refusal_kind: null, p_usage_absent: null });
    expect(refusalFinishArgs({ code: 'FILTERED', usage: null, refusal: 'rai_input', metering: 'absent' })).toEqual({ p_refusal_kind: 'rai_input', p_usage_absent: true });
    expect(refusalFinishArgs({ code: 'FILTERED', usage: null, refusal: 'rai_input', metering: 'faulty' })).toEqual({ p_refusal_kind: 'rai_input', p_usage_absent: false });
    expect(refusalFinishArgs({ code: 'FILTERED', usage: {}, refusal: 'unknown_filter', metering: 'observed' })).toEqual({ p_refusal_kind: 'unknown_filter', p_usage_absent: null });
  });
});

describe('shared fixture through both real adapters', () => {
  it('covers every rule family', () => {
    const ids = new Set(cases.cases.map((row) => row.id));
    for (const id of ['rai-input', 'rai-output', 'negative-counter', 'usage-null', 'incomplete-over-envelope', 'unrecognised-model',
      'missing-detail', 'moderation-blocked', 'responsible-ai-outer', 'inner-only', 'content-filter-403', 'filter-system-error',
      'generic-400', 'message-only', 'ok-status-filter-code', 'observed-usage', 'guard-control-leaf', 'guard-control-array']) {
      expect(ids).toContain(id);
    }
    expect(cases.cases.filter((row) => row.id.startsWith('guard-') && !row.id.startsWith('guard-control'))).toHaveLength(4 * 11);
    expect(ids.size).toBe(cases.cases.length);
  });
  describe.each(features)('%s', (_name, model, classify) => {
    it.each(cases.cases.map((row) => [row.id, row] as const))('%s', (_id, row: Case) => {
      const body = substitute(row.body, model) as Record<string, unknown>;
      const outcome = classify(row.status, body);
      expect({ code: outcome.code, refusal: outcome.refusal, metering: outcome.metering })
        .toEqual({ code: row.code, refusal: row.refusal, metering: row.metering });
      expect(outcome.usage === null).toBe(row.finishArgs.p_usage === null);
      expect({ p_code: outcome.code, p_usage: outcome.usage === null ? null : '$PAYLOAD', ...refusalFinishArgs(outcome) }).toEqual(row.finishArgs);
      // No provider text, category or severity leaves the adapter.
      const text = JSON.stringify({ ...outcome, image: null });
      for (const leak of ['safety system', 'synthetic', 'severity', 'content_filter', 'contentFilter', 'error']) expect(text).not.toContain(leak);
    });
  });
});
