import {Config} from '@remotion/cli/config';

/**
 * This machine has no Chrome, but Microsoft Edge (Chromium) is installed at the
 * classic x86 path. Point Remotion at it instead of downloading a browser.
 * Remove this line (or change the path) on another machine and Remotion will
 * fall back to chrome-headless-shell.
 */
Config.setBrowserExecutable(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
);

// The brief asks for PNG frames: crisp text/pixel edges, then h264 at CRF 16.
Config.setVideoImageFormat('png');
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
// Microsoft YaHei is ~16 MB + ~19 MB; give the font delayRender handles room.
Config.setDelayRenderTimeoutInMilliseconds(120_000);
