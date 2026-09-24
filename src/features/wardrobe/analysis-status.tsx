import type { Translate } from '../../i18n';
import type { AiPhase } from './use-ai-draft';

type Props = {
  phase: AiPhase; checking: boolean; disabled: boolean; t: Translate;
  onRetry: () => void; onCheck: () => void; onKeep: () => void;
};
// One short line for the photo analysis state. "Try again" sends a new analysis only after failure or a needed check;
// while still working it checks the same request.
export function AnalysisStatus({ phase, checking, disabled, t, onRetry, onCheck, onKeep }: Props) {
  if (phase === 'none' || phase === 'ready' || phase === 'manual') return null;
  return <div id="analysis-status" className="analysis-status">
    {phase === 'off' && <>
      <p role="status">{t('aiC.off')}</p>
      <a href="#/settings" className="text-button">{t('aiC.turnOn')}</a>
    </>}
    {phase === 'working' && <p role="status"><span className="spinner" aria-hidden="true" />{t('aiC.filling')}</p>}
    {phase === 'stillWorking' && <>
      <p role="status">{t('aiC.stillWorking')}</p>
      <button type="button" className="text-button" disabled={disabled || checking} onClick={onCheck}>{t('common.retry')}</button>
    </>}
    {(phase === 'failed' || phase === 'unclear') && <>
      <p role="status">{t('aiC.fillFailed')}</p>
      <button type="button" className="text-button" disabled={disabled} onClick={onRetry}>{t('common.retry')}</button>
    </>}
    {phase === 'limit' && <p role="status">{t('aiC.limit')}</p>}
    {phase === 'needsCheck' && <>
      <p role="status">{t('aiC.needsCheck')}</p>
      <div className="analysis-actions">
        <button type="button" className="button button-secondary" disabled={disabled} onClick={onKeep}>{t('aiC.keep')}</button>
        <button type="button" className="text-button" disabled={disabled} onClick={onRetry}>{t('common.retry')}</button>
      </div>
    </>}
  </div>;
}
