// BG2b photo enhancement (issue #84, plan rev3). INACTIVE: nothing here dispatches until the owner's activation.
// The prompt, request parameters and settings are hashed into the manifest row of 20260929090000_photo_enhancement.sql.
export const ENHANCE_MANIFEST = 'azure-global-image25-sunburst-enhance-v1';
export const ENHANCE_MODEL = 'gpt-image-2.5-sunburst';
export const ENHANCE_DEPLOYMENT = 'eval-image25-sunburst-20260908';
// Immutable provider identity for the shared global capacity (M2): resource / deployment / deployment date.
export const ENHANCE_DEPLOYMENT_KEY = 'stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08';
export const ENHANCE_ENDPOINT = 'https://stillroom-ai-eval.openai.azure.com/openai/v1/images/edits';
export const ENHANCE_PROMPT_VERSION = 1;
export const ENHANCE_NOTICE_REVISION = 1;
export const ENHANCE_REVIEW_EXPIRES_AT = '2027-01-01T00:00:00Z';
export const ENHANCE_REVIEW_EXPIRES = Date.parse(ENHANCE_REVIEW_EXPIRES_AT);
// Estimated operational envelope, not an invoice ceiling: (7,500 input x 8.00 + 8,000 output x 30.00) per million USD.
export const ENHANCE_RESERVATION_MICRO = '300000';

export const ENHANCE_PROMPT = 'Edit this product photo of a single garment. Keep the garment exactly as it is: the same colours, '
  + 'pattern, print, logos, text, labels, buttons, seams, stitching, pockets, trims, fabric texture, shape, proportions and '
  + 'every visible detail. Only smooth creases and wrinkles and tidy the presentation so it looks like a neat product photo. '
  + 'Keep the plain light background. Do not add, remove, move or recolour anything, do not add people, hangers, props, '
  + 'shadows, text or watermarks, and do not change the viewpoint or crop.';

// Frozen parameter set (L1). Any variant, including input_fidelity or another quality, is a new manifest and probe.
export const ENHANCE_PARAMETERS = Object.freeze({
  model: ENHANCE_DEPLOYMENT, n: 1, size: '1024x1280', quality: 'medium', output_format: 'jpeg', output_compression: 85,
  background: 'opaque',
});

export const ENHANCE_LIMITS = Object.freeze({
  imageBytes: 512000, imageMaxSide: 1600, responseBytes: 4194304, outputBytes: 512000, outputWidth: 1024, outputHeight: 1280,
  providerMs: 70000, requestMs: 85000, dispatchMs: 5000, clientStageMs: 90000,
  inputTokens: 7500, outputTokens: 8000, evidenceHours: 24,
});

export const ENHANCE_SETTINGS = Object.freeze({
  profileId: ENHANCE_MANIFEST, purpose: 'inactive-photo-enhancement', product: 'Azure OpenAI', deploymentType: 'GlobalStandard',
  region: 'Global', api: 'v1/images/edits', endpoint: ENHANCE_ENDPOINT, deployment: ENHANCE_DEPLOYMENT,
  deploymentKey: ENHANCE_DEPLOYMENT_KEY, expectedModel: ENHANCE_MODEL, promptVersion: ENHANCE_PROMPT_VERSION,
  noticeRevision: ENHANCE_NOTICE_REVISION, reviewExpiresAt: ENHANCE_REVIEW_EXPIRES_AT,
  parameters: ENHANCE_PARAMETERS, input: 'prepared-main-jpeg-after-background-removal-and-framing',
  output: 'admitProviderJpeg-baseline-1024x1280-preserve-only', limits: ENHANCE_LIMITS,
  capacity: { windowSeconds: 60, maxDispatch: 2 },
  metering: { requiredCounters: ['usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens',
    'usage.input_tokens_details.text_tokens', 'usage.input_tokens_details.image_tokens'], currency: 'USD',
  inputRateHundredthsPerMillion: 800, outputRateHundredthsPerMillion: 3000, reservationMicro: ENHANCE_RESERVATION_MICRO,
  reservationValuation: 'all input at image-in 8.00; text-in is 5.00', rounding: 'sum-token-rate-products-then-ceiling-divide-by-100' },
  automaticRetries: 0, fallback: false,
});

// BG2c "clean up photo" (#84, plan rev4). The server contract of the enhance-photo function and
// 20261002090000_photo_cleanup_manifest.sql: the same model, deployment, parameters, limits and reservation as v1, a new
// prompt and input, and notice revision 2. INACTIVE. BG2c-2 moves the client (consent, readiness and the stage) from
// the v1 constants above to these, together with the revision-2 notice copy; until then the client treats a cleanup-v1
// policy as unsupported, so nothing is offered or sent.
export const CLEANUP_MANIFEST = 'azure-global-image25-sunburst-cleanup-v1';
export const CLEANUP_PROMPT_VERSION = 2;
export const CLEANUP_NOTICE_REVISION = 2;
export const CLEANUP_PROMPT = 'Clean up this photo of a garment for a wardrobe catalogue. Show only the one garment in the middle of the '
  + 'photo, on a plain, even, light warm off-white background (#F6F3ED). Remove hangers, clips, hooks, other clothes, furniture, '
  + 'people, hands and everything else that is not part of that garment, and smooth its creases and wrinkles. Keep that garment '
  + 'itself exactly as it is: the same colours, pattern, print, logos, text, labels, buttons, seams, stitching, pockets, trims, '
  + 'fabric texture, shape and proportions, and every visible detail. Do not replace it with a different or more generic '
  + 'garment. Keep it at the same position, size and angle in the frame, and do not change the viewpoint, crop or zoom. Do not '
  + 'add anything: no people, mannequins, hangers, props, shadows, text or watermarks.';
export const CLEANUP_SETTINGS = Object.freeze({
  ...ENHANCE_SETTINGS, profileId: CLEANUP_MANIFEST, purpose: 'inactive-photo-cleanup', promptVersion: CLEANUP_PROMPT_VERSION,
  noticeRevision: CLEANUP_NOTICE_REVISION, input: 'accepted-crop-original-pixels-in-bg2a-frame-app-reencoded',
});

export type EnhanceUsage = { input: number | null; output: number | null; total: number | null; inputText: number | null; inputImage: number | null };

const counter = (value: unknown, key: string): number | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return null;
  const n = (value as Record<string, unknown>)[key];
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Reads the images API `usage` block. Missing counters stay null, and finish settles them at the reservation. */
export function observeEnhanceUsage(value: unknown): EnhanceUsage {
  const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const usage = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage) ? body.usage : {};
  const details = (usage as Record<string, unknown>).input_tokens_details;
  return { input: counter(usage, 'input_tokens'), output: counter(usage, 'output_tokens'), total: counter(usage, 'total_tokens'),
    inputText: counter(details, 'text_tokens'), inputImage: counter(details, 'image_tokens') };
}

/** The same arithmetic as private.enhance_azure_usage (ceiling of the rate products over 100). */
export function enhanceEstimateMicro(usage: EnhanceUsage): bigint | null {
  if (usage.input === null || usage.output === null) return null;
  return (BigInt(usage.input) * 800n + BigInt(usage.output) * 3000n + 99n) / 100n;
}
