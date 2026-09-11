import {
  GENERATION_CONFIG, MAX_PROVIDER_BYTES, MODEL_ID, PROMPT, ProtocolError, REVIEW_EXPIRES,
  SAFETY_SETTINGS, object, readJson, validFacts, type JsonObject,
} from './protocol.ts';

export type GoogleConfig = { projectId?: string; clientEmail?: string; privateKey?: string };
export type Transport = (input: string, init: RequestInit) => Promise<Response>;
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_ORIGIN = 'https://aiplatform.eu.rep.googleapis.com';
const encode = (value: Uint8Array) => {
  let result = '';
  for (let offset = 0; offset < value.length; offset += 8192) result += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(result);
};
const base64url = (value: Uint8Array) => encode(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const encodedJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function googleToken(config: GoogleConfig, signal: AbortSignal, transport: Transport = fetch): Promise<string> {
  if (!config.projectId || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)
    || !config.clientEmail || !/^[a-zA-Z0-9._-]{1,64}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(config.clientEmail)
    || !config.privateKey || config.privateKey.length > 8192 || Date.now() >= REVIEW_EXPIRES) {
    throw new ProtocolError('UNCONFIGURED');
  }
  try {
    const match = /^-{5}BEGIN PRIVATE KEY-{5}\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-{5}END PRIVATE KEY-{5}\r?\n?$/.exec(config.privateKey);
    if (!match) throw new Error();
    const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(match[1]!.replace(/[\r\n]/g, '')), (c) => c.charCodeAt(0)),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    if ((key.algorithm as RsaKeyAlgorithm).modulusLength < 2048) throw new Error();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encodedJson({ alg: 'RS256', typ: 'JWT' })}.${encodedJson({
      iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: TOKEN_URL, iat: now, exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    signal.throwIfAborted();
    const response = await transport(TOKEN_URL, {
      method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(new Uint8Array(signature))}` }),
    });
    const token = await readJson(response, 16384, signal);
    if (!response.ok || !object(token) || typeof token.access_token !== 'string'
      || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(token.access_token) || token.token_type !== 'Bearer'
      || typeof token.expires_in !== 'number' || !Number.isInteger(token.expires_in)
      || token.expires_in < 30 || token.expires_in > 3600) throw new Error();
    return token.access_token;
  } catch {
    signal.throwIfAborted();
    throw new ProtocolError('UNCONFIGURED');
  }
}

export type Usage = { modelVersion: string; trafficType: 'ON_DEMAND'; promptTokenCount: number; totalTokenCount: number;
  candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; cachedContentTokenCount?: number };
export function normalizeUsage(value: unknown, model: unknown): Usage | null {
  if (model !== MODEL_ID || !object(value) || value.trafficType !== 'ON_DEMAND') return null;
  const counter = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!counter(value.promptTokenCount) || !counter(value.totalTokenCount) || value.totalTokenCount < value.promptTokenCount) return null;
  const usage: Usage = { modelVersion: MODEL_ID, trafficType: 'ON_DEMAND',
    promptTokenCount: value.promptTokenCount, totalTokenCount: value.totalTokenCount };
  const optional = ['candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount', 'cachedContentTokenCount'] as const;
  for (const key of optional) {
    if (!Object.hasOwn(value, key)) continue;
    if (!counter(value[key])) return null;
    usage[key] = value[key];
  }
  if ((usage.cachedContentTokenCount ?? 0) > usage.promptTokenCount
    || (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0)
      > usage.totalTokenCount - usage.promptTokenCount) return null;
  for (const name of ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails']) {
    if (!Object.hasOwn(value, name)) continue;
    const details = value[name];
    if (!Array.isArray(details) || details.length > 4) return null;
    const seen = new Set<string>();
    let total = 0;
    for (const detail of details) {
      if (!object(detail) || !['TEXT', 'IMAGE', 'VIDEO', 'AUDIO'].includes(String(detail.modality))
        || !counter(detail.tokenCount) || seen.has(String(detail.modality))) return null;
      if ((name === 'candidatesTokensDetails' || name === 'toolUsePromptTokensDetails') && detail.modality !== 'TEXT') return null;
      seen.add(String(detail.modality)); total += detail.tokenCount;
    }
    const expected = name === 'promptTokensDetails' ? usage.promptTokenCount : name === 'cacheTokensDetails'
      ? usage.cachedContentTokenCount : name === 'candidatesTokensDetails' ? usage.candidatesTokenCount : usage.toolUsePromptTokenCount;
    if (!Number.isSafeInteger(total) || expected === undefined || total !== expected) return null;
  }
  return usage;
}
export function estimatedMicro(usage: Usage): string {
  return ((BigInt(usage.promptTokenCount) * 165n + BigInt(usage.totalTokenCount - usage.promptTokenCount) * 825n + 99n) / 100n).toString();
}
export async function analyzeGoogle(config: GoogleConfig, token: string, image: Uint8Array, signal: AbortSignal,
  transport: Transport = fetch): Promise<{ facts: JsonObject | null; usage: Usage | null }> {
  const response = await transport(`${GOOGLE_ORIGIN}/v1/projects/${config.projectId}/locations/eu/publishers/google/models/${MODEL_ID}:generateContent`, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { Authorization: 'Bearer '.concat(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: PROMPT }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: encode(image) } }] }],
      generationConfig: GENERATION_CONFIG, safetySettings: SAFETY_SETTINGS }),
  });
  const data = await readJson(response, MAX_PROVIDER_BYTES, signal);
  if (!object(data)) return { facts: null, usage: null };
  const usage = normalizeUsage(data.usageMetadata, data.modelVersion);
  let facts: JsonObject | null = null;
  const candidates = data.candidates;
  if (response.ok && data.modelVersion === MODEL_ID && !data.promptFeedback
    && Array.isArray(candidates) && candidates.length === 1 && object(candidates[0])) {
    const candidate = candidates[0];
    const content = candidate.content;
    if (candidate.finishReason === 'STOP' && object(content) && content.role === 'model'
      && Array.isArray(content.parts) && content.parts.length === 1
      && object(content.parts[0]) && Object.keys(content.parts[0]).length === 1 && typeof content.parts[0].text === 'string'
      && (!candidate.safetyRatings || Array.isArray(candidate.safetyRatings)
        && candidate.safetyRatings.every((rating) => object(rating) && rating.blocked !== true))) {
      try {
        const parsed: unknown = JSON.parse(content.parts[0].text);
        if (validFacts(parsed)) facts = parsed;
      } catch { /* Invalid content does not erase independently reported usage. */ }
    }
  }
  return { facts, usage };
}
