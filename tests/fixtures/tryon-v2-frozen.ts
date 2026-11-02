// The installed try-on manifest v2 (20261101200000_tryon_limits.sql), frozen so its prompt and settings hash pins keep passing after
// the domain moved to manifest v3 (TRYON-PROMPT1). Never edit this file: it reproduces what was hashed.
import {
  TRYON_DEPLOYMENT, TRYON_DEPLOYMENT_KEY, TRYON_ENDPOINT, TRYON_MODEL, TRYON_PARAMETERS, TRYON_RESERVATION_MICRO,
} from '../../src/domain/tryon';

export const TRYON_V2_MANIFEST = 'azure-global-image25-sunburst-tryon-v2';

const words = {
  top: 'top', bottom: 'bottoms', one_piece: 'one-piece outfit', footwear: 'shoes', layer: 'layer worn over other clothing',
  outerwear: 'outerwear', accessory: 'accessory',
} as const;
const KEEP = 'Keep the person\'s face, hair, skin, body shape, pose, other clothing and background unchanged. '
  + 'Keep the garment\'s colour, pattern, logos, length and shape.';
const REPLACING = `Show the same person wearing this garment, replacing only the clothing it covers. ${KEEP}`;
const actions = {
  top: REPLACING, bottom: REPLACING, one_piece: REPLACING, footwear: REPLACING,
  layer: 'Show the same person wearing this garment over the clothing they already wear, leaving that clothing in place and '
    + `visible where the garment is open or short. ${KEEP}`,
  outerwear: `Show the same person wearing this garment as the outermost layer, over the clothing they already wear. ${KEEP}`,
  accessory: 'Show the same person wearing or carrying this item in the natural place for it, adding it without removing or '
    + 'changing any clothing. Keep the person\'s face, hair, skin, body shape, pose, clothing and background unchanged. '
    + 'Keep the item\'s colour, pattern, logos and shape.',
} as const;
const prompt = (slot: keyof typeof words) => `Image 1 shows a person. Image 2 shows one garment (${words[slot]}). ${actions[slot]} `
  + 'Photorealistic, whole person in frame.';

export const TRYON_V2_PROMPTS = Object.freeze({
  one_piece: prompt('one_piece'), top: prompt('top'), bottom: prompt('bottom'), layer: prompt('layer'),
  outerwear: prompt('outerwear'), footwear: prompt('footwear'), accessory: prompt('accessory'),
});

const limits = Object.freeze({
  personBytes: 512000, personWidth: 1024, personHeight: 1280, garmentBytes: 512000, ingressBytes: 600000,
  responseBytes: 4194304, outputBytes: 512000, outputWidth: 1024, outputHeight: 1280,
  providerMs: 70000, downloadMs: 10000, markMs: 2000, dispatchMs: 15000, serverMs: 90000, clientStepMs: 100000,
  inputTokens: 15000, outputTokens: 8000, chainMinutes: 30,
});

export const TRYON_V2_SETTINGS = Object.freeze({
  profileId: TRYON_V2_MANIFEST, purpose: 'inactive-virtual-try-on', product: 'Azure OpenAI', deploymentType: 'GlobalStandard',
  region: 'Global', api: 'v1/images/edits', endpoint: TRYON_ENDPOINT, deployment: TRYON_DEPLOYMENT,
  deploymentKey: TRYON_DEPLOYMENT_KEY, expectedModel: TRYON_MODEL, promptVersion: 2,
  noticeRevision: 1, reviewExpiresAt: '2027-01-01T00:00:00Z', parameters: TRYON_PARAMETERS,
  input: 'person-baseline-jpeg-1024x1280-in-memory-plus-stored-main-garment-jpeg', chaining: 'one-garment-per-call-max-6',
  maxSteps: 6, maxResults: 200, resultRetention: 'until-deleted',
  output: 'admitProviderJpeg-baseline-1024x1280', limits,
  capacity: { windowSeconds: 60, maxDispatch: 2, sharedWith: 'azure-global-image25-sunburst-enhance-v1' },
  metering: { requiredCounters: ['usage.input_tokens', 'usage.output_tokens', 'usage.total_tokens',
    'usage.input_tokens_details.text_tokens', 'usage.input_tokens_details.image_tokens'], currency: 'USD',
  inputRateHundredthsPerMillion: 800, outputRateHundredthsPerMillion: 3000, reservationMicro: TRYON_RESERVATION_MICRO,
  reservationValuation: 'all input at image-in 8.00; text-in is 5.00', rounding: 'sum-token-rate-products-then-ceiling-divide-by-100' },
  automaticRetries: 0, fallback: false,
});
