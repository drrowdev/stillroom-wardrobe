import { useEffect, useRef, useState } from 'react';
import { locales, type Language, type MessageKey } from '../../i18n';
import type { PhotoEdit } from '../../images/photo-edit';
import type { CropSource, PreparedPhoto } from '../../images/process-jpeg';
import { modelAssetBytes } from '../../images/background/model-assets';
import { removalEnabled } from '../../images/background/test-hook';
import type * as Imaging from '../../images/imaging';

// Automatic on-device background removal for a new photo (ADR24). Removal runs before the photo is committed to
// analysis, so the first settled photo is analysed once. "Use original background" during removal settles with
// the original photo instead; afterwards it is a new photo generation and is analysed again.
// 'working' is an active removal and 'keeping' the original photo being prepared after it was stopped. The last
// settled state is kept apart, so a cancelled or superseded preparation returns to it instead of staying 'working'.
export type BackgroundState = 'none' | 'working' | 'keeping' | 'removed' | 'original' | 'failed';
type Settled = { state: BackgroundState; choice: 'remove' | 'keep' };
type ImagingModule = typeof Imaging;
export type PreparedWithBackground = { photo: PreparedPhoto; crop: CropSource; state: BackgroundState };

export function useBackground(scope: { signal: AbortSignal }) {
  const choice = useRef<'remove' | 'keep'>('remove');
  const removal = useRef<AbortController | null>(null);
  const segmenter = useRef<{ scope: object; value: ReturnType<ImagingModule['backgroundSegmenter']> } | null>(null);
  const settled = useRef<Settled>({ state: 'none', choice: 'remove' });
  const calls = useRef(0);
  const active = useRef(false);
  const [state, setState] = useState<BackgroundState>('none');
  const [downloading, setDownloading] = useState(false);
  useEffect(() => () => removal.current?.abort(), []);
  useEffect(() => {
    const clear = () => { removal.current?.abort(); segmenter.current = null; };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => scope.signal.removeEventListener('abort', clear);
  }, [scope]);

  async function prepare(imaging: ImagingModule, file: Blob, edit: PhotoEdit, signal: AbortSignal, wantCrop: boolean,
    isCurrent: () => boolean): Promise<PreparedWithBackground> {
    removal.current?.abort();
    removal.current = null;
    const call = ++calls.current;
    active.current = true;
    try {
      return await run(imaging, file, edit, signal, wantCrop, isCurrent);
    } finally {
      if (calls.current === call) {
        active.current = false;
        // Cancelled or superseded: the shown photo is still the last settled one.
        if (signal.aborted) { choice.current = settled.current.choice; setState(settled.current.state); }
      }
    }
  }
  async function run(imaging: ImagingModule, file: Blob, edit: PhotoEdit, signal: AbortSignal, wantCrop: boolean,
    isCurrent: () => boolean): Promise<PreparedWithBackground> {
    let outcome: BackgroundState = removalEnabled() ? 'original' : 'none';
    if (choice.current === 'remove' && removalEnabled()) {
      const controller = new AbortController();
      removal.current = controller;
      if (segmenter.current?.scope !== scope) segmenter.current = { scope, value: imaging.backgroundSegmenter(scope) };
      const inner = AbortSignal.any([signal, controller.signal]);
      const unsubscribe = imaging.subscribeAssets(() => {
        if (isCurrent()) setDownloading(imaging.assetStatus(scope) === 'downloading');
      });
      setDownloading(imaging.assetStatus(scope) === 'downloading');
      setState('working');
      try {
        const result = await imaging.prepareCutout(file, inner, edit, segmenter.current.value, wantCrop);
        testLog(imaging, { outcome: 'removed', coverage: result.coverage, framed: result.framed ? 1 : 0, width: result.photo.width, height: result.photo.height });
        return { photo: result.photo, crop: result.crop ?? result.photo, state: 'removed' };
      } catch (error) {
        if (signal.aborted || !(controller.signal.aborted || error instanceof imaging.BackgroundRemovalError)) throw error;
        outcome = controller.signal.aborted ? 'original' : 'failed';
        testLog(imaging, { outcome, reason: error instanceof imaging.BackgroundRemovalError ? error.code : 'cancelled' });
      } finally {
        unsubscribe();
        if (removal.current === controller) removal.current = null;
        if (isCurrent()) setDownloading(false);
      }
    }
    const photo = await imaging.prepareImage(file, signal, edit);
    return { photo, crop: photo, state: outcome };
  }
  return {
    state, downloading, prepare,
    /** A newly chosen photo starts with automatic removal again. */
    reset() {
      choice.current = 'remove'; settled.current = { state: 'none', choice: 'remove' };
      removal.current?.abort(); setState('none');
    },
    settle(next: BackgroundState) {
      if (next === 'removed') choice.current = 'remove';
      if (next === 'original') choice.current = 'keep';
      settled.current = { state: next, choice: choice.current };
      setState(next);
    },
    /**
     * During removal: stop it and use the original. After a settled removal: prepare the photo again without it,
     * as a new analysis. Otherwise nothing: a repeated press while the original is being prepared is ignored.
     */
    useOriginal(): 'cancelled' | 'again' | 'ignored' {
      if (removal.current) {
        choice.current = 'keep';
        removal.current.abort();
        removal.current = null;
        setState('keeping');
        return 'cancelled';
      }
      if (active.current) { choice.current = 'keep'; return 'ignored'; }
      if (settled.current.state !== 'removed') return 'ignored';
      choice.current = 'keep';
      return 'again';
    },
  };
}

function testLog(imaging: ImagingModule, entry: Record<string, number | string>) {
  imaging.backgroundTestLog(entry);
}

export function backgroundSize(language: Language): string {
  return new Intl.NumberFormat(locales[language], { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 })
    .format(Math.round(modelAssetBytes / 1_000_000));
}

/** While removal runs, the photo's own "preparing" line says what is happening instead. */
export function preparingMessage(state: BackgroundState, downloading: boolean, fallback: MessageKey): MessageKey {
  return state === 'working' ? downloading ? 'photo.bgDownloading' : 'photo.bgRemoving' : fallback;
}
