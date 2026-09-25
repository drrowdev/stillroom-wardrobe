import { Component, Suspense, useEffect, type ReactNode } from 'react';
import type { Translate } from '../i18n';
import { ChunkLoadError } from './lazy-load';

type Props = { t: Translate; action?: ReactNode; children: ReactNode };

class ChunkBoundary extends Component<Props, { error: unknown }> {
  state: { error: unknown } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!(error instanceof ChunkLoadError)) throw error;
    const { t, action } = this.props;
    return <section className="chunk-error" role="alert">
      <p>{t('chunk.failed')}</p>
      <div className="chunk-actions">
        <button type="button" className="button button-primary" onClick={() => location.reload()}>{t('chunk.reload')}</button>
        {action}
      </div>
    </section>;
  }
}

function Ready({ onReady }: { onReady?: () => void }) {
  useEffect(() => { onReady?.(); }, [onReady]);
  return null;
}

// `action` is shown while loading and after a failure, so the user can leave without reloading.
export function LazyBoundary({ t, onReady, action, children }: Props & { onReady?: () => void }) {
  return <ChunkBoundary t={t} action={action}>
    <Suspense fallback={<div className="chunk-loading"><div className="chunk-status" role="status" aria-busy="true"><span className="spinner" aria-hidden="true" /><span>{t('common.loading')}</span></div>{action}</div>}>
      {children}
      <Ready onReady={onReady} />
    </Suspense>
  </ChunkBoundary>;
}
