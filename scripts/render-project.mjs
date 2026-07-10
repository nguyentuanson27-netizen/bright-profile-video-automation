import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {renderBrightProfile} from '../lib/remotion-renderer.mjs';

const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg) throw new Error('Usage: node scripts/render-project.mjs <project.json> [output.mp4]');

const projectPath = path.resolve(projectArg);
const baseDir = path.dirname(projectPath);
const project = JSON.parse(await readFile(projectPath, 'utf8'));
const isRemote = (value = '') => /^(https?:|data:|file:)/i.test(value);
const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const audioMime = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
]);

async function resolveMedia(value) {
  if (!value || isRemote(value)) return value || '';
  const resolved = path.resolve(baseDir, value);
  const ext = path.extname(resolved).toLowerCase();
  if (imageExt.has(ext)) {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${(await readFile(resolved)).toString('base64')}`;
  }
  if (audioMime.has(ext)) {
    return `data:${audioMime.get(ext)};base64,${(await readFile(resolved)).toString('base64')}`;
  }
  return pathToFileURL(resolved).href;
}

project.heroImage = await resolveMedia(project.heroImage);
project.audioUrl = await resolveMedia(project.audioUrl);
project.scenes = await Promise.all((project.scenes || []).map(async (scene) => ({
  ...scene,
  mediaUrl: await resolveMedia(scene.mediaUrl),
})));

const outputLocation = path.resolve(outputArg || 'data/bright-profile-output.mp4');
await renderBrightProfile({
  inputProps: project,
  outputLocation,
  scale: project.renderScale || 1,
  crf: project.crf || 20,
});

console.log(outputLocation);
