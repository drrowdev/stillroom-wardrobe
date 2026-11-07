import { AiClient, AiError, AiNotSentError, type BeforeSend } from './ai';
import {
  GENERATE_TIMEOUT_MS, parseDecision, parseGenerateReply, parseOutfitGenStatus, parseSuggestionList,
  type GenerateReply, type KeepReply, type OutfitGenStatus, type SuggestionList,
} from '../domain/outfitgen-app';
import { OUTFITGEN_NOTICE_REVISION, type OutfitGenLanguage, type OutfitGenMode } from '../domain/outfitgen';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export type OutfitGenStatusRead = { kind: 'missing' } | { kind: 'ready'; status: OutfitGenStatus };
export type OutfitGenConsentResult = { kind: 'applied'; status: OutfitGenStatus }
  | { kind: 'refused'; code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'UNCONFIGURED' | 'CONFIG_CHANGED' };
const refusals = ['UNAVAILABLE', 'INVALID_INPUT', 'UNCONFIGURED', 'CONFIG_CHANGED'] as const;

/** Suggested-outfit calls, sharing the photo-analysis client's session, identity and bounded-response checks. */
export class OutfitGenClient extends AiClient {
  /** `missing` is only PostgREST's "function not found" reply, meaning this backend has no outfit generation. */
  async outfitGenStatus(signal?: AbortSignal): Promise<OutfitGenStatusRead> {
    const reply = await this.request('/rest/v1/rpc/outfitgen_status', {}, 5000, {}, signal);
    if (reply.status === 404 && record(reply.value) && reply.value.code === 'PGRST202') return { kind: 'missing' };
    const status = reply.status === 200 ? parseOutfitGenStatus(reply.value) : null;
    if (!status) throw new AiError('UNAVAILABLE');
    return { kind: 'ready', status };
  }
  /** A thrown error means the outcome is unknown. */
  async outfitGenConsent(enabled: boolean, signal?: AbortSignal): Promise<OutfitGenConsentResult> {
    const reply = await this.request('/rest/v1/rpc/outfitgen_set_consent', {
      p_enabled: enabled, p_notice_revision: enabled ? OUTFITGEN_NOTICE_REVISION : null,
    }, 5000, {}, signal);
    if (reply.status === 200 && record(reply.value) && Object.keys(reply.value).length === 1) {
      const code = refusals.find((entry) => entry === (reply.value as Record<string, unknown>).code);
      if (code) return { kind: 'refused', code };
    }
    const status = reply.status === 200 ? parseOutfitGenStatus(reply.value) : null;
    if (!status || status.code === 'UNAVAILABLE') throw new AiError('UNAVAILABLE');
    return { kind: 'applied', status };
  }
  async list(signal?: AbortSignal): Promise<SuggestionList> {
    const reply = await this.request('/rest/v1/rpc/outfitgen_list', {}, 8000, {}, signal);
    const list = reply.status === 200 ? parseSuggestionList(reply.value) : null;
    if (!list) throw new AiError('UNAVAILABLE');
    return list;
  }
  async keep(id: string, outfitId: string, signal?: AbortSignal): Promise<KeepReply> {
    return this.decide('/rest/v1/rpc/outfitgen_keep', { p_id: id, p_outfit_id: outfitId }, 'keep', signal);
  }
  async remove(id: string, signal?: AbortSignal): Promise<KeepReply> {
    return this.decide('/rest/v1/rpc/outfitgen_remove', { p_id: id }, 'remove', signal);
  }
  async undoRemove(id: string, signal?: AbortSignal): Promise<KeepReply> {
    return this.decide('/rest/v1/rpc/outfitgen_undo_remove', { p_id: id }, 'undo', signal);
  }
  private async decide(path: '/rest/v1/rpc/outfitgen_keep' | '/rest/v1/rpc/outfitgen_remove' | '/rest/v1/rpc/outfitgen_undo_remove',
    body: object, kind: 'keep' | 'remove' | 'undo', signal?: AbortSignal): Promise<KeepReply> {
    const reply = await this.request(path, body, 10000, {}, signal);
    const decision = reply.status === 200 ? parseDecision(reply.value, kind) : null;
    if (!decision) throw new AiError('UNAVAILABLE');
    return decision;
  }
  /** One run. The server answers when its work is done (it bounds that to about 75 seconds); there is never a retry. `beforeSend` is the last check. */
  async generate(input: { requestId: string; mode: OutfitGenMode; language: OutfitGenLanguage }, signal?: AbortSignal,
    beforeSend?: BeforeSend): Promise<GenerateReply> {
    try {
      const reply = await this.request('/functions/v1/outfit-generate', input, GENERATE_TIMEOUT_MS, {}, signal, beforeSend);
      return parseGenerateReply(reply.status, reply.value);
    } catch (error) {
      // `beforeSend` runs after authentication, right before the POST; a refusal there means nothing was sent.
      if (error instanceof AiNotSentError) return { code: 'NOT_SENT' };
      if (error instanceof AiError && (error.code === 'TIMEOUT' || error.code === 'UNAUTHENTICATED')) return { code: error.code };
      return { code: 'FAILED' };
    }
  }
}
