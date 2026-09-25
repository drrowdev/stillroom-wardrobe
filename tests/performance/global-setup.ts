import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { buildProduction, repository } from '../pwa/builds';

export const perfRoot = path.join(repository, 'node_modules', '.cache', 'stillroom-performance');
export const perfApp = path.join(perfRoot, 'app');
export const engineBundle = path.join(perfRoot, 'engine', 'engine.js');

// One production build of the app, and the recommendation engine as a standalone IIFE for the timing test.
export default async function globalSetup() {
  mkdirSync(perfRoot, { recursive: true });
  buildProduction(perfApp, 'performance');
  rmSync(path.dirname(engineBundle), { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'warn',
    root: repository,
    build: {
      outDir: path.dirname(engineBundle),
      emptyOutDir: true,
      lib: { entry: path.join(repository, 'tests', 'performance', 'engine-entry.ts'), formats: ['iife'], name: 'StillroomEngine', fileName: () => 'engine.js' },
    },
  });
}
