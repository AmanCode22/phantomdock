import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.PD_TARGET || 'chrome';

// Popup build: Vite root is the popup directory so popup.html lands at the
// bundle root (exactly where the manifests' default_popup points).
export default defineConfig({
  root: 'src/popup',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, `dist/${target}`),
    emptyOutDir: false, // background/content/manifest staged in by the build script
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'src/popup/popup.html'),
    },
  },
});
