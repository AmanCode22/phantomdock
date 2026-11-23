import { defineConfig } from 'vitest/config';

// Dedicated Vitest config. Without this file Vitest falls back to
// vite.config.ts, whose `root: 'src/popup'` (needed so popup.html lands at
// the bundle root for the manifests) hides the top-level tests/ directory
// and `npm test` exits with "No test files found".
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
