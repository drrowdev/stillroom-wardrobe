import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '../../../i18n';
import '../../../i18n/tryon';
import { BODY_ASPECT, BodyPhotoError, admitBodySource, prepareBodyPhoto, type BodyPhoto, type BodySource } from '../../../images/body-photo';
import { largestAspectCrop, type PhotoEdit } from '../../../images/crop';

const photoMessage = (error: unknown): MessageKey | null => {
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return error instanceof BodyPhotoError && error.code === 'small' ? 'tryon.photoSmall' : 'tryon.photoUnusable';
};

type Options = {
  /** Where focus should go: the choose button after a refused file or a cancelled first crop, the crop button after a cancelled re-crop. */
  onFocus: (target: 'choose' | 'edit') => void;
  /** A photo was cropped and encoded. */
  onPrepared?: () => void;
  /** The chosen photo and its crop state were dropped. */
  onReset?: () => void;
};

/**
 * The one choose, crop and encode flow for a photo of the owner (VTO-2, PHOTO2): the file is admitted and decoded locally, cropped to
 * the body aspect and re-encoded as the 1024x1280 JPEG that is saved or tried on. Object URLs are revoked on replacement and unmount.
 */
export function useBodyPhotoPicker(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const preparation = useRef<AbortController | null>(null);
  const [source, setSource] = useState<BodySource | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [edit, setEdit] = useState<PhotoEdit | null>(null);
  const [editing, setEditing] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [photo, setPhoto] = useState<BodyPhoto | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  useEffect(() => () => preparation.current?.abort(), []);
  const clear = useCallback(() => {
    preparation.current?.abort();
    setSource(null); setSourceUrl(null); setEdit(null); setEditing(false); setPreparing(false); setPhoto(null); setPhotoUrl(null); setError(null);
    latest.current.onReset?.();
  }, []);
  async function choose(file: File | undefined) {
    if (!file) return;
    clear(); setError(null);
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    try {
      const admitted = await admitBodySource(file, controller.signal);
      if (controller.signal.aborted) return;
      setSource(admitted);
      setSourceUrl(URL.createObjectURL(admitted.blob));
      setEdit({ turns: 0, crop: largestAspectCrop(admitted.width, admitted.height, 0, BODY_ASPECT) });
      setEditing(true);
    } catch (failure) {
      const message = photoMessage(failure);
      if (message && !controller.signal.aborted) { setError(message); latest.current.onFocus('choose'); }
    } finally {
      if (preparation.current === controller) setPreparing(false);
    }
  }
  async function apply(next: PhotoEdit) {
    if (!source) return;
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true); setError(null);
    try {
      const prepared = await prepareBodyPhoto(source, next, controller.signal);
      if (controller.signal.aborted) return;
      setEdit(next); setPhoto(prepared); setEditing(false);
      setPhotoUrl(URL.createObjectURL(new Blob([prepared.bytes], { type: 'image/jpeg' })));
      latest.current.onPrepared?.();
    } catch (failure) {
      const message = photoMessage(failure);
      if (message && !controller.signal.aborted) setError(message);
    } finally {
      if (preparation.current === controller) setPreparing(false);
    }
  }
  function cancelEdit() {
    setEditing(false); setError(null);
    if (!photo) clear();
    latest.current.onFocus(photo ? 'edit' : 'choose');
  }
  return { source, sourceUrl, edit, editing, preparing, photo, photoUrl, error, choose, apply, cancelEdit, clear, startEditing: () => setEditing(true) };
}
