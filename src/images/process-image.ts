import { ImagePreparationError, JPEG_LIMITS } from './jpeg';
import { admitJpeg, prepareSource, type PreparedPhoto } from './process-jpeg';
import { ORIGINAL_EDIT, type PhotoEdit } from './crop';
import { validateImage } from './validate';

export async function prepareImage(file: Blob, signal?: AbortSignal, edit: PhotoEdit = ORIGINAL_EDIT): Promise<PreparedPhoto> {
  signal?.throwIfAborted();
  if (file.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge', 'source');
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  signal?.throwIfAborted();
  if (signature[0] === 0xff && signature[1] === 0xd8) {
    return prepareSource(file, () => admitJpeg(file, signal), edit, signal, true);
  }
  return prepareSource(file, async () => {
    const admitted = await validateImage(file, signal);
    return { ...admitted, blob: new Blob([admitted.blob], { type: `image/${admitted.format}` }) };
  }, edit, signal, true);
}
