import { AZURE_MANIFEST, AZURE_RESERVATION, AZURE_SETTINGS, AZURE_SPEC_V2, type AzureSpec } from './azure-openai.ts';
import { AZURE_SPEC_V4 } from './azure-v4.ts';

// BUDGET2: the manifests this function dispatches under. v2 and v3 send the same provider request (same prompt, schema and
// body controls). v3 holds no worst-case amount against the monthly budget: its reservation is the smallest value the
// controls and usage constraints accept, and the real cost is recorded when the analysis finishes.
// CAPS1a: v4 is v3 with prompt version 3: one more closed field, garment_type, in the prompt and schema (15 keys, not 14).
export const AZURE_MANIFEST_V3 = 'azure-eu-terra-devtest-v3';
export const AZURE_MANIFEST_V4 = 'azure-eu-terra-devtest-v4';
export const AZURE_RESERVATION_V3 = '1';
export const AZURE_INPUT_ENVELOPE_V3 = 16384;

/** v2's pinned settings with exactly three values replaced; the key order stays v2's, so the digest is reproducible. */
export const AZURE_SETTINGS_V3 = {
  ...AZURE_SETTINGS,
  profileId: AZURE_MANIFEST_V3,
  limits: { ...AZURE_SETTINGS.limits, inputTokens: AZURE_INPUT_ENVELOPE_V3 },
  metering: { ...AZURE_SETTINGS.metering, reservationMicro: AZURE_RESERVATION_V3 },
};
/** v3's settings with the profile id and the prompt version replaced; the key order stays v2's. */
export const AZURE_SETTINGS_V4 = { ...AZURE_SETTINGS_V3, profileId: AZURE_MANIFEST_V4, promptVersion: 3 };

export type AzureProfile = Readonly<{ manifestId: string; promptVersion: number; reservationMicro: string; spec: AzureSpec }>;
export const AZURE_PROFILES: readonly AzureProfile[] = Object.freeze([
  Object.freeze({ manifestId: AZURE_MANIFEST, promptVersion: AZURE_SETTINGS.promptVersion, reservationMicro: AZURE_RESERVATION, spec: AZURE_SPEC_V2 }),
  Object.freeze({ manifestId: AZURE_MANIFEST_V3, promptVersion: AZURE_SETTINGS_V3.promptVersion, reservationMicro: AZURE_RESERVATION_V3, spec: AZURE_SPEC_V2 }),
  Object.freeze({ manifestId: AZURE_MANIFEST_V4, promptVersion: AZURE_SETTINGS_V4.promptVersion, reservationMicro: AZURE_RESERVATION_V3, spec: AZURE_SPEC_V4 }),
]);

/** The profile for the manifest id the account's controls name, or null when this function does not dispatch it. */
export function azureProfileFor(manifestId: unknown): AzureProfile | null {
  return AZURE_PROFILES.find((profile) => profile.manifestId === manifestId) ?? null;
}
