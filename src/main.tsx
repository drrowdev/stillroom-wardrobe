import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/app';
import './styles/app.css';
import { installRecoveryCapture } from './auth/recovery-callback';
import { readConfiguration } from './data/config';
import { startShellWorker } from './pwa/register';

installRecoveryCapture(readConfiguration(import.meta.env).status === 'ready');
const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing.');
createRoot(root).render(<StrictMode><App /></StrictMode>);
if (import.meta.env.PROD) startShellWorker(__STILLROOM_SHELL_WORKER__);
