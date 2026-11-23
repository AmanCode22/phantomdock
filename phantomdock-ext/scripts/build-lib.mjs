// Shared helpers for the Vite build pipeline (imported by vite.config.ts and
// scripts/build.mjs). Plain ESM, no dev-server context needed.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

export function targetDir(target) {
  return resolve(ROOT, `dist/${target}`);
}

export function copyStaticAssets(target) {
  const out = targetDir(target);
  mkdirSync(out, { recursive: true });

  // 1. manifest
  const manifestSrc = resolve(ROOT, `manifests/${target}.json`);
  cpSync(manifestSrc, resolve(out, 'manifest.json'));

  // 2. icons
  cpSync(resolve(ROOT, 'assets/icons'), resolve(out, 'icons'), { recursive: true });

  // 3. bundled site adapters
  const adaptersOut = resolve(out, 'adapters');
  mkdirSync(adaptersOut, { recursive: true });
  for (const f of readdirSync(resolve(ROOT, 'src/adapters'))) {
    if (f.endsWith('.json')) {
      cpSync(resolve(ROOT, `src/adapters/${f}`), resolve(adaptersOut, f));
    }
  }
}

// Vite plugin: after the popup bundle is written, stage static assets.
export function copyManifest({ target }) {
  let applied = false;
  return {
    name: 'pdock-copy-static',
    closeBundle() {
      if (applied) return;
      applied = true;
      copyStaticAssets(target);
      const manifest = JSON.parse(readFileSync(resolve(targetDir(target), 'manifest.json'), 'utf8'));
      const popupExists = existsSync(resolve(targetDir(target), 'popup.html'));
      writeFileSync(
        resolve(targetDir(target), '.build-check'),
        `manifest v${manifest.version} ok, popup=${popupExists}\n`
      );
    },
  };
}
