import { TRYON_LIMITS } from '../domain/tryon';
import { isPhotoInputJpeg } from './restore-jpeg';

/** The photo input profile a stored or prepared body photo must meet: exactly 1024x1280, baseline, no metadata. Never throws. */
export function isUsableBodyPhoto(bytes: Uint8Array): boolean {
  const { width, height, maxBytes } = { width: TRYON_LIMITS.personWidth, height: TRYON_LIMITS.personHeight, maxBytes: TRYON_LIMITS.personBytes };
  try { return bytes.length <= maxBytes && isPhotoInputJpeg(bytes, width, height, { bytes: maxBytes, side: height }); } catch { return false; }
}
