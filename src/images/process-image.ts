import { abortable, admitJpeg, prepareSource, type PreparedPhoto } from './process-jpeg';
import { ORIGINAL_EDIT, type PhotoEdit } from './crop';
import { validateImage } from './validate';

export async function prepareImage(file: Blob, signal?: AbortSignal, edit: PhotoEdit = ORIGINAL_EDIT): Promise<PreparedPhoto> {
  return prepareSource(file, async () => {
    const signature = new Uint8Array(await abortable(file.slice(0, 2).arrayBuffer(), signal));
    if (signature[0] === 0xff && signature[1] === 0xd8) return admitJpeg(file, signal);
    const admitted = await validateImage(file, signal);
    return { ...admitted, blob: new Blob([admitted.blob], { type: `image/${admitted.format}` }) };
  }, edit, signal, true);
}
