// Restore (Q6, ADR22): the photo a restore stores for one backup photo. Bytes in the app's own encoder profile are kept
// unchanged; a photo that decodes but falls outside it is encoded again at exactly the backup's dimensions. The thumbnail is
// always made again from the final main photo. Every result is checked before it can be written.
import { assertSanitizedJpeg, fitDimensions, ImagePreparationError, JPEG_LIMITS } from './jpeg';
import { inspectRestoreJpeg } from './restore-jpeg';
import { decodedSize, thumbnailFromMain, type PreparedPhoto } from './process-jpeg';
import { prepareImage } from './process-image';
import { ORIGINAL_EDIT } from './crop';

export type PhotoPlan = {
  sourceImageId: string;
  main: 'preserved' | 'reencoded';
  reason: 'metadata' | 'encoding' | null;
  sourceSha256: string;
  mainSha256: string;
  thumbSha256: string;
  width: number;
  height: number;
};

export type RestorePhotoDeps = {
  decodedSize: (blob: Blob, signal?: AbortSignal) => Promise<{ width: number; height: number }>;
  reencode: (blob: Blob, signal?: AbortSignal) => Promise<PreparedPhoto>;
  thumbnail: (main: Blob, width: number, height: number, signal?: AbortSignal) => Promise<{ blob: Blob; sha256: string; width: number; height: number }>;
};

export const restorePhotoDeps: RestorePhotoDeps = {
  decodedSize,
  reencode: (blob, signal) => prepareImage(blob, signal, ORIGINAL_EDIT),
  thumbnail: thumbnailFromMain,
};

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
}

const invalid = (): never => { throw new ImagePreparationError('invalid'); };

/**
 * Throws ImagePreparationError for a photo that must not be restored: `unavailable` when this browser cannot process it
 * now, anything else when the photo itself is refused. The structure is checked before any decoder starts.
 */
export async function planRestorePhoto(sourceImageId: string, bytes: Uint8Array<ArrayBuffer>, width: number, height: number,
  signal?: AbortSignal, deps: RestorePhotoDeps = restorePhotoDeps): Promise<{ plan: PhotoPlan; photo: PreparedPhoto }> {
  const verdict = inspectRestoreJpeg(bytes, width, height);
  const source = new Blob([bytes], { type: 'image/jpeg' });
  // An orientation that turns a non-square photo, or anything else that changes the decoded size, is refused.
  const decoded = await deps.decodedSize(source, signal);
  if (decoded.width !== width || decoded.height !== height) invalid();
  const sourceSha256 = await sha256(bytes);
  let main: Blob, mainSha256: string;
  if (verdict.kind === 'preserve') {
    assertSanitizedJpeg(bytes, width, height);
    main = source;
    mainSha256 = sourceSha256;
  } else {
    const prepared = await deps.reencode(source, signal);
    // The stored photo keeps the backup's dimensions; one that cannot fit the size limit at them is refused.
    if (prepared.width !== width || prepared.height !== height) invalid();
    const output = new Uint8Array(await prepared.main.arrayBuffer());
    if (inspectRestoreJpeg(output, width, height).kind !== 'preserve') invalid();
    assertSanitizedJpeg(output, width, height);
    if (await sha256(output) !== prepared.mainSha256) invalid();
    main = prepared.main;
    mainSha256 = prepared.mainSha256;
  }
  const thumb = await deps.thumbnail(main, width, height, signal);
  const expected = fitDimensions(width, height, JPEG_LIMITS.thumbSide);
  if (thumb.width !== expected.width || thumb.height !== expected.height) invalid();
  const thumbBytes = new Uint8Array(await thumb.blob.arrayBuffer());
  if (inspectRestoreJpeg(thumbBytes, thumb.width, thumb.height, { bytes: JPEG_LIMITS.thumbBytes, side: JPEG_LIMITS.thumbSide }).kind !== 'preserve') invalid();
  assertSanitizedJpeg(thumbBytes, thumb.width, thumb.height);
  if (await sha256(thumbBytes) !== thumb.sha256) invalid();
  return {
    plan: { sourceImageId, main: verdict.kind === 'preserve' ? 'preserved' : 'reencoded',
      reason: verdict.kind === 'reencode' ? verdict.reason : null, sourceSha256, mainSha256, thumbSha256: thumb.sha256, width, height },
    photo: { main, thumb: thumb.blob, width, height, mainSha256, thumbSha256: thumb.sha256 },
  };
}
