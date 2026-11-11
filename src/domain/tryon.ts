// VTO virtual try-on (issue #84, plan rev4, ADR28). INACTIVE: nothing here dispatches until the owner's bootstrap,
// probe and activation gates. The prompts, request parameters and settings are hashed into the manifest row of
// 20261003090000_try_on.sql, and the garment selection below is re-run in SQL at chain start (tryon_claim step 1).

// Manifest v2 (TRYON-LIMITS1) added the layer, outerwear and accessory prompts, six chained garments and results kept until the owner
// deletes them. Manifest v3 (TRYON-PROMPT1) changes only the layer and outerwear wording so a coat or jacket with a front opening is
// shown open. Manifest v4 (TRYON-PROMPT2) rewords those two again so a pullover is never given a zip or an opening. Manifest v5
// (TRYON-PROMPT3) adds a hem-length sentence to the top, one-piece and layer prompts and stops drawing outerwear (a coat or jacket stays in
// the outfit as an optional piece). Manifests v1 to v4 stay installed unchanged; their frozen prompts and settings are pinned in
// tests/fixtures/tryon-v{1,2,3,4}-frozen.ts.
export const TRYON_MANIFEST = 'azure-global-image25-sunburst-tryon-v5';
export const TRYON_MODEL = 'gpt-image-2.5-sunburst';
export const TRYON_DEPLOYMENT = 'eval-image25-sunburst-20260908';
// The same immutable provider identity as photo enhancement: both features share its capacity and switch (ADR28).
export const TRYON_DEPLOYMENT_KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
export const TRYON_ENDPOINT = 'https://stillroom-ai-eval.openai.azure.com/openai/v1/images/edits';
export const TRYON_PROMPT_VERSION = 5;
// Revision 3 is the notice that says a saved picture stays until the owner deletes it (TRYON-LIMITS1); revision 2 stated the one
// reusable reference photo (TRYON-PHOTO1) and revision 1 was never kept. The deployed Edge function checks the configured
// revision for equality with this constant, so the Edge function must be redeployed together with the migration that moves the
// configured revision to 3. Revisions 1 and 2 stay frozen in tests/unit/tryon-notice.test.ts.
export const TRYON_NOTICE_REVISION = 3;
export const TRYON_REVIEW_EXPIRES_AT = '2027-01-01T00:00:00Z';
// Estimated operational envelope, not an invoice ceiling: (15,000 input x 8.00 + 8,000 output x 30.00) per million USD.
export const TRYON_RESERVATION_MICRO = '360000';
// One garment per slot: top, bottom, layer, outerwear, shoes and one accessory (a one-piece replaces top and bottom).
export const TRYON_MAX_STEPS = 6;
export const TRYON_MAX_RESULTS = 200;
// A client that parses results without an outfit (unsaved Today ideas) says so on the results reads; without the header the
// database returns outfit results only, so an older cached client keeps a list it can parse.
export const TRYON_RESULTS_HEADER = 'X-Stillroom-TryOn-Results-Contract';
export const TRYON_RESULTS_CONTRACT = '2';
export const tryOnResultsHeaders = { [TRYON_RESULTS_HEADER]: TRYON_RESULTS_CONTRACT } as const;
// The most garments an unsaved idea may list (an outfit's own size limit applies to saved outfits).
export const TRYON_MAX_IDEA_ITEMS = 8;

// The wardrobe categories, kept import-free so the try-on Edge function can load this module (pinned equal to
// src/domain/wardrobe.ts in tests/unit/tryon-chain.test.ts).
export const tryOnCategories = ['top', 'bottom', 'one_piece', 'footwear', 'layer', 'outerwear', 'accessory'] as const;
type Category = (typeof tryOnCategories)[number];

export const tryOnSlots = ['one_piece', 'top', 'bottom', 'layer', 'outerwear', 'footwear', 'accessory'] as const;
export type TryOnSlot = (typeof tryOnSlots)[number];

// Fixed words only: no user text or item field is ever sent.
export const TRYON_SLOT_WORDS: Readonly<Record<TryOnSlot, string>> = Object.freeze({
  top: 'top', bottom: 'bottoms', one_piece: 'one-piece outfit', footwear: 'shoes', layer: 'layer worn over other clothing',
  outerwear: 'outerwear', accessory: 'accessory',
});

const PERSON_KEEP = 'Keep the person\'s face, hair, skin, body shape, pose, other clothing and background unchanged. ';
const GARMENT_KEEP = `${PERSON_KEEP}Keep the garment's colour, pattern, logos, length and shape.`;
const REPLACING = `Show the same person wearing this garment, replacing only the clothing it covers. ${GARMENT_KEEP}`;
// TRYON-PROMPT1: a layer or outerwear garment with a front opening is worn open so the existing clothing shows through, without
// inventing clothing; "keep the shape" alone made the model copy a closed coat. TRYON-PROMPT2: the construction is copied from the
// photo first, because a pullover hoodie was drawn with an invented zip; pullovers and neck-only zips stay as shown, while a
// full-length front opening is still worn open even when the coat is photographed fastened. The sentences below are fixed words,
// pinned verbatim.
const OPEN_RULES = 'Copy the garment\'s construction from image 2; never invent or extend an opening or fastening. Pullovers, '
  + 'including hooded sweatshirts, stay closed; a neck-only zip or placket stays as shown. Garments with a full-length front opening, '
  + 'including jackets and coats photographed fastened, are worn fully open with the front panels naturally parted, keeping existing '
  + 'underlying clothing visible through the opening. Do not mistake a kangaroo pocket or drawstrings for a zipper. Do not invent a '
  + 'top or other clothing, or reveal clothing hidden by another closed layer. '
  + `${PERSON_KEEP}Preserve the garment's colour, pattern, logos, length, cut and design; when worn open, change only the fastening `
  + 'and drape.';
// TRYON-PROMPT3: the image model sees a flat or cropped garment photo and guessed where the hem falls, so shirts and jackets came out
// hiked up at the belt line. Fixed words, only added to the top, one-piece and layer prompts; the layer also keeps what is worn underneath
// at its own length. Outerwear is no longer drawn (it stays an optional piece of the outfit), so its prompt is the v4 text, unused.
const LENGTH_RULE = 'Show the garment at the full length it has in image 2, with its hem falling where it would on a person of this '
  + 'build; do not shorten, crop, tuck in or hike it up.';
const UNDERNEATH_RULE = 'Keep the full length of the clothing underneath; its hem stays visible below this garment if it is longer.';
const REPLACING_LONG = `${REPLACING} ${LENGTH_RULE}`;
const TRYON_SLOT_ACTIONS: Readonly<Record<TryOnSlot, string>> = Object.freeze({
  top: REPLACING_LONG, bottom: REPLACING, one_piece: REPLACING_LONG, footwear: REPLACING,
  layer: `Show the same person wearing this garment over their existing clothing. ${OPEN_RULES} ${LENGTH_RULE} ${UNDERNEATH_RULE}`,
  outerwear: `Show the same person wearing this garment as the outermost layer over their existing clothing. ${OPEN_RULES}`,
  accessory: 'Show the same person wearing or carrying this item in the natural place for it, adding it without removing or '
    + 'changing any clothing. Keep the person\'s face, hair, skin, body shape, pose, clothing and background unchanged. '
    + 'Keep the item\'s colour, pattern, logos and shape.',
});

export function tryOnPrompt(slot: TryOnSlot): string {
  return `Image 1 shows a person. Image 2 shows one garment (${TRYON_SLOT_WORDS[slot]}). ${TRYON_SLOT_ACTIONS[slot]} `
    + 'Photorealistic, whole person in frame.';
}

// The canonical prompt set: its SHA-256 over JSON.stringify is the manifest's prompt hash. The key order is part of the hash.
export const TRYON_PROMPTS: Readonly<Record<TryOnSlot, string>> = Object.freeze({
  one_piece: tryOnPrompt('one_piece'), top: tryOnPrompt('top'), bottom: tryOnPrompt('bottom'), layer: tryOnPrompt('layer'),
  outerwear: tryOnPrompt('outerwear'), footwear: tryOnPrompt('footwear'), accessory: tryOnPrompt('accessory'),
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
  inputTokens: 15000, outputTokens: 8000, chainMinutes: 30,
});

export const TRYON_SETTINGS = Object.freeze({
  profileId: TRYON_MANIFEST, purpose: 'inactive-virtual-try-on', product: 'Azure OpenAI', deploymentType: 'GlobalStandard',
  region: 'Global', api: 'v1/images/edits', endpoint: TRYON_ENDPOINT, deployment: TRYON_DEPLOYMENT,
  deploymentKey: TRYON_DEPLOYMENT_KEY, expectedModel: TRYON_MODEL, promptVersion: TRYON_PROMPT_VERSION,
  // The provider-facing profile was reviewed against notice revision 1 and is unchanged by the notice; consent uses
  // TRYON_NOTICE_REVISION.
  noticeRevision: 1, reviewExpiresAt: TRYON_REVIEW_EXPIRES_AT, parameters: TRYON_PARAMETERS,
  input: 'person-baseline-jpeg-1024x1280-in-memory-plus-stored-main-garment-jpeg', chaining: 'one-garment-per-call-max-6',
  maxSteps: TRYON_MAX_STEPS, maxResults: TRYON_MAX_RESULTS, resultRetention: 'until-deleted',
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
/**
 * `optional` are the outerwear pieces of the outfit: they stay in it but are never drawn (TRYON-PROMPT3). `legacyItemIds` is the garment
 * set a manifest before v5 would have drawn (the steps plus the first outerwear piece), or null without outerwear; only an exact match of
 * that set finds a picture made before v5, so a picture of one coat never stands for another.
 */
export type TryOnSelection = { steps: TryOnStep[]; notIncluded: string[]; optional: string[]; legacyItemIds: string[] | null };

/** Categories that belong to an outfit but are never drawn in a picture. */
export const TRYON_OPTIONAL_CATEGORIES: readonly string[] = ['outerwear'];
export const isTryOnOptional = (category: string | null | undefined): boolean => category != null && TRYON_OPTIONAL_CATEGORIES.includes(category);

const eligible = (item: TryOnCandidate) => item.lifecycle === 'active' && !item.deleted && item.readyImage;
const first = (items: readonly TryOnCandidate[], category: Category) =>
  items.find((item) => item.category === category && eligible(item));

/**
 * Deterministic garment chain for a saved outfit, in the outfit's saved order, one garment per slot: a one-piece replaces the
 * top and bottom steps; otherwise top then bottom; then layer, footwear and one accessory. At most six steps. Outerwear is not a step
 * from manifest v5 on: it is listed as optional. A second layer or accessory is listed as not included; archived, sold, donated,
 * deleted or photo-less items are skipped. The SQL copy is private.tryon_select_steps / tryon_select_idea_steps, whose v5 result
 * private.tryon_drawn_steps trims in the same way.
 */
export const TRYON_STEP_ORDER = ['top', 'bottom', 'layer', 'footwear', 'accessory'] as const;
export const TRYON_ONE_PIECE_STEP_ORDER = ['one_piece', 'layer', 'footwear', 'accessory'] as const;
export function selectTryOnSteps(items: readonly TryOnCandidate[]): TryOnSelection {
  const order: readonly TryOnSlot[] = first(items, 'one_piece') ? TRYON_ONE_PIECE_STEP_ORDER : TRYON_STEP_ORDER;
  const steps = order.flatMap((slot) => {
    const item = first(items, slot);
    return item ? [{ slot, itemId: item.itemId }] : [];
  }).slice(0, TRYON_MAX_STEPS);
  const picked = new Set(steps.map((step) => step.itemId));
  const notIncluded = items.filter((item) => ['layer', 'accessory'].includes(item.category) && eligible(item)
    && !picked.has(item.itemId)).map((item) => item.itemId);
  const optional = items.filter((item) => item.category === 'outerwear' && eligible(item)).map((item) => item.itemId);
  const legacyItemIds = optional.length > 0 ? [...steps.map((step) => step.itemId), optional[0]!] : null;
  return { steps, notIncluded, optional, legacyItemIds };
}
