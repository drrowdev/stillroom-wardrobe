import type { Language, Translate } from '../../i18n';
import { removalEnabled } from '../../images/background/test-hook';
import { backgroundSize, type BackgroundState } from './use-background';

/** Shown before a photo is chosen: where the work happens and the one-time download. Not an opt-in. */
export function BackgroundNote({ t, language }: { t: Translate; language: Language }) {
  if (!removalEnabled()) return null;
  return <p className="fine muted background-note">{t('photo.bgLocal', { size: backgroundSize(language) })}</p>;
}

type StatusProps = {
  state: BackgroundState; analysed: boolean; disabled: boolean; t: Translate;
  onUseOriginal: () => void;
};
// "Use original background" stays available while the model downloads or runs.
export function BackgroundStatus({ state, analysed, disabled, t, onUseOriginal }: StatusProps) {
  if (state === 'working' || state === 'keeping') {
    // Once pressed, the button stays in place (keeping focus) but does nothing more.
    const pressed = state === 'keeping';
    return <div className="background-status">
      <button id="background-original" className="button button-quiet" type="button" aria-disabled={pressed || undefined}
        onClick={pressed ? undefined : onUseOriginal}>{t('photo.bgUseOriginal')}</button>
    </div>;
  }
  if (state === 'failed') return <p className="fine muted background-status" role="status">{t('photo.bgFailed')}</p>;
  if (state === 'removed') {
    return <div className="background-status">
      <button id="background-original" className="button button-quiet" type="button" disabled={disabled} onClick={onUseOriginal}
        aria-describedby={analysed ? 'background-again' : undefined}>{t('photo.bgUseOriginal')}</button>
      {analysed && <p id="background-again" className="fine muted">{t('photo.bgReanalyse')}</p>}
    </div>;
  }
  return null;
}
