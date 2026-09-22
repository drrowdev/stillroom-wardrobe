import { FunctionsHttpError } from '@supabase/supabase-js';
import type { OwnerScope } from '../auth/session';
import type { AppClient } from '../data/client';
import { AnalyzedSaveRefusedError, AppError, throwIfAborted } from '../data/errors';
import { matchImageChangeReceipt, parseImageChangeReceipt, parseRecoveryVersions,
  type ImageChangeAttempt, type ImageChangeReceipt, type RecoveryVersion } from '../domain/image-replacement';
import { isRecord, isUuid } from '../domain/wardrobe';
import { assertSanitizedJpeg, readJpegHeader } from './jpeg';
import { abortable, type PreparedPhoto } from './process-jpeg';
import { ensureFile, type SaveStage } from './upload';

function checked(error: unknown): void {
  if (error === null) return;
  if (isRecord(error) && error.code === '22023' && error.details === null && error.hint === null) {
    if (error.message === 'Request conflict') throw new AppError('error.conflict');
    if (error.message === 'Upload incomplete') throw new AppError('error.uploadIncomplete');
  }
  throw new AppError('error.unavailable');
}
export class ImageChangeClient {
  private readonly owner: string;
  private readonly epoch: number;
  constructor(private client: AppClient, readonly scope: OwnerScope) {
    this.owner = scope.ownerId; this.epoch = scope.epoch;
  }
  private async bounded<T>(outer: AbortSignal | undefined, action: (scope: OwnerScope) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.scope.signal, controller.signal, ...(outer ? [outer] : [])]);
    const timer = setTimeout(() => controller.abort(), 30000);
    const scope = { ...this.scope, signal };
    try {
      throwIfAborted(signal);
      if (scope.ownerId !== this.owner || scope.epoch !== this.epoch) throw new AppError('error.conflict');
      return await abortable(action(scope), signal);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  private bind(itemId: string, requestId?: string): void {
    if (!isUuid(itemId) || requestId !== undefined && !isUuid(requestId)) throw new AppError('error.conflict');
  }
  private async statusIn(scope: OwnerScope, itemId: string, requestId: string): Promise<ImageChangeReceipt | null> {
    this.bind(itemId, requestId);
    const result = await this.client.rpc('image_change_status', { p_item_id: itemId, p_request_id: requestId }).abortSignal(scope.signal);
    throwIfAborted(scope.signal); checked(result.error);
    return result.data === null ? null : parseImageChangeReceipt(result.data, itemId, requestId);
  }
  status(itemId: string, requestId: string, signal?: AbortSignal) {
    return this.bounded(signal, scope => this.statusIn(scope, itemId, requestId));
  }
  requests(itemId: string, signal?: AbortSignal): Promise<ImageChangeReceipt[]> {
    return this.bounded(signal, async scope => {
      this.bind(itemId);
      const result = await this.client.rpc('image_change_requests', { p_item_id: itemId }).abortSignal(scope.signal);
      throwIfAborted(scope.signal); checked(result.error);
      if (!Array.isArray(result.data)) throw new AppError('error.conflict');
      let last = '';
      return result.data.map(value => {
        const row = parseImageChangeReceipt(value, itemId);
        if (row.state !== 'reserved' || row.requestId <= last) throw new AppError('error.conflict');
        last = row.requestId;
        return row;
      });
    });
  }
  versions(itemId: string, after?: string, signal?: AbortSignal) {
    return this.bounded(signal, async scope => {
      this.bind(itemId, after);
      const result = await this.client.rpc('image_recovery_versions', {
        p_item_id: itemId, ...(after ? { p_after: after } : {}),
      }).abortSignal(scope.signal);
      throwIfAborted(scope.signal); checked(result.error);
      return parseRecoveryVersions(result.data, scope.ownerId, itemId, after);
    });
  }
  recoverPhoto(source: RecoveryVersion, signal?: AbortSignal): Promise<PreparedPhoto> {
    return this.bounded(signal, async scope => {
      if (source.ownerId !== scope.ownerId || !source.eligible) throw new AppError('error.conflict');
      const read = async (path: string, size: number, hash: string, main: boolean): Promise<Blob> => {
        const result = await this.client.storage.from('wardrobe').download(path, {}, { signal: scope.signal, cache: 'no-store' });
        throwIfAborted(scope.signal); checked(result.error);
        if (!result.data || result.data.size !== size) throw new AppError('error.conflict');
        const bytes = new Uint8Array(await result.data.arrayBuffer());
        throwIfAborted(scope.signal);
        const dimensions = readJpegHeader(bytes);
        assertSanitizedJpeg(bytes, dimensions.width, dimensions.height);
        if (main ? dimensions.width !== source.width || dimensions.height !== source.height
          : dimensions.width > 320 || dimensions.height > 320) throw new AppError('error.conflict');
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        throwIfAborted(scope.signal);
        if ([...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') !== hash) throw new AppError('error.conflict');
        return result.data;
      };
      const thumb = await read(source.thumbPath, source.thumbBytes, source.thumbSha256, false);
      const main = await read(source.mainPath, source.mainBytes, source.mainSha256, true);
      return { main, thumb, width: source.width, height: source.height, mainSha256: source.mainSha256, thumbSha256: source.thumbSha256 };
    });
  }
  cancel(receipt: ImageChangeReceipt, signal?: AbortSignal): Promise<ImageChangeReceipt> {
    return this.bounded(signal, async scope => {
      const current = await this.statusIn(scope, receipt.itemId, receipt.requestId);
      if (!current || current.imageId !== receipt.imageId || current.kind !== receipt.kind || current.fingerprint !== receipt.fingerprint) {
        throw new AppError('error.conflict');
      }
      if (current.state !== 'reserved') return current;
      const result = await this.client.rpc('cancel_image_change', {
        p_item_id: receipt.itemId, p_request_id: receipt.requestId,
      }).abortSignal(scope.signal);
      throwIfAborted(scope.signal); checked(result.error);
      const cancelled = parseImageChangeReceipt(result.data, receipt.itemId, receipt.requestId);
      if (cancelled.imageId !== current.imageId || cancelled.fingerprint !== current.fingerprint || cancelled.kind !== current.kind
        || cancelled.state === 'reserved') throw new AppError('error.conflict');
      return cancelled;
    });
  }
  private async finalize(scope: OwnerScope, attempt: ImageChangeAttempt, action: 'complete' | 'accept-recovery'): Promise<unknown> {
    const result = await this.client.functions.invoke('finalize-image-change', {
      body: { action, intent: attempt.intent }, signal: scope.signal,
    });
    throwIfAborted(scope.signal);
    if (!result.error) return result.data;
    const error: unknown = result.error;
    if (error instanceof FunctionsHttpError && error.context instanceof Response && error.context.status === 409
      && error.context.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
      && error.context.body) {
      const reader = error.context.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let text = '', bytes = 0;
      try {
        for (;;) {
          const chunk = await abortable(reader.read(), scope.signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024) throw new AppError('error.unavailable');
          text += decoder.decode(chunk.value, { stream: true });
        }
        const value: unknown = JSON.parse(text + decoder.decode());
        if (isRecord(value) && Object.keys(value).length === 1) {
          if (value.code === 'CONFLICT') throw new AppError('error.conflict');
          if (value.code === 'UPLOAD_INCOMPLETE') throw new AppError('error.uploadIncomplete');
        }
      } finally {
        try { await abortable(reader.cancel(), scope.signal); } finally { reader.releaseLock(); }
      }
    }
    throw new AppError('error.unavailable');
  }
  save(attempt: ImageChangeAttempt, onStage: (stage: SaveStage) => void,
    onReceipt: (receipt: ImageChangeReceipt) => void, signal?: AbortSignal): Promise<ImageChangeReceipt> {
    return this.bounded(signal, async scope => {
      if (attempt.ownerId !== scope.ownerId || attempt.epoch !== scope.epoch) throw new AppError('error.conflict');
      const { intent, photo } = attempt;
      const known = await this.statusIn(scope, intent.itemId, intent.requestId);
      let receipt = known ? matchImageChangeReceipt(known, attempt) : null;
      if (receipt?.state === 'cancelled') throw new AppError('error.conflict');
      if (!receipt) {
        onStage('capture.reserving');
        throwIfAborted(scope.signal);
        let value: unknown;
        if (intent.sourceImageId) value = await this.finalize(scope, attempt, 'accept-recovery');
        else {
          const result = await this.client.rpc('reserve_image_change', { p_intent: intent }).abortSignal(scope.signal);
          throwIfAborted(scope.signal); checked(result.error); value = result.data;
        }
        if (intent.claim !== null && isRecord(value) && Object.keys(value).length === 4 && value.state === 'analysis_unavailable'
          && value.requestId === intent.requestId && value.itemId === intent.itemId && value.imageId === intent.imageId) {
          throw new AnalyzedSaveRefusedError(intent.itemId, intent.imageId);
        }
        receipt = matchImageChangeReceipt(value, attempt);
        if (receipt.state === 'cancelled') throw new AppError('error.conflict');
      }
      onReceipt(receipt);
      throwIfAborted(scope.signal);
      onStage('capture.uploading');
      const prefix = `${scope.ownerId}/${intent.itemId}/${intent.imageId}`;
      await ensureFile(this.client, `${prefix}/thumb.jpg`, photo.thumb, photo.thumbSha256, scope, receipt.state);
      await ensureFile(this.client, `${prefix}/main.jpg`, photo.main, photo.mainSha256, scope, receipt.state);
      throwIfAborted(scope.signal);
      if (receipt.state === 'completed') return receipt;
      onStage('capture.finishing');
      const finished = await this.finalize(scope, attempt, 'complete');
      if (finished !== null && finished !== undefined && finished !== '') throw new AppError('error.conflict');
      const actual = await this.statusIn(scope, intent.itemId, intent.requestId);
      const completed = matchImageChangeReceipt(actual, attempt, receipt);
      if (completed.state !== 'completed') throw new AppError('error.conflict');
      onReceipt(completed);
      return completed;
    });
  }
}
