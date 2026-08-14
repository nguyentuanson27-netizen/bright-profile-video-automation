import {createHash} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';

import {AppError, ErrorCodes} from '../../domain/errors.mjs';

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);
const ALLOWED_MIME_TYPES = [...MIME_EXTENSIONS.keys()];
const RETRYABLE_FETCH_CODES = new Set([
  ErrorCodes.FETCH_TIMEOUT,
  ErrorCodes.FETCH_NETWORK_ERROR,
  ErrorCodes.FETCH_HTTP_STATUS,
]);

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toRelative = (dataDir, absolutePath) => relative(resolve(dataDir), resolve(absolutePath)).split(sep).join('/');

const assertCurrentApproval = (project, revision, claim) => {
  if (!project || !revision || !claim) throw new TypeError('project, revision and claim are required');
  if (
    project.status !== 'media_ingest'
    || project.currentRevisionId !== revision.id
    || project.approvedRevisionId !== revision.id
    || revision.projectId !== project.id
    || !revision.approvedAt
    || claim.revisionId !== revision.id
  ) {
    throw new AppError(ErrorCodes.INVALID_TRANSITION, 'Media ingest requires the same current approved revision');
  }
};

const chosenSources = (revision, sources) => {
  const byId = new Map((sources ?? []).filter((source) => source?.status === 'available').map((source) => [source.id, source]));
  const sceneMap = {};
  const ordered = [];
  const seen = new Set();
  for (const scene of revision.payload?.scenes ?? []) {
    const sourceId = (scene.sourceIds ?? []).find((id) => byId.has(id));
    if (!sourceId) {
      throw new AppError('MEDIA_SOURCE_REQUIRED', `Scene ${scene.id ?? 'unknown'} has no available media source`, {status: 400});
    }
    sceneMap[scene.id] = sourceId;
    if (!seen.has(sourceId)) {
      seen.add(sourceId);
      ordered.push(byId.get(sourceId));
    }
  }
  if (ordered.length === 0) throw new AppError('MEDIA_SOURCE_REQUIRED', 'Approved revision has no media source references', {status: 400});
  return {ordered, sceneMap};
};

const markRetryability = (error) => {
  if (error && RETRYABLE_FETCH_CODES.has(error.code)) error.retryable = true;
  return error;
};

export const createMediaIngestService = ({fetcher, dataDir, fetchOptions, onProgress} = {}) => {
  if (!fetcher || typeof fetcher.fetchToFile !== 'function') throw new TypeError('safe fetcher is required');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required');
  if (!fetchOptions || typeof fetchOptions !== 'object') throw new TypeError('fetchOptions are required');
  const root = resolve(dataDir);

  return Object.freeze({
    async ingest({project, revision, sources, claim}) {
      assertCurrentApproval(project, revision, claim);
      const {ordered, sceneMap} = chosenSources(revision, sources);
      const projectKey = digest(project.id).slice(0, 24);
      const attemptKey = digest(`${claim.stageId}\0${claim.attemptId}`).slice(0, 24);
      const attemptDir = resolve(root, 'projects', projectKey, 'attempts', attemptKey, 'media');
      await rm(attemptDir, {recursive: true, force: true});
      await mkdir(attemptDir, {recursive: true});
      const media = [];
      const mediaArtifacts = [];

      try {
        for (let index = 0; index < ordered.length; index += 1) {
          const source = ordered[index];
          const neutralPath = resolve(attemptDir, `media-${String(index).padStart(3, '0')}.download`);
          let fetched;
          try {
            fetched = await fetcher.fetchToFile(source.url, neutralPath, {
              ...fetchOptions,
              allowedMimeTypes: ALLOWED_MIME_TYPES,
            });
          } catch (error) {
            throw markRetryability(error);
          }
          const extension = MIME_EXTENSIONS.get(String(fetched.mimeType).toLowerCase());
          if (!extension) {
            throw new AppError(ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE, 'Response MIME type is not supported for rendering', {status: 415});
          }
          const finalPath = resolve(attemptDir, `media-${String(index).padStart(3, '0')}${extension}`);
          const bytes = await readFile(neutralPath);
          await writeFile(finalPath, bytes, {flag: 'wx'});
          await rm(neutralPath, {force: true});
          const relativePath = toRelative(root, finalPath);
          const record = {
            sourceId: source.id,
            relativePath,
            mimeType: fetched.mimeType,
            byteSize: bytes.length,
            sha256: sha256(bytes),
          };
          media.push(record);
          mediaArtifacts.push({kind: 'media_input', ...record});
          onProgress?.({completed: index + 1, total: ordered.length, sourceId: source.id});
        }

        const manifest = {
          version: 1,
          projectId: project.id,
          revisionId: revision.id,
          scenes: sceneMap,
          media,
        };
        const manifestBytes = Buffer.from(JSON.stringify(manifest));
        const manifestAbsolutePath = resolve(attemptDir, 'manifest.json');
        await writeFile(manifestAbsolutePath, manifestBytes, {flag: 'wx'});
        return {
          manifest,
          manifestAbsolutePath,
          mediaArtifacts,
          manifestArtifact: {
            kind: 'media_manifest',
            relativePath: toRelative(root, manifestAbsolutePath),
            mimeType: 'application/json',
            byteSize: manifestBytes.length,
            sha256: sha256(manifestBytes),
          },
        };
      } catch (error) {
        await rm(attemptDir, {recursive: true, force: true});
        throw error;
      }
    },
  });
};

export const createMediaIngestStageHandler = ({repos, artifactStore, service, nextMaxAttempts = 4} = {}) => {
  if (!repos?.projects || !repos?.revisions || !repos?.sources) throw new TypeError('repositories are required');
  if (!artifactStore || typeof artifactStore.commitMediaIngest !== 'function') throw new TypeError('artifact store is required');
  if (!service || typeof service.ingest !== 'function') throw new TypeError('media ingest service is required');
  return async (claim, context) => {
    const project = repos.projects.get(claim.projectId);
    const revision = claim.revisionId ? repos.revisions.get(claim.revisionId) : null;
    const sources = repos.sources.list(claim.projectId);
    const prepared = await service.ingest({project, revision, sources, claim});
    return context.finalize(() => artifactStore.commitMediaIngest({
      stageId: claim.stageId,
      claimToken: claim.claimToken,
      nowMs: context.nowMs(),
      mediaArtifacts: prepared.mediaArtifacts,
      manifestArtifact: prepared.manifestArtifact,
      nextMaxAttempts,
    }));
  };
};
