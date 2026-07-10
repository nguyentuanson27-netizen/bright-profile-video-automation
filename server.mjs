import http from 'node:http';
import path from 'node:path';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createReadStream, existsSync} from 'node:fs';
import {renderBrightProfile} from './lib/remotion-renderer.mjs';
import {generateTimedGoogleTts} from './lib/timed-google-tts.mjs';

const port = Number(process.env.PORT || 4180);
const dataDir = path.resolve(process.env.DATA_DIR || '/app/data');
const jobsDir = path.join(dataDir, 'jobs');
const apiToken = process.env.BRIGHT_API_TOKEN || '';
const maxBody = Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
const allowPrivateMediaUrls = process.env.ALLOW_PRIVATE_MEDIA_URLS === 'true';
const queue = [];
let runningJob = null;

await mkdir(jobsDir, {recursive: true});

const json = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body)});
  res.end(body);
};

const safeEqual = (left, right) => {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && timingSafeEqual(a, b);
};

const authorized = (req) => Boolean(apiToken) && safeEqual(req.headers['x-bright-api-key'], apiToken);
const jobPath = (id) => path.join(jobsDir, id);
const statePath = (id) => path.join(jobPath(id), 'state.json');
const readState = async (id) => JSON.parse(await readFile(statePath(id), 'utf8'));
const updateState = async (id, updates) => {
  const state = {...await readState(id), ...updates, updatedAt: new Date().toISOString()};
  await writeFile(statePath(id), JSON.stringify(state, null, 2));
  return state;
};

const readBody = (req) => new Promise((resolve, reject) => {
  const parts = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBody) req.destroy(new Error('Request body too large'));
    else parts.push(chunk);
  });
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
    catch (error) { reject(new Error(`Invalid JSON: ${error.message}`)); }
  });
  req.on('error', reject);
});

const imageMime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};

const isPrivateIp = (address) => {
  if (address === '127.0.0.1' || address === '::1' || address === '0.0.0.0') return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return true;
  if (/^169\.254\./.test(address)) return true;
  if (/^fc/i.test(address) || /^fd/i.test(address) || /^fe80:/i.test(address)) return true;
  return false;
};

const assertSafeRemoteUrl = async (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported media URL protocol: ${url.protocol}`);
  if (!allowPrivateMediaUrls) {
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Private media URLs are disabled');
    const records = await lookup(hostname, {all: true, verbatim: true});
    if (records.some((record) => isPrivateIp(record.address))) throw new Error('Private media URLs are disabled');
  }
};

const resolveAsset = async (value) => {
  if (!value) return '';
  if (/^data:/i.test(value)) return value;
  if (/^https?:/i.test(value)) {
    await assertSafeRemoteUrl(value);
    return value;
  }
  if (!value.startsWith('asset://')) throw new Error(`Unsupported media URL: ${value}`);
  const relative = value.slice('asset://'.length);
  const resolved = path.resolve('/app/assets', relative);
  if (!resolved.startsWith('/app/assets/')) throw new Error('Invalid asset path');
  const mime = imageMime[path.extname(resolved).toLowerCase()];
  if (!mime) throw new Error(`Unsupported bundled asset: ${relative}`);
  return `data:${mime};base64,${(await readFile(resolved)).toString('base64')}`;
};

const validateProject = (project) => {
  const duration = Number(project.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error('duration must be between 0 and 1800 seconds');
  if (!Array.isArray(project.scenes) || project.scenes.length === 0 || project.scenes.length > 80) throw new Error('scenes must be a non-empty array with at most 80 items');
  if (project.renderScale !== undefined && (Number(project.renderScale) < 0.25 || Number(project.renderScale) > 2)) throw new Error('renderScale must be between 0.25 and 2');
  if (project.crf !== undefined && (Number(project.crf) < 16 || Number(project.crf) > 35)) throw new Error('crf must be between 16 and 35');
  for (const scene of project.scenes) {
    if (!scene.id || !scene.type) throw new Error('Every scene needs id and type');
    if (Number(scene.start) < 0 || Number(scene.duration) <= 0 || Number(scene.start) + Number(scene.duration) > duration + 0.05) {
      throw new Error(`Scene ${scene.id} falls outside the project timeline`);
    }
  }
};

const processJob = async (id) => {
  const dir = jobPath(id);
  try {
    const request = JSON.parse(await readFile(path.join(dir, 'request.json'), 'utf8'));
    const project = request.project;
    await updateState(id, {status: 'processing', stage: 'assets'});
    project.heroImage = await resolveAsset(project.heroImage);
    project.scenes = await Promise.all(project.scenes.map(async (scene) => ({...scene, mediaUrl: await resolveAsset(scene.mediaUrl)})));

    if (request.voiceover?.chunks?.length) {
      await updateState(id, {status: 'processing', stage: 'tts'});
      const voiceFile = path.join(dir, 'voice.mp3');
      const result = await generateTimedGoogleTts({
        manifest: {duration: project.duration, chunks: request.voiceover.chunks},
        output: voiceFile,
        workDir: dir,
        onChunk: (chunk) => console.log(JSON.stringify({job: id, event: 'tts-chunk', ...chunk})),
      });
      const state = await readState(id);
      project.audioUrl = `http://127.0.0.1:${port}/assets/${id}/voice.mp3?token=${encodeURIComponent(state.assetToken)}`;
      await updateState(id, {tts: {duration: result.duration, voice: result.voice}});
    } else {
      project.audioUrl = await resolveAsset(project.audioUrl);
    }

    await updateState(id, {status: 'processing', stage: 'render'});
    const output = path.join(dir, 'output.mp4');
    await renderBrightProfile({inputProps: project, outputLocation: output, scale: Number(project.renderScale || 1), crf: Number(project.crf || 20)});
    await updateState(id, {status: 'completed', stage: 'completed', completedAt: new Date().toISOString(), output: 'output.mp4'});
  } catch (error) {
    console.error(error);
    await updateState(id, {status: 'failed', stage: 'failed', error: String(error?.stack || error).slice(0, 8000)});
  }
};

const drain = async () => {
  if (runningJob || queue.length === 0) return;
  runningJob = queue.shift();
  await processJob(runningJob);
  runningJob = null;
  setImmediate(drain);
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {ok: true, service: 'bright-profile-api', queue: queue.length, runningJob, tts: 'google-cloud'});
    }

    const assetMatch = url.pathname.match(/^\/assets\/([0-9a-f-]+)\/([a-zA-Z0-9._-]+)$/);
    if (req.method === 'GET' && assetMatch) {
      const [, id, filename] = assetMatch;
      const state = await readState(id);
      if (!safeEqual(url.searchParams.get('token'), state.assetToken)) return json(res, 403, {error: 'forbidden'});
      const file = path.join(jobPath(id), path.basename(filename));
      if (!existsSync(file)) return json(res, 404, {error: 'not found'});
      res.writeHead(200, {'content-type': filename.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream'});
      return createReadStream(file).pipe(res);
    }

    if (!authorized(req)) return json(res, 401, {error: 'unauthorized'});

    if (req.method === 'POST' && url.pathname === '/jobs') {
      const request = await readBody(req);
      validateProject(request.project || {});
      const id = randomUUID();
      const dir = jobPath(id);
      await mkdir(dir, {recursive: true});
      await writeFile(path.join(dir, 'request.json'), JSON.stringify(request, null, 2));
      await writeFile(statePath(id), JSON.stringify({
        id, status: 'queued', stage: 'queued', assetToken: randomBytes(24).toString('hex'),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, null, 2));
      queue.push(id);
      setImmediate(drain);
      return json(res, 202, {id, status: 'queued', statusUrl: `/jobs/${id}`, downloadUrl: `/jobs/${id}/download`});
    }

    const statusMatch = url.pathname.match(/^\/jobs\/([0-9a-f-]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const state = await readState(statusMatch[1]);
      const {assetToken: _hidden, ...publicState} = state;
      return json(res, 200, publicState);
    }

    const downloadMatch = url.pathname.match(/^\/jobs\/([0-9a-f-]+)\/download$/);
    if (req.method === 'GET' && downloadMatch) {
      const id = downloadMatch[1];
      const state = await readState(id);
      if (state.status !== 'completed') return json(res, 409, {error: 'job not completed', status: state.status});
      const file = path.join(jobPath(id), 'output.mp4');
      const stat = await import('node:fs/promises').then(({stat}) => stat(file));
      res.writeHead(200, {'content-type': 'video/mp4', 'content-length': stat.size, 'content-disposition': `attachment; filename="bright-profile-${id}.mp4"`});
      return createReadStream(file).pipe(res);
    }

    return json(res, 404, {error: 'not found'});
  } catch (error) {
    console.error(error);
    return json(res, 400, {error: error.message || String(error)});
  }
});

server.listen(port, '0.0.0.0', () => console.log(`bright-profile-api listening on ${port}`));
