/**
 * Local Chinese webfonts.
 *
 * The launcher ships Microsoft YaHei, but browsers cannot use the .ttc
 * collection format in @font-face reliably, so the repo copy is converted once
 * to plain TTF (scripts/extract-fonts.ps1, fontTools). Both originals are kept
 * in public/fonts for reference.
 *
 * loadFont() registers a delayRender() handle and calls cancelRender() if the
 * file cannot be decoded, so a render can never silently fall back to tofu.
 */
import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

export const DISPLAY_FONT_FAMILY = 'CubeFishDisplay';
export const TEXT_FONT_FAMILY = 'CubeFishText';

loadFont({
  family: DISPLAY_FONT_FAMILY,
  url: staticFile('fonts/msyh-bold.ttf'),
  weight: '700',
  style: 'normal',
  format: 'truetype',
  display: 'block',
});

loadFont({
  family: TEXT_FONT_FAMILY,
  url: staticFile('fonts/msyh-regular.ttf'),
  weight: '400',
  style: 'normal',
  format: 'truetype',
  display: 'block',
});
