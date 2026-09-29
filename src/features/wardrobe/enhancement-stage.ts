// BG2b-2: the client enhancement stage, between the settled BG2a photo (H1) and its one analysis. Pure apart from the
// injected client and imaging: every await is followed by the token, epoch and abort checks, and any failure keeps H1.
// BG2c (plan rev4 §3-§5): it sends the clean-up input H0, never H1, and checks H2 against H0 and R with `cleanupCheck`.
// Nothing here authorises a request; the server's status and claim checks stay authoritative.
import type { EnhanceResponse, EnhanceSample, EnhanceStatusRead } from '../../data/enhancement';
import {
  emptyEnhanceMemory, forgetEnhanceOff, knownEnabled, lineWhenNotSent, observeEnhanceStatus, rememberEnhance,
  type EnhanceLine, type EnhanceMemory, type EnhanceObserved,
} from '../../domain/enhance-controls';
import { ENHANCE_LIMITS } from '../../domain/enhancement';
import { ambiguousReference } from '../../images/background/frame';
import type { CleanupMetrics, CleanupVerdict } from '../../images/fidelity';
import { FIDELITY } from '../../images/fidelity';
import type { AdmittedProviderJpeg } from '../../images/provider-jpeg';
import type { CleanupSource, PreparedPhoto } from '../../images/process-jpeg';

/** Evidence must still have this long left when a Save could start (P3). */
export const EXPIRY_MARGIN_MS = 60_000;
/** A status sample is used only when its round trip is at most this long. */
export const SAMPLE_RTT_MS = 5_000;
export const SAMPLE_MAX_AGE_MS = 600_000;
export const FAILURE_PAUSE_MS = 600_000;

/** A server-time anchor: the server's clock at the midpoint of an accepted sample, on the monotonic clock (A4). */
export type ClockAnchor = Readonly<{ serverTimeMs: number; mid: number; at: number }>;
export function anchorFrom(sample: EnhanceSample | null): ClockAnchor | null {
  if (!sample || !Number.isFinite(sample.t0) || !Number.isFinite(sample.t1) || sample.t1 < sample.t0
    || sample.t1 - sample.t0 > SAMPLE_RTT_MS) return null;
  return Object.freeze({ serverTimeMs: sample.serverTimeMs, mid: sample.t0 + (sample.t1 - sample.t0) / 2, at: sample.t1 });
}
/** Monotonic deadline for keeping H2 in an unreserved draft, or null when too little time is left. No wall clock. */
export function expiryDeadline(anchor: ClockAnchor, usableUntilMs: number, receivedAt: number): number | null {
  const remaining = usableUntilMs - (anchor.serverTimeMs + (receivedAt - anchor.mid));
  if (!Number.isFinite(remaining) || remaining - EXPIRY_MARGIN_MS <= 0) return null;
  return receivedAt + remaining - EXPIRY_MARGIN_MS;
}

/**
 * Per-owner-scope, in-memory only: the latest authoritative observation (A5), the clock anchor and the failure flag.
 * A new scope (logout, UID or epoch change) starts empty; nothing is persisted.
 */
export class EnhanceSession {
  memory: EnhanceMemory = emptyEnhanceMemory;
  anchor: ClockAnchor | null = null;
  private failures = 0;
  private pausedUntil: number | null = null;
  constructor(readonly now: () => number = () => performance.now()) {}
  /** Consent-change attempts so far; a read that began before one is not the latest observation. */
  writes = 0;
  observe(observed: EnhanceObserved, since = this.writes) {
    if (since !== this.writes) return;
    this.memory = rememberEnhance(observed, this.now());
  }
  forgetOff() { this.memory = forgetEnhanceOff(this.memory); }
  /** A5: any consent-change attempt, and any uncertain outcome of one, ends a remembered `off`. */
  consentChanging() { this.writes++; this.forgetOff(); }
  sample(sample: EnhanceSample | null) { const anchor = anchorFrom(sample); if (anchor) this.anchor = anchor; }
  currentAnchor(): ClockAnchor | null {
    const anchor = this.anchor, now = this.now();
    return anchor && now - anchor.at >= 0 && now - anchor.at < SAMPLE_MAX_AGE_MS ? anchor : null;
  }
  /** Two consecutive FAILED or TIMEOUT results stop dispatch for 10 minutes. */
  failed() { this.failures++; if (this.failures >= 2) { this.failures = 0; this.pausedUntil = this.now() + FAILURE_PAUSE_MS; } }
  succeeded() { this.failures = 0; }
  paused(): boolean {
    if (this.pausedUntil === null) return false;
    if (this.now() >= this.pausedUntil) { this.pausedUntil = null; return false; }
    return true;
  }
}

export type DecodedFrame = { width: number; height: number; close(): void };
export type StageImaging<F extends DecodedFrame = DecodedFrame> = {
  sha256(bytes: Uint8Array): Promise<string>;
  /** The existing sanitised-JPEG validator on the exact bytes. Throws when they don't pass. */
  validate(bytes: Uint8Array, width: number, height: number): void;
  decode(blob: Blob, signal: AbortSignal): Promise<F>;
  /** RGBA at FIDELITY.width x FIDELITY.height, high-quality smoothing. */
  downsample(frame: F): Uint8ClampedArray;
  thumbnail(main: Blob, width: number, height: number, signal: AbortSignal): Promise<{ blob: Blob; sha256: string }>;
};
export type StageClient = {
  status(signal?: AbortSignal): Promise<EnhanceStatusRead>;
  enhance(photo: Pick<CleanupSource, 'main'>, requestId: string, signal: AbortSignal): Promise<EnhanceResponse>;
};
export type StageInput = {
  /**
   * The clean-up input (H0 and R) of this preparation, or null when it wasn't built (unframed, H0 failed). H1 stays the
   * caller's fallback and is never sent.
   */
  source: CleanupSource | null;
  /**
   * The pre-upload review check (plan rev4 §3.1 step 2): stop with `available` where a request would be sent. Nothing is
   * sent, and no request ID is made.
   */
  preflight?: boolean;
  /** BG1 removed the background of this photo: "Use original background" and the BG1 fallback are never sent. */
  cutOut: boolean;
  online: boolean;
  /** The token, epoch and scope checks for this preparation. False means stop with no state change. */
  current: () => boolean;
  /** Aborted by discard, a newer preparation, a crop cancel, logout or UID change. */
  signal: AbortSignal;
  /** Aborted by "Skip". */
  skip: AbortSignal;
};
export type StageDeps = {
  client: StageClient; session: EnhanceSession; imaging: StageImaging;
  admit: (bytes: Uint8Array) => AdmittedProviderJpeg;
  compare: (h0: Uint8ClampedArray, reference: Uint8Array, h2: Uint8ClampedArray) => CleanupVerdict;
  newId?: () => string;
  /** Called once a request has been sent, so the UI can show "Cleaning up photo…" only for a real request. */
  onDispatch?: (requestId: string) => void;
};
export type StageResult =
  | { kind: 'enhanced'; photo: PreparedPhoto; requestId: string; expireAt: number; metrics: CleanupMetrics }
  | { kind: 'available' }
  | { kind: 'skipped'; line: EnhanceLine; requestId: string | null }
  | { kind: 'aborted' };

class Stop extends Error {
  constructor(readonly result: StageResult) { super('stop'); }
}
const sameBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
};

/**
 * Runs the stage once for a preparation. `aborted` means the caller commits nothing and starts no analysis; `skipped` and
 * `enhanced` are committed exactly once by the caller. One request ID per run, never reused. With `preflight`, the run
 * ends with `available` instead of sending, and the caller runs the stage again after the user accepts the crop.
 */
export async function runEnhancementStage(input: StageInput, deps: StageDeps): Promise<StageResult> {
  const { session } = deps;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ENHANCE_LIMITS.clientStageMs);
  const signal = AbortSignal.any([input.signal, input.skip, deadline.signal]);
  let requestId: string | null = null;
  const frames: DecodedFrame[] = [];
  const outcome = (line: EnhanceLine): StageResult => ({ kind: 'skipped', line, requestId });
  const check = () => {
    if (!input.current() || input.signal.aborted) throw new Stop({ kind: 'aborted' });
    if (input.skip.aborted) throw new Stop(outcome('none'));
    if (deadline.signal.aborted) throw new Stop(outcome('generic'));
  };
  const after = async <T>(work: Promise<T>): Promise<T> => {
    try { const value = await work; check(); return value; }
    catch (error) { check(); throw error; }
  };
  const reject = (): never => { throw new Stop(outcome('generic')); };
  try {
    check();
    if (!input.cutOut) return outcome('none');
    // A5: a known-enabled feature stopped by the failure flag or by being offline still says so.
    if (!input.online || session.paused()) return outcome(knownEnabled(session.memory) ? 'generic' : 'none');
    let observed: EnhanceObserved;
    const since = session.writes;
    try {
      const read = await after(deps.client.status(signal));
      if (read.kind === 'missing') { session.observe('off', since); return outcome('none'); }
      observed = observeEnhanceStatus(read.status, knownEnabled(session.memory));
      session.observe(observed, since);
      session.sample(read.sample);
    } catch (error) {
      if (error instanceof Stop) throw error;
      return outcome(lineWhenNotSent('unknown', session.memory, session.now()));
    }
    if (observed !== 'ready') return outcome(lineWhenNotSent(observed, session.memory, session.now()));
    // Without a usable server-time sample the evidence deadline can't be kept, so nothing is sent.
    const anchor = session.currentAnchor();
    if (!anchor) return outcome('generic');
    // Clean-up is offered only for one garment (§4.3) with a checked H0; both are known before anything is sent.
    if (input.source && ambiguousReference(input.source.reference)) return outcome('ambiguous');
    const source = input.source;
    if (!source) return outcome('generic');
    if (input.preflight) return { kind: 'available' };

    requestId = (deps.newId ?? (() => crypto.randomUUID()))();
    deps.onDispatch?.(requestId);
    let response: EnhanceResponse;
    try { response = await after(deps.client.enhance(source, requestId, signal)); }
    catch (error) {
      if (error instanceof Stop) { if (error.result.kind === 'skipped' && error.result.line === 'generic') session.failed(); throw error; }
      session.failed();
      return outcome('generic');
    }
    const receivedAt = session.now();
    if (response.kind === 'code') {
      if (response.code === 'FAILED' || response.code === 'TIMEOUT') session.failed();
      return outcome(response.code === 'ALLOWANCE' ? 'allowance' : 'generic');
    }
    session.succeeded();
    const expireAt = expiryDeadline(anchor, response.usableUntilMs, receivedAt);
    if (expireAt === null) return outcome('generic');
    const body = response.body;
    // Admission order (§2.5): header hash and length, the shared provider profile on the exact bytes, then decode.
    if (body.byteLength !== response.length || body.byteLength > ENHANCE_LIMITS.outputBytes) reject();
    if (await after(deps.imaging.sha256(body)) !== response.sha256) reject();
    let admitted: AdmittedProviderJpeg;
    try { admitted = deps.admit(body); } catch { return reject(); }
    if (admitted.stripped || admitted.width !== ENHANCE_LIMITS.outputWidth || admitted.height !== ENHANCE_LIMITS.outputHeight
      || !sameBytes(admitted.bytes, body)) reject();
    try { deps.imaging.validate(body, ENHANCE_LIMITS.outputWidth, ENHANCE_LIMITS.outputHeight); } catch { reject(); }
    const main = new Blob([body], { type: 'image/jpeg' });
    // The two decodes run one after the other, each closed as soon as it has been downsampled (§2.8).
    let after2: Uint8ClampedArray, before: Uint8ClampedArray;
    {
      const frame = await after(deps.imaging.decode(main, signal).then((value) => { frames.push(value); return value; }));
      if (frame.width !== ENHANCE_LIMITS.outputWidth || frame.height !== ENHANCE_LIMITS.outputHeight) reject();
      after2 = deps.imaging.downsample(frame);
      frame.close(); frames.splice(frames.indexOf(frame), 1);
    }
    {
      const frame = await after(deps.imaging.decode(source.main, signal).then((value) => { frames.push(value); return value; }));
      before = deps.imaging.downsample(frame);
      frame.close(); frames.splice(frames.indexOf(frame), 1);
    }
    if (after2.length !== FIDELITY.width * FIDELITY.height * 4 || before.length !== after2.length
      || source.reference.length !== FIDELITY.width * FIDELITY.height) reject();
    const verdict = deps.compare(before, source.reference, after2);
    check();
    if (!verdict.accepted) return outcome('generic');
    const thumb = await after(deps.imaging.thumbnail(main, ENHANCE_LIMITS.outputWidth, ENHANCE_LIMITS.outputHeight, signal));
    if (session.now() >= expireAt) return outcome('generic');
    return { kind: 'enhanced', requestId, expireAt, metrics: verdict.metrics, photo: Object.freeze({
      main, thumb: thumb.blob, width: ENHANCE_LIMITS.outputWidth, height: ENHANCE_LIMITS.outputHeight,
      mainSha256: response.sha256, thumbSha256: thumb.sha256 }) };
  } catch (error) {
    if (error instanceof Stop) return error.result;
    return input.current() && !input.signal.aborted ? outcome('generic') : { kind: 'aborted' };
  } finally {
    clearTimeout(timer);
    for (const frame of frames) frame.close();
    frames.length = 0;
  }
}
