import { defineConfig } from 'vite';

const target = process.env.PD_TARGET || 'chrome';

// Background build: single-file IIFE bundle (service worker on Chrome,
// background script on Firefox — neither supports ESM imports reliably).
export default defineConfig({
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: 'src/background/index.ts',
      formats: ['iife'],
      name: 'pdockBackground',
      fileName: () => 'background.js',
    },
  },
});
