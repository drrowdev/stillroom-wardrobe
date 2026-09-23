import { assertSanitizedJpeg, fitDimensions, JPEG_LIMITS } from '../../../src/images/jpeg.ts';
import { exact, ProtocolError, readBounded, sha256, UUID } from '../analyze-clothing/protocol.ts';

const imageKeys = ['id', 'owner_id', 'item_id', 'state', 'retired_at', 'main_path', 'thumb_path',
  'main_bytes', 'thumb_bytes', 'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text', 'created_at', 'description_version'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum;

export function storedObjectIdentities(value: unknown): boolean {
  const identity = (entry: unknown) => exact(entry, ['id', 'version']) && typeof entry.id === 'string' && UUID.test(entry.id)
    && typeof entry.version === 'string' && entry.version.length > 0 && entry.version.length <= 1024;
  return exact(value, ['main', 'thumb']) && identity(value.main) && identity(value.thumb);
}

export async function verifyStoredImage(value: unknown, expected: {
  ownerId: string; itemId: string; imageId: string; state: 'pending' | 'ready' | 'retired';
  descriptionVersion?: number;
}, transport: { supabaseUrl: string; publicKey: string; bearer: string; signal: AbortSignal }): Promise<void> {
  const prefix = `${expected.ownerId}/${expected.itemId}/${expected.imageId}`;
  if (![expected.ownerId, expected.itemId, expected.imageId].every((id) => UUID.test(id))
    || !exact(value, imageKeys) || value.owner_id !== expected.ownerId || value.item_id !== expected.itemId
    || value.id !== expected.imageId || value.main_path !== `${prefix}/main.jpg` || value.thumb_path !== `${prefix}/thumb.jpg`
    || value.state !== expected.state
    || (expected.state === 'retired' ? typeof value.retired_at !== 'string' || !Number.isFinite(Date.parse(value.retired_at)) : value.retired_at !== null)
    || (expected.descriptionVersion !== undefined && value.description_version !== expected.descriptionVersion)
    || !integer(value.width, JPEG_LIMITS.mainSide) || !integer(value.height, JPEG_LIMITS.mainSide)
    || !integer(value.main_bytes, JPEG_LIMITS.mainBytes) || !integer(value.thumb_bytes, JPEG_LIMITS.thumbBytes)
    || !hash(value.main_sha256) || !hash(value.thumb_sha256)) throw new ProtocolError('CONFLICT');
  const { signal } = transport;
  for (const variant of ['main', 'thumb'] as const) {
    signal.throwIfAborted();
    const response = await fetch(`${transport.supabaseUrl}/storage/v1/object/authenticated/wardrobe/${prefix}/${variant}.jpg`, {
      headers: { Authorization: transport.bearer, apikey: transport.publicKey }, redirect: 'error', cache: 'no-store', signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProtocolError(response.status === 404 ? 'UPLOAD_INCOMPLETE' : 'SAVE_FAILED');
    }
    if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/jpeg') {
      await response.body?.cancel();
      throw new ProtocolError('CONFLICT');
    }
    const body = await readBounded(response.body, variant === 'main' ? JPEG_LIMITS.mainBytes : JPEG_LIMITS.thumbBytes, signal);
    if (body.length !== value[`${variant}_bytes`] || await sha256(body) !== value[`${variant}_sha256`]) throw new ProtocolError('CONFLICT');
    const dimensions = variant === 'main' ? { width: value.width, height: value.height }
      : fitDimensions(value.width, value.height, JPEG_LIMITS.thumbSide);
    try { assertSanitizedJpeg(body, dimensions.width, dimensions.height); } catch { throw new ProtocolError('CONFLICT'); }
  }
}
