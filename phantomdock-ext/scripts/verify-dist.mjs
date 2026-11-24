#!/usr/bin/env node
// Structural verification for a built extension bundle: every file referenced
// by the manifest (background, content scripts, popup, icons, adapters) must
// exist. Runs as part of the build and CI.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const targets = process.argv[2] ? [process.argv[2]] : ['chrome', 'firefox'];
let failures = 0;

for (const target of targets) {
  const dir = resolve(ROOT, `dist/${target}`);
  const manifestPath = resolve(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`[${target}] manifest.json missing`);
    failures++;
    continue;
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const required = [];
  if (m.background?.service_worker) required.push(m.background.service_worker);
  for (const s of m.background?.scripts ?? []) required.push(s);
  for (const cs of m.content_scripts ?? []) required.push(...(cs.js ?? []));
  if (m.action?.default_popup) required.push(m.action.default_popup);
  for (const icon of Object.values(m.icons ?? {})) required.push(icon);

  for (const rel of required) {
    if (!existsSync(resolve(dir, rel))) {
      console.error(`[${target}] missing file referenced by manifest: ${rel}`);
      failures++;
    }
  }
  // Built bundles must exist and be non-trivial. popup.html is a small shell
  // that references the hashed JS/CSS assets, so it gets a lower floor.
  for (const [f, minBytes] of [
    ['background.js', 10_000],
    ['content.js', 10_000],
    ['popup.html', 150],
  ]) {
    const p = resolve(dir, f);
    if (!existsSync(p)) {
      console.error(`[${target}] missing build output: ${f}`);
      failures++;
    } else if (readFileSync(p).length < minBytes) {
      console.error(`[${target}] suspiciously small build output: ${f}`);
      failures++;
    }
  }
  // Bundled adapters must all be present.
  const adaptersDir = resolve(dir, 'adapters');
  if (!existsSync(adaptersDir)) {
    console.error(`[${target}] missing adapters/ directory`);
    failures++;
  } else {
    const jsons = readdirSync(adaptersDir).filter((f) => f.endsWith('.json'));
    if (jsons.length < 5) {
      console.error(`[${target}] expected 5 bundled adapters, found ${jsons.length}`);
      failures++;
    }
  }
  if (failures === 0) {
    console.log(`[${target}] bundle OK — v${m.version}, ${required.length} manifest refs verified`);
  }
}

process.exit(failures ? 1 : 0);
