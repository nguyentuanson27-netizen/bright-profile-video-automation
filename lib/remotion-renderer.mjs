import {readFile} from 'node:fs/promises';
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

const mimeByExtension = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
]);

const mediaRefs = (inputProps = {}) => [
  inputProps.heroImage,
  inputProps.audioUrl,
  ...(inputProps.scenes ?? []).map((scene) => scene?.mediaUrl),
].filter(Boolean);

const assertLocalRef = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('Render media reference must be a bounded string');
  }
  if (value.startsWith('data:')) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || path.isAbsolute(value) || value.includes('\\')) {
    throw new TypeError('Render media must use local application-controlled references');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new TypeError('Render media must use local application-controlled references');
  }
};

export const assertLocalRenderInputs = (inputProps = {}) => {
  for (const value of mediaRefs(inputProps)) assertLocalRef(value);
  return inputProps;
};

const localDataUrl = async (reference, assetRoot) => {
  if (!reference || reference.startsWith('data:')) return reference || '';
  if (!assetRoot) throw new TypeError('assetRoot is required for local render media');
  assertLocalRef(reference);
  const root = path.resolve(assetRoot);
  const absolute = path.resolve(root, reference);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new TypeError('Render media must stay inside the application-controlled asset root');
  }
  const mimeType = mimeByExtension.get(path.extname(absolute).toLowerCase());
  if (!mimeType) throw new TypeError('Render media type is unsupported');
  const bytes = await readFile(absolute);
  if (bytes.length === 0) throw new TypeError('Render media is empty');
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
};

const materializeLocalMedia = async (inputProps, assetRoot) => {
  assertLocalRenderInputs(inputProps);
  const scenes = await Promise.all((inputProps.scenes ?? []).map(async (scene) => ({
    ...scene,
    ...(scene?.mediaUrl ? {mediaUrl: await localDataUrl(scene.mediaUrl, assetRoot)} : {}),
  })));
  return {
    ...inputProps,
    heroImage: await localDataUrl(inputProps.heroImage, assetRoot),
    audioUrl: await localDataUrl(inputProps.audioUrl, assetRoot),
    scenes,
  };
};

export async function renderBrightProfile({
  inputProps,
  outputLocation,
  assetRoot,
  scale = 1,
  crf = 20,
  onProgress,
}) {
  const safeInputProps = await materializeLocalMedia(inputProps, assetRoot);
  const url = await serveUrl();
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const composition = await selectComposition({
    serveUrl: url,
    id: 'BrightCreatorProfile',
    inputProps: safeInputProps,
    browserExecutable,
  });
  const safeScale = Math.round(composition.height * scale) / composition.height;

  await renderMedia({
    composition,
    serveUrl: url,
    codec: 'h264',
    outputLocation,
    inputProps: safeInputProps,
    browserExecutable,
    licenseKey: 'free-license',
    concurrency: 1,
    scale: safeScale,
    crf,
    onProgress,
  });
}
