import { abortable, admitJpeg, prepareSegmentedSource, prepareSource, type AdmittedSource, type PreparedPhoto, type SegmentedPhoto } from './process-jpeg';
import { ORIGINAL_EDIT, type PhotoEdit } from './crop';
import { validateImage } from './validate';
import type { Segmenter } from './background/remover';

function admitter(file: Blob, signal?: AbortSignal): () => Promise<AdmittedSource> {
  return async () => {
    const signature = new Uint8Array(await abortable(file.slice(0, 2).arrayBuffer(), signal));
    if (signature[0] === 0xff && signature[1] === 0xd8) return admitJpeg(file, signal);
    const admitted = await validateImage(file, signal);
    return { ...admitted, blob: new Blob([admitted.blob], { type: `image/${admitted.format}` }) };
  };
}

export async function prepareImage(file: Blob, signal?: AbortSignal, edit: PhotoEdit = ORIGINAL_EDIT): Promise<PreparedPhoto> {
  return prepareSource(file, admitter(file, signal), edit, signal, true);
}

/**
 * The same admission and output checks as `prepareImage`, with the background removed on the device. `wantCleanup`
 * also builds the BG2c clean-up input (H0 and R) when the photo is framed; it is off unless clean-up is available.
 */
export async function prepareCutout(file: Blob, signal: AbortSignal | undefined, edit: PhotoEdit, segmenter: Segmenter,
  wantCrop: boolean, wantCleanup = false): Promise<SegmentedPhoto> {
  return prepareSegmentedSource(file, admitter(file, signal), edit, signal, segmenter, wantCrop, wantCleanup);
}
