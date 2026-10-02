import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import { BootFailure } from './app/boot-failure';
import './styles/app.css';
import { installRecoveryCapture } from './auth/recovery-callback';
import { readConfiguration } from './data/config';
import { resolveLanguage } from './i18n';
import { ensureCatalogue } from './i18n/load';
import { startShellWorker } from './pwa/register';

installRecoveryCapture(readConfiguration(import.meta.env).status === 'ready');
const element = document.getElementById('root');
if (!element) throw new Error('Application root is missing.');
const root = createRoot(element);
// LANG1: only the device language's catalogue is fetched, and nothing renders until it has arrived, so no text of
// another language can appear. A failed load shows the boot screen; its Try again reuses this root and document.
const initial = resolveLanguage(navigator.languages);
document.documentElement.lang = initial;
const start = () => root.render(<StrictMode><App /></StrictMode>);
ensureCatalogue(initial).then(start, () => {
  root.render(<StrictMode><BootFailure language={initial} retry={() => ensureCatalogue(initial)} onReady={start} /></StrictMode>);
});
if (import.meta.env.PROD) startShellWorker(__STILLROOM_SHELL_WORKER__);