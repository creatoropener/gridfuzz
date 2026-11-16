import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// `base: './'` keeps asset URLs relative so the static build works on GitHub Pages
// (project pages live under /<repo>/) and from any other static host.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // HyperFormula is a large dependency by nature; the worker bundle carries it too.
    chunkSizeWarningLimit: 3000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
