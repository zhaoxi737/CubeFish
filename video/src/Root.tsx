import React from 'react';
import {Composition} from 'remotion';
import './fonts';
import {Promo} from './Promo';
import {LANDSCAPE_COMPOSITION} from './PromoLandscape';
import {FPS, HEIGHT, WIDTH} from './theme';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Main entry: the user-approved 1920x1080 landscape cut. */}
      <Composition
        id={LANDSCAPE_COMPOSITION.id}
        component={LANDSCAPE_COMPOSITION.component}
        durationInFrames={LANDSCAPE_COMPOSITION.durationInFrames}
        fps={LANDSCAPE_COMPOSITION.fps}
        width={LANDSCAPE_COMPOSITION.width}
        height={LANDSCAPE_COMPOSITION.height}
      />

      {/* Legacy portrait cut — kept for reference, not part of the delivery. */}
      <Composition
        id="Promo1080x1920"
        component={Promo}
        durationInFrames={1824}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
