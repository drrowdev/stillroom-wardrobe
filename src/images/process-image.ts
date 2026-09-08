import { ImagePreparationError, JPEG_LIMITS, readJpegHeader } from './jpeg';
import { prepareJpeg, prepareSource, type PreparedPhoto } from './process-jpeg';
import { ORIGINAL_EDIT, type PhotoEdit } from './crop';
import { validateImage } from './validate';

export async function prepareImage(file: Blob, signal?: AbortSignal, edit: PhotoEdit = ORIGINAL_EDIT): Promise<PreparedPhoto> {
  signal?.throwIfAborted();
  if (file.size > JPEG_LIMITS.sourceBytes) throw new ImagePreparationError('tooLarge', 'source');
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  signal?.throwIfAborted();
  if (signature[0] === 0xff && signature[1] === 0xd8) {
    if (edit === ORIGINAL_EDIT) return prepareJpeg(file, signal);
    return prepareSource(file, async () => {
      const header = readJpegHeader(new Uint8Array(await file.slice(0, JPEG_LIMITS.headerBytes).arrayBuffer()));
      const trailer = new Uint8Array(await file.slice(-2).arrayBuffer());
      signal?.throwIfAborted();
      if (trailer[0] !== 0xff || trailer[1] !== 0xd9) throw new ImagePreparationError('invalid');
      return {
        blob: new Blob([file], { type: 'image/jpeg' }), orientation: 1,
        width: header.orientation >= 5 ? header.height : header.width,
        height: header.orientation >= 5 ? header.width : header.height,
      };
    }, edit, signal);
  }
  return prepareSource(file, async () => {
    const admitted = await validateImage(file, signal);
    return { ...admitted, blob: new Blob([admitted.blob], { type: `image/${admitted.format}` }) };
  }, edit, signal);
}
