import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {clearInterval, setInterval} from 'node:timers';
import {AppError} from '../../domain/errors.mjs';
import {generateTimedGeminiTts} from '../../lib/timed-gemini-tts.mjs';
import {renderBrightProfile} from '../../lib/remotion-renderer.mjs';
import {createTrustedAssetServer} from '../../worker/trusted-assets.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const RENDER_JOB_PATTERN = /^render-(media-manifest-[a-f0-9]{24})$/;

const defaultProbeDuration = (file) => new Promise((resolve, reject) => {
  const child = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', () => reject(new AppError('FFPROBE_UNAVAILABLE', 'ffprobe could not be started', {status: 500})));
  child.on('close', (code) => {
    if (code !== 0) {
      reject(new AppError('MEDIA_PROBE_FAILED', `Rendered media validation failed: ${stderr.slice(-500)}`, {status: 500}));
      return;
    }
    resolve(Number(stdout.trim()));
  });
});

const assertDuration = (duration) => {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new AppError('RENDER_OUTPUT_INVALID', 'Rendered video has an invalid duration', {status: 500});
  }
  return duration;
};

const withHeartbeat = async (action, heartbeat) => {
  if (typeof heartbeat !== 'function') return action();
  let heartbeatError = null;
  const timer = setInterval(() => {
    if (heartbeatError) return;
    try {
      heartbeat();
    } catch (error) {
      heartbeatError = error;
    }
  }, 10_000);
  timer.unref?.();
  try {
    const result = await action();
    if (heartbeatError) throw heartbeatError;
    return result;
  } finally {
    clearInterval(timer);
  }
};

const readManifest = async ({projectId, manifestId, artifactStore}) => {
  const artifact = artifactStore.get(projectId, manifestId);
  if (!artifact || artifact.kind !== 'media-manifest') {
    throw new AppError('MEDIA_MANIFEST_REQUIRED', 'Completed media ingest manifest is required', {status: 409});
  }
  let value;
  try {
    value = JSON.parse(await readFile(artifact.absolutePath, 'utf8'));
  } catch {
    throw new AppError('MEDIA_MANIFEST_INVALID', 'Media ingest manifest is invalid', {status: 500});
  }
  if (value?.projectId !== projectId || value?.approvedRevisionId === undefined || !value?.approvedPayloadHash) {
    throw new AppError('MEDIA_MANIFEST_INVALID', 'Media ingest manifest is invalid', {status: 500});
  }
  return {artifact, value};
};

const renderInputFromManifest = ({manifest, trustedAssets, audioArtifact}) => {
  const inputProps = structuredClone(manifest.renderProject);
  inputProps.heroImage = trustedAssets.resolve(inputProps.heroImage);
  inputProps.scenes = (inputProps.scenes || []).map((scene) => ({
    ...scene,
    mediaUrl: trustedAssets.resolve(scene.mediaUrl),
  }));
  if (audioArtifact) inputProps.audioUrl = trustedAssets.resolve(`artifact://${audioArtifact.id}`);
  return inputProps;
};

export function createRenderExecutionService({
  repositories,
  projectStateStore,
  approvalService,
  mediaIngestService,
  artifactStore,
  dataDir,
  generateTts = generateTimedGeminiTts,
  renderProfile = renderBrightProfile,
  probeDuration = defaultProbeDuration,
  trustedAssetServerFactory = createTrustedAssetServer,
  observability = null,
  diskGuard = null,
}) {
  if (!repositories?.projects || !repositories?.revisions || !repositories?.artifacts) {
    throw new TypeError('render repositories are required');
  }
  if (!projectStateStore?.enqueueRender || !projectStateStore?.setStatus) throw new TypeError('projectStateStore is required');
  if (!approvalService?.assertRenderAllowed) throw new TypeError('approvalService is required');
  if (!mediaIngestService?.ingest) throw new TypeError('mediaIngestService is required');
  if (!artifactStore?.get || !artifactStore?.writeGenerated) throw new TypeError('artifactStore is required');
  if (!path.isAbsolute(dataDir)) throw new TypeError('render dataDir must be absolute');
  if (typeof trustedAssetServerFactory !== 'function') throw new TypeError('trustedAssetServerFactory must be a function');
  if (diskGuard && typeof diskGuard.assertExpensiveWorkAllowed !== 'function') throw new TypeError('diskGuard is invalid');

  const observeProvider = ({provider, operation, run}) => observability?.observeProvider
    ? observability.observeProvider({provider, operation, run})
    : run();

  const loadApprovedManifest = async (job) => {
    const match = String(job.id).match(RENDER_JOB_PATTERN);
    if (!match || job.stage !== 'rendering') {
      throw new AppError('RENDER_JOB_INVALID', 'Render job metadata is invalid', {status: 500});
    }
    const loaded = await readManifest({projectId: job.projectId, manifestId: match[1], artifactStore});
    const revision = repositories.revisions.get(loaded.value.approvedRevisionId);
    if (!revision
      || revision.projectId !== job.projectId
      || revision.status !== 'approved'
      || revision.payloadHash !== loaded.value.approvedPayloadHash) {
      throw new AppError('APPROVED_REVISION_MISMATCH', 'Render manifest no longer matches an approved revision', {status: 409});
    }
    return {manifestArtifact: loaded.artifact, manifest: loaded.value, revision};
  };

  const audioFor = async ({job, manifest, revision, workDir, heartbeat}) => {
    const chunks = revision.payload.generation.voiceover?.chunks || [];
    if (chunks.length === 0) return null;
    const id = `tts-${sha256(manifest.approvedPayloadHash).slice(0, 24)}`;
    let artifact = artifactStore.get(job.projectId, id);
    if (!artifact) {
      await diskGuard?.assertExpensiveWorkAllowed('tts');
      const output = path.join(workDir, 'voice.mp3');
      await withHeartbeat(() => observeProvider({
        provider: 'gemini',
        operation: 'tts',
        run: () => generateTts({
          manifest: {duration: manifest.renderProject.duration, chunks},
          output,
          workDir,
        }),
      }), heartbeat);
      const body = await readFile(output);
      if (body.length === 0) throw new AppError('TTS_OUTPUT_INVALID', 'Generated TTS audio is empty', {status: 500});
      artifact = artifactStore.writeGenerated({
        projectId: job.projectId,
        id,
        kind: 'tts-audio',
        directory: 'audio',
        extension: 'mp3',
        buffer: body,
      });
      artifact = artifactStore.get(job.projectId, artifact.id);
    }
    return artifact;
  };

  const videoIdFor = (manifest) => `video-${sha256(manifest.approvedPayloadHash).slice(0, 24)}`;

  return Object.freeze({
    async enqueue({projectId, revisionId, maxAttempts = 2}) {
      const approvedRevision = approvalService.assertRenderAllowed({projectId, revisionId});
      const ingested = await mediaIngestService.ingest({projectId, revisionId});
      const hasVoiceover = (approvedRevision.payload.generation.voiceover?.chunks || []).length > 0;
      const jobId = `render-${ingested.manifestArtifact.id}`;
      const job = projectStateStore.enqueueRender({
        projectId,
        jobId,
        initialStatus: hasVoiceover ? 'tts' : 'render_queued',
        maxAttempts,
      });
      return {job, manifestArtifact: ingested.manifestArtifact};
    },

    async handleJob({job, heartbeat}) {
      const {manifest, revision} = await loadApprovedManifest(job);
      let project = repositories.projects.get(job.projectId);
      const videoId = videoIdFor(manifest);
      let existingVideo = artifactStore.get(job.projectId, videoId);

      if (project?.status === 'completed') {
        if (!existingVideo) throw new AppError('RENDER_OUTPUT_MISSING', 'Completed project is missing its rendered video', {status: 500});
        assertDuration(await probeDuration(existingVideo.absolutePath));
        return existingVideo;
      }
      if (!project || !['tts', 'render_queued', 'rendering'].includes(project.status)) {
        throw new AppError('RENDER_PROJECT_STATE_INVALID', 'Project is not in a renderable state', {status: 409});
      }

      const workDir = path.join(dataDir, 'work', job.id, `attempt-${job.attempt}`);
      await rm(workDir, {recursive: true, force: true});
      await mkdir(workDir, {recursive: true});
      try {
        const audioArtifact = await audioFor({job, manifest, revision, workDir, heartbeat});
        project = repositories.projects.get(job.projectId);
        if (project.status === 'tts') {
          projectStateStore.setStatus({projectId: job.projectId, status: 'render_queued'});
          project = repositories.projects.get(job.projectId);
        }
        if (project.status === 'render_queued') {
          projectStateStore.setStatus({projectId: job.projectId, status: 'rendering'});
          project = repositories.projects.get(job.projectId);
        }
        if (project.status !== 'rendering') {
          throw new AppError('RENDER_PROJECT_STATE_INVALID', 'Project is not in rendering state', {status: 409});
        }

        existingVideo = artifactStore.get(job.projectId, videoId);
        if (!existingVideo) {
          await diskGuard?.assertExpensiveWorkAllowed('rendering');
          const outputLocation = path.join(workDir, 'output.mp4');
          const trustedAssets = trustedAssetServerFactory({projectId: job.projectId, artifactStore});
          await trustedAssets.start();
          try {
            const inputProps = renderInputFromManifest({manifest, trustedAssets, audioArtifact});
            await withHeartbeat(() => observeProvider({
              provider: 'remotion',
              operation: 'render',
              run: () => renderProfile({
                inputProps,
                outputLocation,
                scale: manifest.renderProject.renderScale || 1,
                crf: manifest.renderProject.crf || 20,
              }),
            }), heartbeat);
          } finally {
            await trustedAssets.close();
          }
          const info = await stat(outputLocation);
          if (!info.isFile() || info.size <= 0) {
            throw new AppError('RENDER_OUTPUT_INVALID', 'Renderer did not produce a non-empty video', {status: 500});
          }
          assertDuration(await probeDuration(outputLocation));
          const body = await readFile(outputLocation);
          const stored = artifactStore.writeGenerated({
            projectId: job.projectId,
            id: videoId,
            kind: 'rendered-video',
            directory: 'output',
            extension: 'mp4',
            buffer: body,
          });
          existingVideo = artifactStore.get(job.projectId, stored.id);
        } else {
          assertDuration(await probeDuration(existingVideo.absolutePath));
        }

        projectStateStore.setStatus({projectId: job.projectId, status: 'completed'});
        return existingVideo;
      } finally {
        await rm(workDir, {recursive: true, force: true});
      }
    },
  });
}
