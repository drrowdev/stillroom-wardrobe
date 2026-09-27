import { AiClient, AiError } from './ai';
import { parseStylistAnswer, parseStylistStatus, type StylistAnswer, type StylistStatus } from '../domain/stylist-controls';
import { STYLIST_NOTICE_REVISION, type StylistInput } from '../domain/stylist';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export type StylistStatusRead = { kind: 'missing' } | { kind: 'ready'; status: StylistStatus };
export type StylistConsentResult = { kind: 'applied'; status: StylistStatus }
  | { kind: 'refused'; code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'UNCONFIGURED' | 'CONFIG_CHANGED' };
const refusals = ['UNAVAILABLE', 'INVALID_INPUT', 'UNCONFIGURED', 'CONFIG_CHANGED'] as const;

/** Stylist calls, sharing the photo-analysis client's session, identity and bounded-response checks. */
export class StylistClient extends AiClient {
  /**
   * The owner's stylist status. `missing` is only PostgREST's "function not found" reply, meaning this backend has no
   * stylist; every other failure throws, so the caller keeps it apart from a known state.
   */
  async stylistStatus(signal?: AbortSignal): Promise<StylistStatusRead> {
    const reply = await this.request('/rest/v1/rpc/stylist_status', {}, 5000, {}, signal);
    if (reply.status === 404 && record(reply.value) && reply.value.code === 'PGRST202') return { kind: 'missing' };
    const status = reply.status === 200 ? parseStylistStatus(reply.value) : null;
    if (!status) throw new AiError('UNAVAILABLE');
    return { kind: 'ready', status };
  }
  /** Turns stylist use on for the current notice, or off. A thrown error means the outcome is unknown. */
  async stylistConsent(enabled: boolean, signal?: AbortSignal): Promise<StylistConsentResult> {
    const reply = await this.request('/rest/v1/rpc/stylist_set_consent', {
      p_enabled: enabled, p_notice_revision: enabled ? STYLIST_NOTICE_REVISION : null,
    }, 5000, {}, signal);
    if (reply.status === 200 && record(reply.value) && Object.keys(reply.value).length === 1) {
      const code = refusals.find((entry) => entry === (reply.value as Record<string, unknown>).code);
      if (code) return { kind: 'refused', code };
    }
    const status = reply.status === 200 ? parseStylistStatus(reply.value) : null;
    if (!status || status.code === 'UNAVAILABLE') throw new AiError('UNAVAILABLE');
    return { kind: 'applied', status };
  }
  /** One message. The server bounds its own work to 45 seconds; this waits slightly longer before giving up. */
  async chat(input: StylistInput, signal?: AbortSignal): Promise<StylistAnswer> {
    try {
      const reply = await this.request('/functions/v1/stylist-chat', input, 50000, {}, signal);
      return parseStylistAnswer(reply.status, reply.value);
    } catch (error) {
      if (error instanceof AiError && (error.code === 'TIMEOUT' || error.code === 'UNAUTHENTICATED')) return { code: error.code };
      return { code: 'FAILED' };
    }
  }
}
