import type { Translate } from '../../i18n';
import { reanalyseNoteId } from './background';
import type { EnhancementView } from './use-enhancement';

type Props = {
  view: EnhancementView; disabled: boolean; t: Translate;
  onSkip: () => void; onRevert: () => void;
  /** Shown while a changed crop is being cleaned up: cancelling keeps the previous photo. */ onCancelCrop?: () => void;
    /** `inline` shows the progress, "Edited with AI" and the lines; `menu` (Photo options) only "Use photo without clean-up". */
    placement?: 'inline' | 'menu';
  };
// "Skip" and "Use photo without clean-up" are real buttons; "Edited with AI" is visible text.
export function EnhancementStatus({ view, disabled, t, onSkip, onRevert, onCancelCrop, placement = 'inline' }: Props) {
  if (placement === 'menu') {
    return view.enhanced && !view.working ? <button id="enhance-revert" className="button button-quiet" type="button" disabled={disabled}
      onClick={onRevert} aria-describedby={reanalyseNoteId}>{t('enhance.revert')}</button> : null;
  }
  if (view.working) {
    return <div className="background-status enhancement-status">
      <p role="status" className="fine">{t('enhance.working')}</p>
      <button id="enhance-skip" className="button button-quiet" type="button" onClick={onSkip}>{t('enhance.skip')}</button>
      {onCancelCrop && <button id="enhance-cancel-crop" className="button button-quiet" type="button" onClick={onCancelCrop}>{t('photo.cancelCrop')}</button>}
    </div>;
  }
  if (view.enhanced) {
    return <div className="background-status enhancement-status">
      <p className="fine enhancement-label">{t('enhance.edited')}</p>
    </div>;
  }
  if (view.line === 'none') return null;
  return <p className="fine muted background-status" role="status">{t(view.line === 'allowance' ? 'enhance.allowance' : view.line === 'ambiguous' ? 'enhance.ambiguous' : 'enhance.fallback')}</p>;
}
