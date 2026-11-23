#!/usr/bin/env node
// Dual-target build orchestrator: compiles background (IIFE), content (IIFE),
// and popup (React app) for the requested browser target, then stages the
// manifest, icons, and bundled adapters.
//
//   node scripts/build.mjs            # both targets
//   PD_TARGET=chrome node scripts/build.mjs
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { copyStaticAssets, targetDir } from './build-lib.mjs';

const targets = process.env.PD_TARGET ? [process.env.PD_TARGET] : ['chrome', 'firefox'];

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

for (const target of targets) {
  rmSync(targetDir(target), { recursive: true, force: true });
  console.log(`\n[phantomdock-ext] building target: ${target}`);
  run('npx', ['vite', 'build', '--config', 'vite.background.config.ts'], { PD_TARGET: target });
  run('npx', ['vite', 'build', '--config', 'vite.content.config.ts'], { PD_TARGET: target });
  run('npx', ['vite', 'build', '--config', 'vite.config.ts'], { PD_TARGET: target });
  copyStaticAssets(target);
  console.log(`[phantomdock-ext] ${target} bundle staged in dist/${target}`);
}

// Structural verification of both bundles (also runs standalone in CI).
run('node', ['scripts/verify-dist.mjs']);
console.log('\n[phantomdock-ext] done.');
