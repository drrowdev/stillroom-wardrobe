import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const publicKeys = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_APP_VERSION',
]);

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'VITE_');
  if (Object.keys(environment).some((key) => !publicKeys.has(key))) {
    throw new Error('Only the three documented public build variables are allowed.');
  }
  const backend = environment.VITE_SUPABASE_URL
    ? new URL(environment.VITE_SUPABASE_URL).origin
    : '';
  return {
    plugins: [
      react(),
      {
        name: 'private-app-headers',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: '_headers',
            source: [
              '/*',
              `  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' ${backend}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
              '  Referrer-Policy: no-referrer',
              '  X-Content-Type-Options: nosniff',
              '  Permissions-Policy: geolocation=(), microphone=()',
              '/',
              '  Cache-Control: no-cache',
              '/index.html',
              '  Cache-Control: no-cache',
              '/assets/*',
              '  Cache-Control: public, max-age=31536000, immutable',
              '',
            ].join('\n'),
          });
        },
      },
    ],
    build: { sourcemap: false },
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      restoreMocks: true,
    },
  };
});
