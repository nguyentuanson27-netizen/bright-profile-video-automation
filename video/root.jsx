import React from 'react';
import {Composition} from 'remotion';
import {BrightCreatorProfile} from './bright-profile.jsx';

const defaultScenes = [];

export const BrightProfileRoot = () => (
  <Composition
    id="BrightCreatorProfile"
    component={BrightCreatorProfile}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={900}
    defaultProps={{
      duration: 30,
      title: 'Bright Creator Profile',
      creatorName: 'CREATOR',
      heroImage: '',
      audioUrl: '',
      scenes: defaultScenes,
    }}
    calculateMetadata={({props}) => ({
      durationInFrames: Math.max(30, Math.ceil((props.duration || 30) * 30)),
    })}
  />
);
