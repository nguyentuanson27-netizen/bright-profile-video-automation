import {createHash} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';

import {AppError, ErrorCodes} from '../../domain/errors.mjs';
import {assertSafePublicUrl} from '../../security/url-policy.mjs';

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
]);
const MEDIA_MIME_TYPES = [...MIME_EXTENSIONS.keys()];
const DISCOVERY_MIME_TYPES = [...MEDIA_MIME_TYPES, 'text/html', 'application/xhtml+xml'];
const MEDIA_META_PRIORITY = [
  'og:video:secure_url',
  'og:video:url',
  'og:video',
  'twitter:player:stream',
  'og:image:secure_url',
  'og:image:url',
  'og:image',
  'twitter:image',
  'twitter:image:src',
];
const RETRYABLE_FETCH_CODES = new Set([
  ErrorCodes.FETCH_TIMEOUT,
  ErrorCodes.FETCH_NETWORK_ERROR,
  ErrorCodes.FETCH_HTTP_STATUS,
]);

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const toRelative = (dataDir, absolutePath) => relative(resolve(dataDir), resolve(absolutePath)).split(sep).join('/');
const normalizeMime = (value) => String(value ?? '').split(';', 1)[0].trim().toLowerCase();

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
  const sceneSourceIds = {};
  const ordered = [];
  const seen = new Set();
  for (const scene of revision.payload?.scenes ?? []) {
    const sourceId = (scene.sourceIds ?? []).find((id) => byId.has(id));
    if (!sourceId) {
      throw new AppError('MEDIA_SOURCE_REQUIRED', `Scene ${scene.id ?? 'unknown'} has no available factual source`, {status: 400});
    }
    sceneSourceIds[scene.id] = sourceId;
    if (!seen.has(sourceId)) {
      seen.add(sourceId);
      ordered.push(byId.get(sourceId));
    }
  }
  if (ordered.length === 0) throw new AppError('MEDIA_SOURCE_REQUIRED', 'Approved revision has no factual source references', {status: 400});
  return {ordered, sceneSourceIds};
};

const markRetryability = (error) => {
  if (error && RETRYABLE_FETCH_CODES.has(error.code)) error.retryable = true;
  return error;
};

const decodeHtmlAttribute = (value) => String(value ?? '')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#x2f;/gi, '/')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');

const parseAttributes = (tag) => {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
};

const selectMediaCandidateFromHtml = (html, pageUrl) => {
  const candidates = new Map();
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const key = String(attributes.get('property') ?? attributes.get('name') ?? '').trim().toLowerCase();
    const content = String(attributes.get('content') ?? '').trim();
    if (key && content && MEDIA_META_PRIORITY.includes(key) && !candidates.has(key)) candidates.set(key, content);
  }
  for (const key of MEDIA_META_PRIORITY) {
    const candidate = candidates.get(key);
    if (!candidate) continue;
    try {
      return assertSafePublicUrl(new URL(candidate, pageUrl)).href;
    } catch {
      continue;
    }
  }
  throw new AppError(
    'MEDIA_CANDIDATE_REQUIRED',
    'Approved factual source does not expose a supported public media candidate',
    {status: 400},
  );
};

const fetchSelectedMedia = async ({fetcher, source, discoveryPath, mediaPath, fetchOptions}) => {
  let discovery;
  try {
    discovery = await fetcher.fetchToFile(source.url, discoveryPath, {
      ...fetchOptions,
      allowedMimeTypes: DISCOVERY_MIME_TYPES,
    });
  } catch (error) {
    throw markRetryability(error);
  }
  const discoveryMime = normalizeMime(discovery.mimeType);
  const discoveryUrl = assertSafePublicUrl(discovery.url ?? source.url).href;
  if (MIME_EXTENSIONS.has(discoveryMime)) {
    return {
      selectedMediaUrl: discoveryUrl,
      resolvedMediaUrl: discoveryUrl,
      fetched: discovery,
      stagedPath: discoveryPath,
    };
  }
  if (!['text/html', 'application/xhtml+xml'].includes(discoveryMime)) {
    throw new AppError(ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE, 'Factual source cannot yield a supported media selection', {status: 415});
  }

  const html = await readFile(discoveryPath, 'utf8');
  const selectedMediaUrl = selectMediaCandidateFromHtml(html, discoveryUrl);
  await rm(discoveryPath, {force: true});
  let fetched;
  try {
    fetched = await fetcher.fetchToFile(selectedMediaUrl, mediaPath, {
      ...fetchOptions,
      allowedMimeTypes: MEDIA_MIME_TYPES,
    });
  } catch (error) {
    throw markRetryability(error);
  }
  const mediaMime = normalizeMime(fetched.mimeType);
  if (!MIME_EXTENSIONS.has(mediaMime)) {
    throw new AppError(ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE, 'Selected media response is not supported for rendering', {status: 415});
  }
  return {
    selectedMediaUrl,
    resolvedMediaUrl: assertSafePublicUrl(fetched.url ?? selectedMediaUrl).href,
    fetched,
    stagedPath: mediaPath,
  };
};

export const createMediaIngestService = ({fetcher, dataDir, fetchOptions, onProgress} = {}) => {
  if (!fetcher || typeof fetcher.fetchToFile !== 'function') throw new TypeError('safe fetcher is required');
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required');
  if (!fetchOptions || typeof fetchOptions !== 'object') throw new TypeError('fetchOptions are required');
  const root = resolve(dataDir);

  return Object.freeze({
    async ingest({project, revision, sources, claim}) {
      assertCurrentApproval(project, revision, claim);
      const {ordered, sceneSourceIds} = chosenSources(revision, sources);
      const projectKey = digest(project.id).slice(0, 24);
      const attemptKey = digest(`${claim.stageId}\0${claim.attemptId}`).slice(0, 24);
      const attemptDir = resolve(root, 'projects', projectKey, 'attempts', attemptKey, 'media');
      await rm(attemptDir, {recursive: true, force: true});
      await mkdir(attemptDir, {recursive: true});
      const media = [];
      const mediaArtifacts = [];
      const selectionBySourceId = new Map();

      try {
        for (let index = 0; index < ordered.length; index += 1) {
          const source = ordered[index];
          const prefix = `media-${String(index).padStart(3, '0')}`;
          const discoveryPath = resolve(attemptDir, `${prefix}.discovery`);
          const selectedPath = resolve(attemptDir, `${prefix}.download`);
          const selection = await fetchSelectedMedia({
            fetcher,
            source,
            discoveryPath,
            mediaPath: selectedPath,
            fetchOptions,
          });
          const mimeType = normalizeMime(selection.fetched.mimeType);
          const extension = MIME_EXTENSIONS.get(mimeType);
          if (!extension) {
            throw new AppError(ErrorCodes.FETCH_UNSUPPORTED_MEDIA_TYPE, 'Selected media response is not supported for rendering', {status: 415});
          }
          const finalPath = resolve(attemptDir, `${prefix}${extension}`);
          const bytes = await readFile(selection.stagedPath);
          await writeFile(finalPath, bytes, {flag: 'wx'});
          await rm(selection.stagedPath, {force: true});
          if (selection.stagedPath !== discoveryPath) await rm(discoveryPath, {force: true});
          const relativePath = toRelative(root, finalPath);
          const mediaSelectionId = `media-selection-${digest(`${revision.id}\0${source.id}\0${selection.selectedMediaUrl}`).slice(0, 24)}`;
          const record = {
            mediaSelectionId,
            sourceId: source.id,
            sourceUrl: assertSafePublicUrl(source.url).href,
            selectedMediaUrl: selection.selectedMediaUrl,
            resolvedMediaUrl: selection.resolvedMediaUrl,
            relativePath,
            mimeType,
            byteSize: bytes.length,
            sha256: sha256(bytes),
          };
          media.push(record);
          mediaArtifacts.push({kind: 'media_input', ...record});
          selectionBySourceId.set(source.id, mediaSelectionId);
          onProgress?.({completed: index + 1, total: ordered.length, sourceId: source.id, mediaSelectionId});
        }

        const scenes = {};
        for (const [sceneId, sourceId] of Object.entries(sceneSourceIds)) {
          const mediaSelectionId = selectionBySourceId.get(sourceId);
          if (!mediaSelectionId) throw new AppError('MEDIA_CANDIDATE_REQUIRED', `Scene ${sceneId} has no selected media`, {status: 400});
          scenes[sceneId] = mediaSelectionId;
        }
        const manifest = {
          version: 2,
          projectId: project.id,
          revisionId: revision.id,
          scenes,
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
