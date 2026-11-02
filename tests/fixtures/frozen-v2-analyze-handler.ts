// FROZEN, import-free oracle for the v2-only analyze-clothing Edge function that a deployment made before BUDGET2 still runs
// (supabase/functions/analyze-clothing/handler.ts at 6ac52c3). It repeats that function's literal v2 profile and admission
// logic after authentication, with every dependency injected, so it never changes when product code does: the manifest id,
// prompt version, notice revision, model and reservation floor below are literals, not imports. It knows no v3 profile.
// Deployment-skew tests run it against v3 controls and require refusal before any claim or provider call.
const V2_MANIFEST = 'azure-eu-terra-devtest-v2';
const MODEL = 'gpt-5.6-terra-2026-07-09';
const PROMPT_VERSION = 2;
const NOTICE_REVISION = 2;
const RESERVATION_FLOOR = 4097351n;

type Json = Record<string, unknown>;
export type FrozenV2Io = {
  /** Stands for the Auth user lookup. */
  authenticate(): Promise<void>;
  /** Stands for a database RPC; the test records every call. */
  rpc(name: 'ai_status' | 'ai_claim_analysis' | 'ai_finish_analysis', body: Json): Promise<Json>;
  /** Stands for the Azure transport; the test counts calls. */
  provider(): Promise<void>;
  /** Whether the Azure key is configured. */
  providerConfigured: boolean;
};

const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The old function's flow from the authenticated user to the finish, with its closed result code. */
export async function frozenV2Analyze(io: FrozenV2Io): Promise<{ code: string }> {
  await io.authenticate();
  const preflight = await io.rpc('ai_status', {});
  if (preflight.code !== 'OK') return { code: 'UNAVAILABLE' };
  if (!record(preflight.budget)) return { code: 'UNAVAILABLE' };
  const policy = preflight.policy;
  if (!record(policy) || policy.activated !== true) return { code: 'INACTIVE' };
  const consent = preflight.consent;
  if (!record(consent) || consent.enabled !== true || !Number.isInteger(policy.noticeRevision) || Number(policy.noticeRevision) < 1
    || consent.noticeRevision !== policy.noticeRevision) return { code: 'CONSENT_REQUIRED' };
  // The literal v2-only admission gate.
  if (policy.modelId !== MODEL || policy.promptVersion !== PROMPT_VERSION || policy.noticeRevision !== NOTICE_REVISION
    || policy.executionManifestId !== V2_MANIFEST
    || typeof policy.maxRequestMicro !== 'string' || !/^[1-9][0-9]{0,18}$/.test(policy.maxRequestMicro)
    || BigInt(policy.maxRequestMicro) < RESERVATION_FLOOR
    || !io.providerConfigured) return { code: 'UNCONFIGURED' };
  const claim = await io.rpc('ai_claim_analysis', { p_manifest_id: V2_MANIFEST });
  if (claim.code !== 'OK' || claim.claimed !== true || claim.manifestId !== V2_MANIFEST) return { code: 'ANALYSIS_FAILED' };
  await io.provider();
  const finished = await io.rpc('ai_finish_analysis', { p_manifest_id: V2_MANIFEST });
  return finished.code === 'READY' && finished.stored === true ? { code: 'READY' } : { code: 'ANALYSIS_FAILED' };
}
