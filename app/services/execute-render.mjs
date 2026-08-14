import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {extname, relative, resolve, sep} from 'node:path';

import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {generateTimedGoogleTts} from '../../lib/timed-google-tts.mjs';
import {renderBrightProfile} from '../../lib/remotion-renderer.mjs';
import {assertRelativeArtifactPath} from '../../storage/artifacts.mjs';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toRelative = (dataDir, absolutePath) => relative(resolve(dataDir), resolve(absolutePath)).split(sep).join('/');

const absoluteArtifactPath = (dataDir, relativePath) => {
  assertRelativeArtifactPath(relativePath);
  const root = resolve(dataDir);
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new TypeError('artifact path escapes dataDir');
  return absolute;
};

const readVerifiedArtifact = async (dataDir, artifact) => {
  if (!artifact?.isAuthoritative) throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Required authoritative artifact is unavailable');
  const bytes = await readFile(absoluteArtifactPath(dataDir, artifact.relativePath));
  if (bytes.length < 1 || bytes.length !== artifact.byteSize || sha256(bytes) !== artifact.sha256) {
    throw new AppError('ARTIFACT_CORRUPT', 'Authoritative artifact failed integrity validation');
  }
  return bytes;
};

const makeFileArtifact = async (dataDir, kind, absolutePath, mimeType) => {
  const bytes = await readFile(absolutePath);
  if (bytes.length < 1) throw new AppError('OUTPUT_INVALID', `${kind} output is empty`);
  return {
    kind,
    relativePath: toRelative(dataDir, absolutePath),
    mimeType,
    byteSize: bytes.length,
    sha256: sha256(bytes),
  };
};

const assertCurrentApprovedRevision = (project, revision, claim) => {
  if (
    !project
    || !revision
    || !revision.approvedAt
    || revision.projectId !== project.id
    || claim.revisionId !== revision.id
    || project.currentRevisionId !== revision.id
    || project.approvedRevisionId !== revision.id
  ) {
    throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Stage requires the same current immutable approved revision');
  }
};

export const probeMediaFile = (file) => new Promise((resolveProbe, rejectProbe) => {
  const child = spawn('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.once('error', rejectProbe);
  child.once('close', (code) => {
    const duration = Number(stdout.trim());
    if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
      rejectProbe(new AppError('OUTPUT_INVALID', 'Rendered MP4 failed ffprobe validation'));
      return;
    }
    resolveProbe(duration);
  });
});

const attemptRoot = (dataDir, claim, area) => resolve(
  dataDir,
  'projects',
  digest(claim.projectId).slice(0, 24),
  'attempts',
  digest(`${claim.stageId}\0${claim.attemptId}`).slice(0, 24),
  area,
);

const loadMediaManifest = async ({artifactStore, dataDir, projectId, revisionId}) => {
  const artifact = artifactStore.getAuthoritative(projectId, revisionId, 'media_manifest');
  const bytes = await readVerifiedArtifact(dataDir, artifact);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError('ARTIFACT_CORRUPT', 'Media manifest is malformed');
  }
  if (
    !manifest
    || manifest.projectId !== projectId
    || manifest.revisionId !== revisionId
    || !Array.isArray(manifest.media)
    || !manifest.scenes
  ) {
    throw new AppError('ARTIFACT_CORRUPT', 'Media manifest does not match the approved revision');
  }
  for (const item of manifest.media) assertRelativeArtifactPath(item.relativePath);
  return manifest;
};

const retryableStageError = (code, message, cause) => {
  if (cause?.code === ErrorCodes.STALE_CLAIM) return cause;
  const error = new AppError(code, message);
  error.retryable = true;
  return error;
};

export const createTtsStageHandler = ({
  repos,
  artifactStore,
  dataDir,
  generateTts = generateTimedGoogleTts,
  nextMaxAttempts = 4,
} = {}) => {
  if (!repos?.projects || !repos?.revisions) throw new TypeError('repositories are required');
  if (!artifactStore || typeof artifactStore.commitTts !== 'function') throw new TypeError('artifact store is required');
  if (typeof generateTts !== 'function') throw new TypeError('generateTts is required');
  return async (claim, context) => {
    const project = repos.projects.get(claim.projectId);
    const revision = claim.revisionId ? repos.revisions.get(claim.revisionId) : null;
    assertCurrentApprovedRevision(project, revision, claim);
    if (project.status !== 'tts') throw new AppError(ErrorCodes.INVALID_TRANSITION, 'TTS project state is not current');
    await loadMediaManifest({artifactStore, dataDir, projectId: claim.projectId, revisionId: claim.revisionId});

    const workDir = attemptRoot(dataDir, claim, 'tts');
    await rm(workDir, {recursive: true, force: true});
    await mkdir(workDir, {recursive: true});
    const output = resolve(workDir, 'voice.mp3');
    try {
      await generateTts({
        manifest: {chunks: revision.payload.voiceover.chunks, duration: revision.payload.render.duration},
        output,
        workDir,
        onChunk: (chunk) => context.progress({phase: 'tts', chunk}),
      });
    } catch (error) {
      throw retryableStageError('TTS_FAILED', 'TTS generation failed', error);
    }
    const audioArtifact = await makeFileArtifact(dataDir, 'tts_audio', output, 'audio/mpeg');
    return context.finalize(() => artifactStore.commitTts({
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      nowMs: context.nowMs(),
      audioArtifact,
      nextMaxAttempts,
    }));
  };
};

const buildRenderPublicDir = async ({dataDir, claim, manifest, audioArtifact}) => {
  const root = attemptRoot(dataDir, claim, 'render');
  const publicDir = resolve(root, 'public');
  await rm(root, {recursive: true, force: true});
  await mkdir(resolve(publicDir, 'media'), {recursive: true});
  await mkdir(resolve(publicDir, 'audio'), {recursive: true});
  const mediaRefs = new Map();
  for (let index = 0; index < manifest.media.length; index += 1) {
    const item = manifest.media[index];
    const extension = extname(item.relativePath).toLowerCase();
    const filename = `media-${String(index).padStart(3, '0')}${extension}`;
    await copyFile(absoluteArtifactPath(dataDir, item.relativePath), resolve(publicDir, 'media', filename));
    mediaRefs.set(item.sourceId, `media/${filename}`);
  }
  await readVerifiedArtifact(dataDir, audioArtifact);
  await copyFile(absoluteArtifactPath(dataDir, audioArtifact.relativePath), resolve(publicDir, 'audio', 'voice.mp3'));
  return {root, publicDir, mediaRefs, audioRef: 'audio/voice.mp3'};
};

export const buildLocalRenderInputProps = ({revision, manifest, mediaRefs, audioRef}) => {
  const scenes = revision.payload.scenes.map((scene) => {
    const sourceId = manifest.scenes[scene.id];
    const mediaUrl = sourceId ? mediaRefs.get(sourceId) : undefined;
    return {...scene, ...(mediaUrl ? {mediaUrl} : {})};
  });
  const heroImage = manifest.media.length > 0 ? mediaRefs.get(manifest.media[0].sourceId) ?? '' : '';
  return {
    duration: revision.payload.render.duration,
    creatorName: revision.payload.creatorName,
    heroImage,
    audioUrl: audioRef,
    scenes,
  };
};

export const createRenderStageHandler = ({
  repos,
  artifactStore,
  dataDir,
  renderer = renderBrightProfile,
  probe = probeMediaFile,
} = {}) => {
  if (!repos?.projects || !repos?.revisions) throw new TypeError('repositories are required');
  if (!artifactStore || typeof artifactStore.commitRender !== 'function') throw new TypeError('artifact store is required');
  if (typeof renderer !== 'function' || typeof probe !== 'function') throw new TypeError('renderer and probe are required');
  return async (claim, context) => {
    let project = repos.projects.get(claim.projectId);
    const revision = claim.revisionId ? repos.revisions.get(claim.revisionId) : null;
    assertCurrentApprovedRevision(project, revision, claim);
    const manifest = await loadMediaManifest({artifactStore, dataDir, projectId: claim.projectId, revisionId: claim.revisionId});
    const audioArtifact = artifactStore.getAuthoritative(claim.projectId, claim.revisionId, 'tts_audio');
    await readVerifiedArtifact(dataDir, audioArtifact);
    artifactStore.markRendering({stageId: claim.stageId, claimToken: claim.claimToken, nowMs: context.nowMs()});
    project = repos.projects.get(claim.projectId);
    if (project.status !== 'rendering') throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Render project state is not current');

    const staging = await buildRenderPublicDir({dataDir, claim, manifest, audioArtifact});
    const output = resolve(staging.root, 'output.mp4');
    const inputProps = buildLocalRenderInputProps({revision, manifest, mediaRefs: staging.mediaRefs, audioRef: staging.audioRef});
    try {
      await renderer({
        inputProps,
        outputLocation: output,
        publicDir: staging.publicDir,
        scale: revision.payload.render.renderScale ?? 1,
        crf: revision.payload.render.crf ?? 20,
        onProgress: ({progress}) => context.progress({phase: 'render', progress}),
      });
      await probe(output);
    } catch (error) {
      if (error?.code === 'OUTPUT_INVALID') throw error;
      throw retryableStageError('RENDER_FAILED', 'Remotion render failed', error);
    }
    const outputArtifact = await makeFileArtifact(dataDir, 'output_mp4', output, 'video/mp4');
    return context.finalize(() => artifactStore.commitRender({
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      nowMs: context.nowMs(),
      outputArtifact,
    }));
  };
};
