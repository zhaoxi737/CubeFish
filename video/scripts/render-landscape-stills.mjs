/**
 * Render the landscape review stills: 4 per delivered segment.
 * Usage (from video/): node scripts/render-landscape-stills.mjs
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

const GROUPS = {
  s0: [0, 60, 70, 143],
  s2: [480, 512, 540, 575],
  s3: [600, 690, 790, 900],
};

mkdirSync('out', {recursive: true});

for (const [prefix, frames] of Object.entries(GROUPS)) {
  for (const frame of frames) {
    const output = path.join(
      'out',
      `${prefix}_still_${String(frame).padStart(3, '0')}.png`,
    );
    console.log(`\n=== ${prefix} frame ${frame} -> ${output} ===`);
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
      console.error(`${prefix} still ${frame} failed (${result.status})`);
      process.exit(result.status ?? 1);
    }
  }
}

console.log('\nAll landscape stills rendered.');
