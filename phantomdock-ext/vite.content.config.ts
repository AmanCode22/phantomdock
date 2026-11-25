import { defineConfig } from 'vite';

const target = process.env.PD_TARGET || 'chrome';

// Content script build: single-file IIFE bundle (content scripts cannot use ESM).
export default defineConfig({
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: 'src/content/index.ts',
      formats: ['iife'],
      name: 'pdockContent',
      fileName: () => 'content.js',
    },
  },
});
