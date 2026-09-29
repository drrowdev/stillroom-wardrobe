// VTO virtual try-on (issue #84, plan rev4, ADR28). INACTIVE: nothing here dispatches until the owner's bootstrap,
// probe and activation gates. The prompts, request parameters and settings are hashed into the manifest row of
// 20261003090000_try_on.sql, and the garment selection below is re-run in SQL at chain start (tryon_claim step 1).
import type { Category } from './wardrobe';

export const TRYON_MANIFEST = 'azure-global-image25-sunburst-tryon-v1';
export const TRYON_MODEL = 'gpt-image-2.5-sunburst';
export const TRYON_DEPLOYMENT = 'eval-image25-sunburst-20260908';
// The same immutable provider identity as photo enhancement: both features share its capacity and switch (ADR28).
export const TRYON_DEPLOYMENT_KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
export const TRYON_ENDPOINT = 'https://stillroom-ai-eval.openai.azure.com/openai/v1/images/edits';
export const TRYON_PROMPT_VERSION = 1;
export const TRYON_NOTICE_REVISION = 1;
export const TRYON_REVIEW_EXPIRES_AT = '2027-01-01T00:00:00Z';
// Estimated operational envelope, not an invoice ceiling: (15,000 input x 8.00 + 8,000 output x 30.00) per million USD.
export const TRYON_RESERVATION_MICRO = '360000';
export const TRYON_MAX_STEPS = 3;
export const TRYON_MAX_RESULTS = 20;

export const tryOnSlots = ['one_piece', 'top', 'bottom', 'footwear'] as const;
export type TryOnSlot = (typeof tryOnSlots)[number];

// Fixed words only: no user text or item field is ever sent.
export const TRYON_SLOT_WORDS: Readonly<Record<TryOnSlot, string>> = Object.freeze({
  top: 'top', bottom: 'bottoms', one_piece: 'one-piece outfit', footwear: 'shoes',
});

export function tryOnPrompt(slot: TryOnSlot): string {
  return `Image 1 shows a person. Image 2 shows one garment (${TRYON_SLOT_WORDS[slot]}). Show the same person wearing this `
    + 'garment, replacing only the clothing it covers. Keep the person\'s face, hair, skin, body shape, pose, other clothing '
    + 'and background unchanged. Keep the garment\'s colour, pattern, logos, length and shape. Photorealistic, whole person '
    + 'in frame.';
}

// The canonical prompt set: its SHA-256 over JSON.stringify is the manifest's prompt hash.
export const TRYON_PROMPTS: Readonly<Record<TryOnSlot, string>> = Object.freeze({
  one_piece: tryOnPrompt('one_piece'), top: tryOnPrompt('top'), bottom: tryOnPrompt('bottom'), footwear: tryOnPrompt('footwear'),
});

// Frozen parameter set. image[] carries [person, garment]; any variant (input_fidelity, quality) is a new manifest.
export const TRYON_PARAMETERS = Object.freeze({
  model: TRYON_DEPLOYMENT, n: 1, size: '1024x1280', quality: 'medium', output_format: 'jpeg', output_compression: 85,
  background: 'opaque',
});

export const TRYON_LIMITS = Object.freeze({
  personBytes: 512000, personWidth: 1024, personHeight: 1280, garmentBytes: 512000, ingressBytes: 600000,
  responseBytes: 4194304, outputBytes: 512000, outputWidth: 1024, outputHeight: 1280,
  providerMs: 70000, downloadMs: 10000, markMs: 2000, dispatchMs: 15000, serverMs: 90000, clientStepMs: 100000,
  inputTokens: 15000, outputTokens: 8000, resultDays: 7, chainMinutes: 30,
});

export const TRYON_SETTINGS = Object.freeze({
  profileId: TRYON_MANIFEST, purpose: 'inactive-virtual-try-on', product: 'Azure OpenAI', deploymentType: 'GlobalStandard',
  region: 'Global', api: 'v1/images/edits', endpoint: TRYON_ENDPOINT, deployment: TRYON_DEPLOYMENT,
  deploymentKey: TRYON_DEPLOYMENT_KEY, expectedModel: TRYON_MODEL, promptVersion: TRYON_PROMPT_VERSION,
  noticeRevision: TRYON_NOTICE_REVISION, reviewExpiresAt: TRYON_REVIEW_EXPIRES_AT, parameters: TRYON_PARAMETERS,
  input: 'person-baseline-jpeg-1024x1280-in-memory-plus-stored-main-garment-jpeg', chaining: 'one-garment-per-call-max-3',
  output: 'admitProviderJpeg-baseline-1024x1280', limits: TRYON_LIMITS,
  capacity: { windowSeconds: 60, maxDispatch: 2, sharedWith: 'azure-global-image25-sunburst-enhance-v1' },
  metering: { requiredCounters: ['usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens',
    'usage.input_tokens_details.text_tokens', 'usage.input_tokens_details.image_tokens'], currency: 'USD',
  inputRateHundredthsPerMillion: 800, outputRateHundredthsPerMillion: 3000, reservationMicro: TRYON_RESERVATION_MICRO,
  reservationValuation: 'all input at image-in 8.00; text-in is 5.00', rounding: 'sum-token-rate-products-then-ceiling-divide-by-100' },
  automaticRetries: 0, fallback: false,
});

/** The same arithmetic as the try-on manifest (ceiling of the rate products over 100). */
export function tryOnEstimateMicro(input: number, output: number): bigint {
  return (BigInt(input) * 800n + BigInt(output) * 3000n + 99n) / 100n;
}

export type TryOnCandidate = {
  itemId: string;
  category: Category;
  lifecycle: 'active' | 'archived' | 'donated' | 'sold';
  deleted: boolean;
  readyImage: boolean;
};
export type TryOnStep = { slot: TryOnSlot; itemId: string };
export type TryOnSelection = { steps: TryOnStep[]; notIncluded: string[] };

const eligible = (item: TryOnCandidate) => item.lifecycle === 'active' && !item.deleted && item.readyImage;
const first = (items: readonly TryOnCandidate[], category: Category) =>
  items.find((item) => item.category === category && eligible(item));

/**
 * Deterministic garment chain for a saved outfit, in the outfit's saved order: a one-piece replaces the top and bottom
 * steps; otherwise top then bottom; then footwear. At most three steps. Layers, outerwear and accessories are listed as
 * not included; archived, sold, donated, deleted or photo-less items are skipped.
 */
export function selectTryOnSteps(items: readonly TryOnCandidate[]): TryOnSelection {
  const onePiece = first(items, 'one_piece');
  const picked: (TryOnCandidate | undefined)[] = onePiece
    ? [onePiece, first(items, 'footwear')]
    : [first(items, 'top'), first(items, 'bottom'), first(items, 'footwear')];
  const steps = picked.filter((item): item is TryOnCandidate => item !== undefined)
    .map((item) => ({ slot: item.category as TryOnSlot, itemId: item.itemId }))
    .slice(0, TRYON_MAX_STEPS);
  const notIncluded = items.filter((item) => ['layer', 'outerwear', 'accessory'].includes(item.category) && eligible(item))
    .map((item) => item.itemId);
  return { steps, notIncluded };
}
