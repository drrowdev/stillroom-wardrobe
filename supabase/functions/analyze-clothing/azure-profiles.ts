import { AZURE_MANIFEST, AZURE_RESERVATION, AZURE_SETTINGS } from './azure-openai.ts';

// BUDGET2: the manifests this function dispatches under. Both send the same provider request (same prompt, schema and
// body controls). v3 holds no worst-case amount against the monthly budget: its reservation is the smallest value the
// controls and usage constraints accept, and the real cost is recorded when the analysis finishes.
export const AZURE_MANIFEST_V3 = 'azure-eu-terra-devtest-v3';
export const AZURE_RESERVATION_V3 = '1';
export const AZURE_INPUT_ENVELOPE_V3 = 16384;

/** v2's pinned settings with exactly three values replaced; the key order stays v2's, so the digest is reproducible. */
export const AZURE_SETTINGS_V3 = {
  ...AZURE_SETTINGS,
  profileId: AZURE_MANIFEST_V3,
  limits: { ...AZURE_SETTINGS.limits, inputTokens: AZURE_INPUT_ENVELOPE_V3 },
  metering: { ...AZURE_SETTINGS.metering, reservationMicro: AZURE_RESERVATION_V3 },
};

export type AzureProfile = Readonly<{ manifestId: string; promptVersion: number; reservationMicro: string }>;
export const AZURE_PROFILES: readonly AzureProfile[] = Object.freeze([
  Object.freeze({ manifestId: AZURE_MANIFEST, promptVersion: AZURE_SETTINGS.promptVersion, reservationMicro: AZURE_RESERVATION }),
  Object.freeze({ manifestId: AZURE_MANIFEST_V3, promptVersion: AZURE_SETTINGS_V3.promptVersion, reservationMicro: AZURE_RESERVATION_V3 }),
]);

/** The profile for the manifest id the account's controls name, or null when this function does not dispatch it. */
export function azureProfileFor(manifestId: unknown): AzureProfile | null {
  return AZURE_PROFILES.find((profile) => profile.manifestId === manifestId) ?? null;
}
