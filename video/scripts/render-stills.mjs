/**
 * Render the eight review stills with one CLI call per frame. Remotion caches
 * the bundle after the first invocation, so this is still reasonably quick.
 *
 * Usage (from video/): npm run stills
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

const FRAMES = [0, 20, 40, 60, 70, 85, 110, 143];

mkdirSync('out', {recursive: true});

for (const frame of FRAMES) {
  const output = path.join(
    'out',
    `still_${String(frame).padStart(3, '0')}.png`,
  );
  console.log(`\n=== frame ${frame} -> ${output} ===`);
  const result = spawnSync(
    'npx',
    [
      'remotion',
      'still',
      'Promo1080x1920',
      output,
      `--frame=${frame}`,
      '--image-format=png',
    ],
    {stdio: 'inherit', shell: true, cwd: process.cwd()},
  );
  if (result.status !== 0) {
    console.error(`still ${frame} failed with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nAll stills rendered.');
