import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';

let serveUrlPromise;

const serveUrl = () => {
  if (!serveUrlPromise) {
    serveUrlPromise = bundle({entryPoint: path.resolve('video', 'index.jsx')});
  }
  return serveUrlPromise;
};

export async function renderBrightProfile({
  inputProps,
  outputLocation,
  scale = 1,
  crf = 20,
}) {
  const url = await serveUrl();
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const composition = await selectComposition({
    serveUrl: url,
    id: 'BrightCreatorProfile',
    inputProps,
    browserExecutable,
  });
  const safeScale = Math.round(composition.height * scale) / composition.height;

  await renderMedia({
    composition,
    serveUrl: url,
    codec: 'h264',
    outputLocation,
    inputProps,
    browserExecutable,
    licenseKey: 'free-license',
    concurrency: 1,
    scale: safeScale,
    crf,
  });
}
