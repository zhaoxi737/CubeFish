/**
 * Render the 12 final key-frame stills for the full landscape cut.
 * Usage (from video/): node scripts/render-key-stills.mjs
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

const FRAMES = [0, 70, 143, 200, 300, 420, 540, 700, 900, 1100, 1400, 1700];

mkdirSync('out', {recursive: true});

for (const frame of FRAMES) {
  const output = path.join(
    'out',
    `keyframe_${String(frame).padStart(4, '0')}.png`,
  );
  console.log(`\n=== frame ${frame} -> ${output} ===`);
  const result = spawnSync(
    'npx',
    [
      'remotion',
      'still',
      'Promo1920x1080',
      output,
      `--frame=${frame}`,
      '--image-format=png',
    ],
    {stdio: 'inherit', shell: true, cwd: process.cwd()},
  );
  if (result.status !== 0) {
    console.error(`frame ${frame} failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nAll key-frame stills rendered.');
