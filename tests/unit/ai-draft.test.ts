import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiSaveClaim, beginAiAnalysis, continueAiManually, createAiDraft, editAiDraftField, expireAiDraft,
  failAiAnalysis, invalidateAiDraft, prepareAiGeneration, receiveAiResult, presentAiDraft, refuseAiSave,
  formAiFields, hiddenAiFields, prefillTags, type AiContext, type AiDraftState, type AiTransition,
} from '../../src/domain/ai-draft';
import { newAnalyzedSaveAttempt } from '../../src/domain/analyzed-save';
import { aiFields, aiKind, type AiFacts, type AiField } from '../../src/domain/ai-analysis';
import { aiCodes } from '../../src/domain/ai-controls';
import {
  aiPhase, phaseForCode, phaseForTerminal, pollStatus, statusPollDeadlineMs, statusPollDelaysMs, terminalReasons,
  type AiPhaseInput,
} from '../../src/features/wardrobe/use-ai-draft';
import {
  buildGarmentWrite, editGarmentField, initialRawFields, newGarmentDraft, validateGarmentDraft,
  type GarmentDraft, type RawFields,
} from '../../src/domain/garment-fields';

const context: AiContext = {
  ownerId: '10000000-0000-4000-8000-000000000001', epoch: 3,
  draftId: '20000000-0000-4000-8000-000000000001', generation: 1,
  requestId: '30000000-0000-4000-8000-000000000001', imageSha256: 'a'.repeat(64),
};
const nextContext: AiContext = { ...context, generation: 2, requestId: '30000000-0000-4000-8000-000000000002', imageSha256: 'b'.repeat(64) };
const allFields = {
  category: 'top', subcategory: '  Overshirt  ', colours: ['olive', 'green'], pattern: 'checked',
  sleeve_length: 'long', garment_length: 'regular', brand: ' Fictional Brand ', size_label: 'M',
  upper_coverage: 2, lower_coverage: 0, material: 'Cotton blend', seasons: ['spring', 'autumn'],
  formality: 0, style_tags: [' Soft Lines ', 'fictional style'],
} satisfies AiFacts['fields'];
function result(fields: AiFacts['fields'] = allFields, binding = context, outcome: AiFacts['outcome'] = 'ready') {
  return {
    schemaVersion: 1, requestId: binding.requestId, draftId: binding.draftId, generation: binding.generation,
    imageSha256: binding.imageSha256, modelId: 'fictional:model/v1', promptVersion: 1,
    createdAtMs: 1000, expiresAtMs: 2000, facts: { outcome, fields },
  };
}
function changed(transition: AiTransition): AiDraftState {
  expect(transition.status).toBe('updated');
  if (transition.status !== 'updated') throw new Error('Expected fixture transition');
  return transition.state;
}
function initial(draft = newGarmentDraft('EUR', 'fi')): AiDraftState {
  const created = createAiDraft(draft, context);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('Expected fixture draft');
  return created.state;
}
function pending(draft?: GarmentDraft): AiDraftState {
  return changed(beginAiAnalysis(initial(draft), context));
}
function ready(draft?: GarmentDraft): AiDraftState {
  return changed(receiveAiResult(pending(draft), context, result(), 1000));
}
function raw(state: AiDraftState): GarmentDraft {
  if (!state.draft) throw new Error('Expected active fixture');
  return structuredClone(state.draft) as GarmentDraft;
}
function claim(state: AiDraftState) {
  const prepared = aiSaveClaim(state, context, 1500);
  expect(prepared.status).toBe('ready');
  if (prepared.status !== 'ready') throw new Error('Expected fixture claim');
  return prepared.claim;
}
describe('definitive first Save refusal', () => {
  it('invalidates proof, never values, intent or presentation, without choosing manual provenance', () => {
    const shown = changed(presentAiDraft(ready(), context, 'fi'));
    const edited = changed(editAiDraftField(shown, context, 'brand', '', 'fi'));
    const refused = changed(refuseAiSave(edited, context));
    expect(refused.status).toBe('expired');
    expect(refused.draft).toEqual(edited.draft);
    expect(refused.derivation).toEqual(edited.derivation);
    expect(refused.result).toBeNull();
    expect(aiSaveClaim(refused, context, 1500).status).toBe('none');
    expect(continueAiManually(refused, context).state.status).toBe('cancelled');
    expect(refuseAiSave(edited, { ...context, epoch: 4 }).status).toBe('ignored');
  });
});
const mismatches = [
  ['owner', { ownerId: '10000000-0000-4000-8000-000000000002' }],
  ['epoch', { epoch: 4 }],
  ['draft', { draftId: '20000000-0000-4000-8000-000000000002' }],
  ['generation', { generation: 2 }],
  ['request', { requestId: '30000000-0000-4000-8000-000000000002' }],
  ['photo', { imageSha256: 'b'.repeat(64) }],
] as const;

describe('saved replacement eligibility', () => {
  function saved() {
    const draft = newGarmentDraft('EUR', 'en');
    draft.raw.title = 'Saved shirt'; draft.raw.category = 'top'; draft.raw.brand = 'Legacy brand';
    draft.raw.material = 'Saved estimate';
    const values = validateGarmentDraft(draft).values!;
    const baseline = { values, provenance: {
      material: { kind: 'ai_estimated' as const, revision: 3 },
      subcategory: { kind: 'user' as const, revision: 2 },
      tags: { kind: 'user' as const, revision: 4 },
    } };
    const created = createAiDraft(newGarmentDraft('EUR', 'en', values), context, baseline);
    if (!created.ok) throw new Error('Expected saved draft');
    return { baseline, state: changed(beginAiAnalysis(created.state, context)) };
  }
  it('protects saved nonempty values and user clears without marking them manual', () => {
    const state = changed(presentAiDraft(changed(receiveAiResult(saved().state, context, result(), 1000)), context, 'en'));
    expect(state.draft?.raw).toMatchObject({ title: 'Saved shirt', category: 'top', brand: 'Legacy brand',
      material: 'Saved estimate', subcategory: '', tags: [], pattern: 'checked', formality: '0' });
    expect(state.draft?.intent).toEqual({});
    expect(claim(state).fields).not.toHaveProperty('category');
    expect(claim(state).fields).not.toHaveProperty('brand');
    expect(claim(state).fields).not.toHaveProperty('material');
    expect(claim(state).fields).not.toHaveProperty('subcategory');
    expect(claim(state).fields.pattern).toEqual({ value: 'checked', kind: 'ai_observed' });
  });
  it('retains eligibility across generations and protects edits/clears made while pending', () => {
    let state = saved().state;
    state = changed(editAiDraftField(state, context, 'pattern', '', 'en'));
    state = changed(receiveAiResult(state, context, result(), 1000));
    state = changed(presentAiDraft(state, context, 'en'));
    state = changed(prepareAiGeneration(state, context, nextContext));
    state = changed(beginAiAnalysis(state, nextContext));
    state = changed(receiveAiResult(state, nextContext, result(allFields, nextContext), 1000));
    expect(state.draft?.raw.pattern).toBe('');
    expect(state.draft?.raw.brand).toBe('Legacy brand');
    expect(state.draft?.raw.subcategory).toBe('');
    expect(state.draft?.raw.title).toBe('Saved shirt');
    expect(state.draft?.intent).toEqual({ pattern: true });
    expect(receiveAiResult(state, context, result(), 1000).status).toBe('ignored');
  });
  it('does not clear a protected title that happens to equal generated presentation on a new photo', () => {
    const shown = changed(presentAiDraft(ready(), context, 'en'));
    const savedValue = saved();
    savedValue.baseline.values.title = shown.draft!.raw.title;
    const created = createAiDraft(newGarmentDraft('EUR', 'en', savedValue.baseline.values), context, savedValue.baseline);
    if (!created.ok) throw new Error('Expected saved draft');
    const projected = changed(presentAiDraft(changed(receiveAiResult(changed(beginAiAnalysis(created.state, context)),
      context, result(), 1000)), context, 'en'));
    expect(changed(prepareAiGeneration(projected, context, nextContext)).draft?.raw.title).toBe(shown.draft!.raw.title);
  });
});

describe('pure bound draft projection', () => {
  it('creates local text once, preserves language invariance and removes only untouched presentation on replacement', () => {
    const first = changed(presentAiDraft(ready(), context, 'fi'));
    expect(raw(first).intent).toEqual({});
    expect(raw(first).raw.title.length).toBeGreaterThan(0);
    expect(raw(first).raw.tags.length).toBeGreaterThan(0);
    expect(presentAiDraft(first, context, 'sv')).toEqual({ status: 'ignored', state: first, reason: 'ineligible_state' });
    expect(claim(first).fields).not.toHaveProperty('title');
    expect(claim(first).fields).not.toHaveProperty('tags');
    const cleared = changed(editAiDraftField(first, context, 'tags', [], 'sv'));
    const edited = changed(editAiDraftField(cleared, context, 'title', 'My own title', 'en'));
    const replaced = changed(prepareAiGeneration(edited, context, nextContext));
    expect(raw(replaced).raw.title).toBe('My own title');
    expect(raw(replaced).raw.tags).toEqual([]);
    expect(raw(replaced).intent).toEqual({ title: true, tags: true });
    const untouched = changed(prepareAiGeneration(first, context, nextContext));
    expect(raw(untouched).raw.title).toBe('');
    expect(raw(untouched).raw.tags).toEqual([]);
  });
  it('requires explicit request start and distinct draft/request/generation identity', () => {
    const idle = initial();
    expect(idle.context?.draftId).not.toBe(idle.context?.requestId);
    expect(receiveAiResult(idle, context, result(), 1000)).toEqual({ status: 'ignored', state: idle, reason: 'ineligible_state' });
    const started = changed(beginAiAnalysis(idle, context));
    expect(started.status).toBe('pending');
    expect(started.context).toEqual(context);
    expect(beginAiAnalysis(started, context)).toEqual({ status: 'ignored', state: started, reason: 'ineligible_state' });
    expect(idle.status).toBe('idle');
  });
  it('fills the nine form fields, never the five hidden ones, without manual intent or invented basics', () => {
    const state = ready();
    const draft = raw(state);
    const defaults = initialRawFields('EUR');
    expect(draft.intent).toEqual({});
    expect(draft.priceLanguage).toBe('fi');
    expect([...formAiFields].sort()).toEqual(['brand', 'category', 'colours', 'formality', 'material', 'pattern', 'seasons', 'size_label', 'subcategory']);
    for (const field of formAiFields) {
      const value = allFields[field];
      expect(draft.raw[field]).toEqual(Array.isArray(value) ? value : String(value));
      expect(state.derivation?.[field]).toEqual({ value, kind: aiKind(field) });
    }
    for (const field of Object.keys(defaults) as (keyof RawFields)[]) {
      if (!formAiFields.some((key) => key === field)) expect(draft.raw[field]).toEqual(defaults[field]);
    }
    const validation = validateGarmentDraft(draft);
    expect(validation.values).toBeNull();
    expect(validation.errors).toEqual({ title: true });
    expect(claim(state).fields).toEqual(state.derivation);
  });
  it.each(hiddenAiFields)('never applies, derives or claims hidden %s', (field) => {
    const state = changed(receiveAiResult(pending(), context, result({ category: 'top', [field]: allFields[field] }), 1500));
    expect(state.draft?.raw[field]).toEqual(initialRawFields('EUR')[field]);
    expect(state.draft?.intent).toEqual({});
    expect(state.derivation).not.toHaveProperty(field);
    expect(claim(state).fields).not.toHaveProperty(field);
    expect(Object.keys(claim(state).fields)).toEqual(['category']);
  });
  it.each(formAiFields)('applies %s without introducing a new error, leaving missing basics honest', (field) => {
    const state = changed(receiveAiResult(pending(), context, result({ [field]: allFields[field] }), 1500));
    const validation = validateGarmentDraft(raw(state));
    expect(validation.errors[field]).toBeUndefined();
    expect(validation.errors.title).toBe(true);
    if (field !== 'category') expect(validation.errors.category).toBe(true);
    expect(Object.keys(state.derivation!)).toEqual([field]);
  });
  it('preserves pre-existing non-default raw fields without relabelling them user input', () => {
    const draft = newGarmentDraft('USD', 'sv');
    draft.raw.brand = '  Original unknown brand  ';
    draft.raw.material = 'Original material';
    draft.raw.colours = ['blue'];
    draft.raw.formality = 'invalid owner-era text';
    const state = ready(draft);
    expect(state.draft?.intent).toEqual({});
    for (const field of ['brand', 'material', 'colours', 'formality'] as const) {
      expect(state.draft?.raw[field]).toEqual(draft.raw[field]);
      expect(state.derivation).not.toHaveProperty(field);
    }
    expect(state.draft?.raw.currency).toBe('USD');
    expect(state.draft?.priceLanguage).toBe('sv');
    expect(validateGarmentDraft(raw(state)).errors.formality).toBe(true);
  });
  it.each(aiFields)('preserves an explicit %s clear before a result, including already-empty clears', (field) => {
    const draft = newGarmentDraft('EUR', 'fi');
    const cleared = editGarmentField(draft, field, draft.raw[field], 'fi');
    const state = ready(cleared);
    expect(state.draft?.raw[field]).toEqual(draft.raw[field]);
    expect(state.draft?.intent[field]).toBe(true);
    expect(state.derivation).not.toHaveProperty(field);
    expect(claim(state).fields).not.toHaveProperty(field);
  });
  it('preserves invalid owner input entered while analysis is pending', () => {
    let state = pending();
    state = changed(editAiDraftField(state, context, 'category', 'not-a-category', 'fi'));
    state = changed(editAiDraftField(state, context, 'formality', 'not numeric', 'fi'));
    state = changed(editAiDraftField(state, context, 'brand', ' \t ', 'fi'));
    state = changed(receiveAiResult(state, context, result(), 1500));
    expect(state.draft?.raw).toMatchObject({ category: 'not-a-category', formality: 'not numeric', brand: ' \t ' });
    expect(validateGarmentDraft(raw(state)).errors).toEqual({ title: true, category: true, formality: true });
    for (const field of ['category', 'formality', 'brand']) expect(claim(state).fields).not.toHaveProperty(field);
  });
  it('does not assert absent/null/empty fields and handles ready partial and unclear outcomes', () => {
    const fields = { category: null, formality: null, colours: [], seasons: [], style_tags: [] };
    const partial = changed(receiveAiResult(pending(), context, result(fields), 1500));
    expect(partial.draft?.raw).toEqual(initialRawFields('EUR'));
    expect(partial.derivation).toEqual({});
    expect(claim(partial).fields).toEqual({});
    expect(validateGarmentDraft(raw(partial)).errors).toEqual({ title: true, category: true });
    const unclear = changed(receiveAiResult(pending(), context, result(fields, context, 'unclear'), 1500));
    expect(unclear.status).toBe('unclear');
    expect(unclear.result).toBeNull();
    expect(aiSaveClaim(unclear, context, 1500).status).toBe('none');
  });
  it.each(mismatches)('ignores a current-context %s mismatch without changing the input reference', (reason, patch) => {
    const state = pending();
    const wrong = { ...context, ...patch };
    const received = receiveAiResult(state, wrong, result(), 1500);
    expect(received).toEqual({ status: 'ignored', state, reason });
    expect(received.state).toBe(state);
    expect(editAiDraftField(state, wrong, 'brand', 'changed', 'en')).toEqual({ status: 'ignored', state, reason });
    expect(prepareAiGeneration(state, wrong, nextContext)).toEqual({ status: 'ignored', state, reason });
    expect(beginAiAnalysis(state, wrong)).toEqual({ status: 'ignored', state, reason });
    expect(failAiAnalysis(state, wrong)).toEqual({ status: 'ignored', state, reason });
    expect(continueAiManually(state, wrong)).toEqual({ status: 'ignored', state, reason });
    expect(expireAiDraft(state, wrong, 2000)).toEqual({ status: 'ignored', state, reason });
    expect(aiSaveClaim(ready(), wrong, 1500)).toEqual({ status: 'none', reason });
  });
  it.each(mismatches.slice(2))('ignores a result-metadata %s mismatch', (reason, patch) => {
    const state = pending();
    expect(receiveAiResult(state, context, result(allFields, { ...context, ...patch }), 1500))
      .toEqual({ status: 'ignored', state, reason });
  });
  it('rejects malformed structure explicitly, even for a stale or terminal response', () => {
    for (const state of [pending(), invalidateAiDraft('discarded')]) {
      const transition = receiveAiResult(state, { ...context, epoch: 4 }, { ...result(), facts: { outcome: 'ready', fields: { formality: '0' } } }, 1500);
      expect(transition).toEqual({ status: 'invalid', state, code: 'INVALID_RESULT' });
    }
    const state = pending();
    for (const bad of [null, {}, { ...context, ownerId: 'bad' }, { ...context, epoch: -1 }, { ...context, epoch: 1.5 },
      { ...context, generation: 0 }, { ...context, requestId: 'bad' }, { ...context, imageSha256: 'bad' }, { ...context, extra: null }]) {
      expect(createAiDraft(newGarmentDraft('EUR', 'en'), bad)).toEqual({ ok: false, code: 'INVALID_CONTEXT' });
      expect(receiveAiResult(state, bad, result(), 1500)).toEqual({ status: 'invalid', state, code: 'INVALID_CONTEXT' });
    }
    expect(createAiDraft({ raw: {} } as GarmentDraft, context)).toEqual({ ok: false, code: 'INVALID_DRAFT' });
    for (const time of [-1, 0.5, NaN, Infinity]) {
      expect(receiveAiResult(state, context, result(), time)).toEqual({ status: 'invalid', state, code: 'INVALID_CONTEXT' });
      expect(expireAiDraft(state, context, time).status).toBe('invalid');
      expect(aiSaveClaim(ready(), context, time).status).toBe('invalid');
    }
  });
});

describe('derivation, trust and explicit lifecycle', () => {
  it.each(formAiFields)('manual %s edit or clear removes its AI attribution, even for identical content', (field) => {
    const original = ready();
    const draft = raw(original);
    for (const value of [draft.raw[field], initialRawFields('EUR')[field]]) {
      const edited = changed(editAiDraftField(original, context, field, value, 'sv'));
      expect(edited.draft?.raw[field]).toEqual(value);
      expect(edited.draft?.intent[field]).toBe(true);
      expect(edited.derivation).not.toHaveProperty(field);
      expect(claim(edited).fields).not.toHaveProperty(field);
      expect(original.derivation).toHaveProperty(field);
    }
  });
  it('retains visible expired AI values unverified, then clears them on photo replacement while preserving edits', () => {
    let state = ready();
    state = changed(editAiDraftField(state, context, 'material', '  Owner material  ', 'fi'));
    state = changed(editAiDraftField(state, context, 'colours', [], 'fi'));
    state = changed(editAiDraftField(state, context, 'formality', 'bad', 'fi'));
    const before = state;
    expect(expireAiDraft(state, context, 1999)).toEqual({ status: 'ignored', state, reason: 'not_expired' });
    expect(aiSaveClaim(state, context, 2000)).toEqual({ status: 'none', reason: 'expired_result' });
    state = changed(expireAiDraft(state, context, 2000));
    expect(state.status).toBe('expired');
    expect(state.result).toBeNull();
    expect(state.draft).toEqual(before.draft);
    expect(state.derivation).toEqual(before.derivation);
    expect(aiSaveClaim(state, context, 1500).status).toBe('none');
    state = changed(prepareAiGeneration(state, context, nextContext));
    expect(state.status).toBe('idle');
    expect(state.result).toBeNull();
    expect(state.derivation).toEqual({});
    const defaults = initialRawFields('EUR');
    for (const field of aiFields) if (!['material', 'colours', 'formality'].includes(field)) expect(state.draft?.raw[field]).toEqual(defaults[field]);
    expect(state.draft?.raw).toMatchObject({ material: '  Owner material  ', colours: [], formality: 'bad' });
    expect(state.draft?.intent).toEqual({ material: true, colours: true, formality: true });
    const started = changed(beginAiAnalysis(state, nextContext));
    expect(receiveAiResult(started, context, result(), 1500).status).toBe('ignored');
    const received = changed(receiveAiResult(started, nextContext, result(allFields, nextContext), 1500));
    expect(received.draft?.raw.material).toBe('  Owner material  ');
    expect(received.draft?.raw.category).toBe('top');
  });
  it('clears only prior derived values on a new photo, never pre-existing non-default unknowns', () => {
    const draft = newGarmentDraft('EUR', 'en');
    draft.raw.brand = 'retained unknown';
    const state = changed(prepareAiGeneration(ready(draft), context, nextContext));
    expect(state.draft?.raw.brand).toBe('retained unknown');
    expect(state.draft?.intent).toEqual({});
    expect(state.draft?.raw.category).toBe('');
  });
  it('rejects expired/future results without applying values or reviving already-consumed work', () => {
    const state = pending();
    expect(receiveAiResult(state, context, result(), 999)).toEqual({ status: 'ignored', state, reason: 'future_result' });
    expect(receiveAiResult(state, context, result(), 2000)).toEqual({ status: 'ignored', state, reason: 'expired_result' });
    const complete = changed(receiveAiResult(state, context, result(), 1999));
    expect(receiveAiResult(complete, context, result(), 1999)).toEqual({ status: 'ignored', state: complete, reason: 'ineligible_state' });
    expect(aiSaveClaim(complete, context, 999)).toEqual({ status: 'none', reason: 'future_result' });
  });
  it('failure and manual continuation allocate nothing and require an explicit new generation to retry', () => {
    const state = pending(editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Manual shirt', 'en'));
    const failed = changed(failAiAnalysis(state, context));
    expect(failed.status).toBe('failed');
    expect(failed.draft).toEqual(state.draft);
    expect(failed.context).toEqual(context);
    expect(aiSaveClaim(failed, context, 1500).status).toBe('none');
    const cancelled = changed(continueAiManually(failed, context));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.draft).toEqual(state.draft);
    expect(receiveAiResult(cancelled, context, result(), 1500).status).toBe('ignored');
    expect(beginAiAnalysis(cancelled, context).status).toBe('ignored');
    const completed = changed(editAiDraftField(cancelled, context, 'category', 'top', 'en'));
    expect(buildGarmentWrite(raw(completed)).values.title).toBe('Manual shirt');
    expect(completed.context).toEqual(context);
    const retry = changed(prepareAiGeneration(cancelled, context, { ...nextContext, imageSha256: context.imageSha256 }));
    expect(retry.status).toBe('idle');
    expect(changed(beginAiAnalysis(retry, retry.context)).status).toBe('pending');
  });
  it('cancels a successful claim while keeping derivation available for subsequent photo cleanup', () => {
    const cancelled = changed(continueAiManually(ready(), context));
    expect(cancelled.derivation).toHaveProperty('brand');
    expect(aiSaveClaim(cancelled, context, 1500).status).toBe('none');
    expect(changed(prepareAiGeneration(cancelled, context, nextContext)).draft?.raw.brand).toBe('');
  });
  it('requires a fresh increasing generation/request and never carries data to a new owner', () => {
    const state = ready();
    for (const next of [context, { ...nextContext, generation: 1 }, { ...nextContext, requestId: context.requestId },
      { ...nextContext, ownerId: '10000000-0000-4000-8000-000000000002' }, { ...nextContext, epoch: 4 },
      { ...nextContext, draftId: '20000000-0000-4000-8000-000000000002' }]) {
      expect(prepareAiGeneration(state, context, next)).toEqual({ status: 'invalid', state, code: 'INVALID_TRANSITION' });
    }
    expect(prepareAiGeneration(state, context, { ...nextContext, generation: 2147483648 }).status).toBe('invalid');
  });
  it.each(['logout', 'owner_changed', 'discarded', 'saved'] as const)('%s drops private references and permanently invalidates old work', (reason) => {
    const state = invalidateAiDraft(reason);
    expect(state).toEqual({ status: 'invalidated', reason, draft: null, context: null, derivation: null, result: null });
    expect(receiveAiResult(state, context, result(), 1500)).toEqual({ status: 'ignored', state, reason: 'invalidated' });
    expect(beginAiAnalysis(state, context).status).toBe('ignored');
    expect(prepareAiGeneration(state, context, nextContext).status).toBe('ignored');
    expect(editAiDraftField(state, context, 'title', 'late', 'en').status).toBe('ignored');
    expect(aiSaveClaim(state, context, 1500)).toEqual({ status: 'none', reason: 'invalidated' });
    const other = createAiDraft(newGarmentDraft('USD', 'sv'), { ...context, ownerId: '10000000-0000-4000-8000-000000000002' });
    expect(other.ok && other.state.draft?.raw).toEqual(initialRawFields('USD'));
  });
});

describe('immutable untrusted Save preparation, not a new write path', () => {
  it('claims exact semantic values, derived kinds and identity only', () => {
    const state = ready();
    const prepared = claim(state);
    expect(Object.keys(prepared).sort()).toEqual(['draftId', 'fields', 'generation', 'imageSha256', 'requestId']);
    expect(prepared).toMatchObject({ draftId: context.draftId, generation: 1, imageSha256: context.imageSha256, requestId: context.requestId });
    expect(Object.keys(prepared.fields).sort()).toEqual([...formAiFields].sort());
    for (const field of hiddenAiFields) expect(prepared.fields).not.toHaveProperty(field);
    expect(prepared.fields.formality).toEqual({ value: 0, kind: 'ai_estimated' });
    expect(prepared.fields.brand?.value).toBe(allFields.brand);
    for (const field of formAiFields) {
      expect(Object.keys(prepared.fields[field]!)).toEqual(['value', 'kind']);
      expect(prepared.fields[field]).toEqual({ value: allFields[field], kind: aiKind(field) });
    }
    expect(prepared.fields.colours?.value).not.toBe(state.derivation?.colours?.value);
  });
  it('isolates caller inputs and resists nested state/result/claim mutations', () => {
    const draft = newGarmentDraft('EUR', 'fi');
    const inputContext = { ...context };
    const created = createAiDraft(draft, inputContext);
    if (!created.ok) throw new Error('Expected fixture draft');
    draft.raw.tags.push('outside');
    inputContext.epoch = 99;
    expect(created.state.draft?.raw.tags).toEqual([]);
    expect(created.state.context?.epoch).toBe(3);
    expect(Object.isFrozen(draft)).toBe(false);
    const input = result(structuredClone(allFields));
    const state = changed(receiveAiResult(changed(beginAiAnalysis(created.state, context)), context, input, 1500));
    (input.facts.fields.colours as string[]).push('blue');
    expect(state.draft?.raw.colours).toEqual(['olive', 'green']);
    const prepared = claim(state);
    expect(() => (prepared.fields.colours!.value as string[]).push('blue')).toThrow();
    expect(() => Object.assign(prepared.fields.brand!, { kind: 'user' })).toThrow();
    expect(() => Object.assign(prepared, { requestId: nextContext.requestId })).toThrow();
    expect(() => (state.draft!.raw.colours as string[]).push('blue')).toThrow();
    expect(Object.isFrozen(state.derivation?.colours)).toBe(true);
    expect(Object.isFrozen(state.result?.facts.fields)).toBe(true);
    expect(claim(state)).toEqual(prepared);
  });
  it('returns explicit conflicts for drifted values or kinds rather than a downgraded successful claim', () => {
    const state = ready();
    if (state.status !== 'ready') throw new Error('Expected ready fixture');
    for (const forged of [
      { ...state, draft: { ...state.draft, raw: { ...state.draft.raw, formality: '1' } } },
      { ...state, draft: { ...state.draft, intent: { ...state.draft.intent, formality: true } } },
      { ...state, derivation: { ...state.derivation, formality: { kind: 'ai_observed', value: 0 } } },
      { ...state, derivation: { ...state.derivation, brand: { kind: 'ai_observed', value: 'different' } } },
    ]) expect(aiSaveClaim(forged as AiDraftState, context, 1500)).toEqual({ status: 'invalid', code: 'CLAIM_CONFLICT' });
  });
  it('leaves current manual-only creation Save rejecting AI values, including after expiry', () => {
    let draft = editGarmentField(newGarmentDraft('EUR', 'en'), 'title', 'Manual title', 'en');
    draft = editGarmentField(draft, 'category', 'top', 'en');
    const state = ready(draft);
    expect(validateGarmentDraft(raw(state)).errors).toEqual({});
    expect(state.draft?.intent.brand).toBeUndefined();
    expect(() => buildGarmentWrite(raw(state))).toThrow();
    const expired = changed(expireAiDraft(state, context, 2000));
    expect(() => buildGarmentWrite(raw(expired))).toThrow();
    expect(expired.draft).toEqual(state.draft);
    expect(aiSaveClaim(expired, context, 2000).status).toBe('none');
  });
  it.each(formAiFields)('does not mutate the original result when manual input removes %s from the claim', (field: AiField) => {
    const state = ready();
    const edited = changed(editAiDraftField(state, context, field, initialRawFields('EUR')[field], 'en'));
    expect(edited.result?.facts.fields[field]).toEqual(allFields[field]);
    expect(claim(edited).fields).not.toHaveProperty(field);
    expect(claim(state).fields).toHaveProperty(field);
  });
});

describe('local tag suggestions from style words (G1)', () => {
  const owner = context.ownerId;
  const photo = { main: new Blob(['main'], { type: 'image/jpeg' }), thumb: new Blob(['thumb'], { type: 'image/jpeg' }),
    mainSha256: context.imageSha256, thumbSha256: 'c'.repeat(64), width: 120, height: 80 };
  const scope = { ownerId: owner, epoch: context.epoch, signal: new AbortController().signal };
  it('prefills untouched empty tags in order, deduplicated and bounded, never as category or colour labels', () => {
    const shown = changed(presentAiDraft(ready(), context, 'en'));
    expect(shown.draft?.raw.tags).toEqual(['Soft Lines', 'fictional style']);
    expect(shown.draft?.raw.tags).not.toContain('Top');
    expect(shown.draft?.raw.style_tags).toEqual([]);
    expect(shown.draft?.intent).toEqual({});
    expect(prefillTags(['a', 'A', 'b', 'x'.repeat(41), ' '], [], ['B'])).toEqual(['a']);
    expect(prefillTags(Array.from({ length: 20 }, (_, index) => `t${index}`), [], [])).toHaveLength(12);
  });
  it('bounds suggestions by the combined tags and style words budget (R4)', () => {
    const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    expect(prefillTags(names('n', 5), names('t', 4), names('s', 6))).toEqual(['n0', 'n1']);
    expect(prefillTags(names('n', 5), names('t', 4), names('s', 8))).toEqual([]);
    expect(prefillTags(names('n', 5), names('t', 10), names('s', 8))).toEqual([]);
    const wide = (count: number) => Array.from({ length: count }, (_, index) => 'ä'.repeat(39) + String.fromCharCode(0xe0 + index));
    expect(prefillTags(['x'.repeat(26), 'y'], wide(3), wide(6).slice(3))).toEqual(['x'.repeat(26)]);
    expect(prefillTags(['x'.repeat(27), 'y'], wide(3), wide(6).slice(3))).toEqual([]);
  });
  it('analysed Add accepts prefilled tags as unknown provenance and claims neither tags nor style_tags', () => {
    let state = changed(presentAiDraft(ready(), context, 'en'));
    state = changed(editAiDraftField(state, context, 'title', 'My shirt', 'en'));
    const attempt = newAnalyzedSaveAttempt(state, context, '', photo, scope, 1500);
    expect(attempt.values.tags).toEqual(['Soft Lines', 'fictional style']);
    expect(attempt.values.style_tags).toEqual([]);
    expect(attempt.payload.field_provenance.tags).toEqual({ kind: 'unknown', revision: 1 });
    expect(attempt.payload.field_provenance).not.toHaveProperty('style_tags');
    expect(attempt.payload.field_provenance).not.toHaveProperty('sleeve_length');
    expect(attempt.claim?.fields).not.toHaveProperty('tags');
    expect(attempt.claim?.fields).not.toHaveProperty('style_tags');
    expect(attempt.values.sleeve_length).toBeNull();
  });
  it('does not prefill after a tags edit or clear', () => {
    const cleared = changed(editAiDraftField(ready(), context, 'tags', [], 'en'));
    expect(changed(presentAiDraft(cleared, context, 'en')).draft?.raw.tags).toEqual([]);
  });
  function replacement(tags: string[], kind?: 'user' | 'unknown') {
    const draft = newGarmentDraft('EUR', 'en');
    draft.raw.title = 'Saved shirt'; draft.raw.category = 'top'; draft.raw.tags = tags;
    const values = validateGarmentDraft(draft).values!;
    const baseline = { values, provenance: kind ? { tags: { kind, revision: 2 } } : {} };
    const created = createAiDraft(newGarmentDraft('EUR', 'en', values), context, baseline);
    if (!created.ok) throw new Error('Expected saved draft');
    return changed(presentAiDraft(changed(receiveAiResult(changed(beginAiAnalysis(created.state, context)), context, result(), 1000)), context, 'en'));
  }
  it('replacement prefills only eligible (empty and unknown) tags', () => {
    expect(replacement([]).draft?.raw.tags).toEqual(['Soft Lines', 'fictional style']);
    expect(replacement([], 'unknown').draft?.raw.tags).toEqual(['Soft Lines', 'fictional style']);
    expect(replacement([], 'user').draft?.raw.tags).toEqual([]);
    expect(replacement(['kept'], 'user').draft?.raw.tags).toEqual(['kept']);
    expect(replacement(['kept'], 'unknown').draft?.raw.tags).toEqual(['kept']);
    expect(replacement([], 'user').draft?.intent).toEqual({});
  });
});

describe('AI status phases', () => {
  const base: AiPhaseInput = { status: 'idle', code: null, reason: null, working: false, polling: null, manual: false, applied: false };
  it('maps every reply code to off, limit or the neutral failure', () => {
    const off = ['CONSENT_REQUIRED', 'UNCONFIGURED', 'INACTIVE', 'CONFIG_CHANGED'];
    for (const code of aiCodes) {
      expect(phaseForCode(code)).toBe(off.includes(code) ? 'off' : code === 'ALLOWANCE' ? 'limit' : 'failed');
    }
    expect(phaseForCode('RATE_LIMIT')).toBe('failed');
  });
  it('maps every terminal reason to the neutral failure', () => {
    for (const reason of terminalReasons) expect(phaseForTerminal(reason)).toBe('failed');
  });
  it('applies the documented precedence', () => {
    expect(aiPhase({ ...base, status: null })).toBe('none');
    expect(aiPhase({ ...base, status: 'invalidated', manual: true })).toBe('none');
    expect(aiPhase({ ...base, status: 'failed', manual: true, applied: true })).toBe('manual');
    expect(aiPhase({ ...base, status: 'ready', code: 'ALLOWANCE' })).toBe('ready');
    for (const status of ['expired', 'cancelled', 'failed', 'unclear', 'pending'] as const) {
      expect(aiPhase({ ...base, status, applied: true, code: 'ALLOWANCE', polling: 'active' })).toBe('needsCheck');
    }
    expect(aiPhase({ ...base, status: 'unclear', code: 'ALLOWANCE' })).toBe('unclear');
    expect(aiPhase({ ...base, status: 'pending', working: true, code: 'INACTIVE' })).toBe('working');
    expect(aiPhase({ ...base, status: 'pending', polling: 'active', code: 'TIMEOUT' })).toBe('working');
    expect(aiPhase({ ...base, status: 'pending', polling: 'exhausted', code: 'ALLOWANCE' })).toBe('stillWorking');
    expect(aiPhase({ ...base, status: 'pending' })).toBe('stillWorking');
    expect(aiPhase({ ...base, status: 'idle', working: true })).toBe('working');
    expect(aiPhase({ ...base, status: 'idle', code: 'CONSENT_REQUIRED' })).toBe('off');
    expect(aiPhase({ ...base, status: 'idle', code: 'ALLOWANCE' })).toBe('limit');
    expect(aiPhase({ ...base, status: 'idle' })).toBe('none');
    expect(aiPhase({ ...base, status: 'failed', code: 'RATE_LIMIT' })).toBe('failed');
    expect(aiPhase({ ...base, status: 'failed', reason: 'EXPIRED', code: 'ALLOWANCE' })).toBe('failed');
    expect(aiPhase({ ...base, status: 'expired' })).toBe('failed');
  });
});
describe('same-request status polling', () => {
  afterEach(() => { vi.useRealTimers(); });
  const total = statusPollDelaysMs.reduce((sum, delay) => sum + delay, 0);
  it('keeps five delays inside the hard deadline', () => {
    expect(statusPollDelaysMs).toHaveLength(5);
    expect(total).toBeLessThan(statusPollDeadlineMs);
  });
  it('makes at most five calls, then reports exhaustion once', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => 'continue' as const);
    const exhausted = vi.fn();
    pollStatus(check, exhausted);
    await vi.advanceTimersByTimeAsync(statusPollDeadlineMs + 60000);
    expect(check).toHaveBeenCalledTimes(5);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });
  it('treats errors as another try and stops when done', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const check = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('offline'); return calls === 2 ? 'done' as const : 'continue' as const; });
    const exhausted = vi.fn();
    pollStatus(check, exhausted);
    await vi.advanceTimersByTimeAsync(statusPollDeadlineMs + 1000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(exhausted).not.toHaveBeenCalled();
  });
  it('is single-flight and aborts a hanging call at the deadline', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let open = 0, most = 0;
    const check = vi.fn((signal: AbortSignal) => {
      signals.push(signal); open += 1; most = Math.max(most, open);
      return new Promise<'continue'>(() => { signal.addEventListener('abort', () => { open -= 1; }); });
    });
    const exhausted = vi.fn();
    pollStatus(check, exhausted);
    await vi.advanceTimersByTimeAsync(statusPollDeadlineMs - 1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(exhausted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(most).toBe(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(1);
  });
  it('ignores a slow reply that lands after the deadline', async () => {
    vi.useFakeTimers();
    let settle: ((value: 'done') => void) | undefined;
    const check = vi.fn(() => new Promise<'done'>((resolve) => { settle = resolve; }));
    const exhausted = vi.fn();
    pollStatus(check, exhausted);
    await vi.advanceTimersByTimeAsync(statusPollDeadlineMs);
    settle?.('done');
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });
  it('stops without reporting exhaustion and aborts the open call', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const check = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<'continue'>(() => {}); });
    const exhausted = vi.fn();
    const stop = pollStatus(check, exhausted);
    await vi.advanceTimersByTimeAsync(statusPollDelaysMs[0]);
    stop();
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(statusPollDeadlineMs + 60000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(exhausted).not.toHaveBeenCalled();
  });
});
