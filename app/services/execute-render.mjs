import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AppError} from '../../domain/errors.mjs';
import {generateTimedGoogleTts} from '../../lib/timed-google-tts.mjs';
import {renderBrightProfile} from '../../lib/remotion-renderer.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const RENDER_JOB_PATTERN = /^render-(media-manifest-[a-f0-9]{24})$/;
const ARTIFACT_URL_PATTERN = /^artifact:\/\/([A-Za-z0-9._-]{1,160})$/;

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

const artifactFileUrl = ({projectId, value, artifactStore}) => {
  if (!value) return value || '';
  const artifactMatch = String(value).match(ARTIFACT_URL_PATTERN);
  if (artifactMatch) {
    const artifact = artifactStore.get(projectId, artifactMatch[1]);
    if (!artifact) throw new AppError('RENDER_ARTIFACT_MISSING', 'Render artifact is missing', {status: 409, retryable: true});
    return pathToFileURL(artifact.absolutePath).href;
  }
  if (/^https?:\/\//i.test(value) || /^file:/i.test(value)) {
    throw new AppError('RENDER_UNTRUSTED_MEDIA', 'Render manifest contains an untrusted media URL', {status: 409});
  }
  return value;
};

const renderInputFromManifest = ({projectId, manifest, artifactStore, audioArtifact}) => {
  const inputProps = structuredClone(manifest.renderProject);
  inputProps.heroImage = artifactFileUrl({projectId, value: inputProps.heroImage, artifactStore});
  inputProps.scenes = (inputProps.scenes || []).map((scene) => ({
    ...scene,
    mediaUrl: artifactFileUrl({projectId, value: scene.mediaUrl, artifactStore}),
  }));
  if (audioArtifact) inputProps.audioUrl = pathToFileURL(audioArtifact.absolutePath).href;
  return inputProps;
};

export function createRenderExecutionService({
  repositories,
  projectStateStore,
  approvalService,
  mediaIngestService,
  artifactStore,
  dataDir,
  generateTts = generateTimedGoogleTts,
  renderProfile = renderBrightProfile,
  probeDuration = defaultProbeDuration,
}) {
  if (!repositories?.projects || !repositories?.revisions || !repositories?.artifacts) {
    throw new TypeError('render repositories are required');
  }
  if (!projectStateStore?.enqueueRender || !projectStateStore?.setStatus) throw new TypeError('projectStateStore is required');
  if (!approvalService?.assertRenderAllowed) throw new TypeError('approvalService is required');
  if (!mediaIngestService?.ingest) throw new TypeError('mediaIngestService is required');
  if (!artifactStore?.get || !artifactStore?.writeGenerated) throw new TypeError('artifactStore is required');
  if (!path.isAbsolute(dataDir)) throw new TypeError('render dataDir must be absolute');

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
      const output = path.join(workDir, 'voice.mp3');
      await withHeartbeat(() => generateTts({
        manifest: {duration: manifest.renderProject.duration, chunks},
        output,
        workDir,
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
          const outputLocation = path.join(workDir, 'output.mp4');
          const inputProps = renderInputFromManifest({
            projectId: job.projectId,
            manifest,
            artifactStore,
            audioArtifact,
          });
          await withHeartbeat(() => renderProfile({
            inputProps,
            outputLocation,
            scale: manifest.renderProject.renderScale || 1,
            crf: manifest.renderProject.crf || 20,
          }), heartbeat);
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
